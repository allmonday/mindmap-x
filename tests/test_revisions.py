"""版本历史（map_revision 元数据 + node_revision 节点行 MVCC）测试：
每个 mutation 落版本、no-op 不落、物化等价、restore 往返。

注意：seed_tree 直写 session 不走 methods——seed 树没有 v1，
版本行数断言从 0 起算（存量图从下一个 mutation 起开始有版本）。
"""
import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from src.models import Map, MapRevision, Node, NodeRevision
from src.service.mindmap import methods as mm
from src.service.mindmap.events import drain_pending, subscribe, unsubscribe


async def _revisions(session_factory, map_id: int = 100) -> list[MapRevision]:
    async with session_factory() as s:
        return list(
            (
                await s.exec(select(MapRevision).where(MapRevision.map_id == map_id))
            ).all()
        )


async def _latest_snapshot(session_factory, map_id: int = 100) -> dict:
    """最新版本的物化整树（MVCC：snapshot 列已废，走 get_revision 物化）。"""
    revs = await _revisions(session_factory, map_id)
    assert revs, "应有版本"
    _, snap = await mm.get_revision(map_id, max(r.version for r in revs))
    return snap


def _node_rows(rows: list[NodeRevision]) -> dict[int, list[NodeRevision]]:
    """节点行按 display_id 分组（验证 MVCC 行形态用）。"""
    by: dict[int, list[NodeRevision]] = {}
    for r in rows:
        by.setdefault(r.display_id, []).append(r)
    return by


def _tree_shape(snap: dict) -> dict[int, tuple[int | None, str, int, bool]]:
    """快照 → {display_id: (parent, content, position, collapsed)}（diff 忽略 updated_*）。"""
    return {
        n["display_id"]: (n["parent"], n["content"], n["position"], n["collapsed"])
        for n in snap["nodes"]
    }


# ── 每个 mutation 落快照 ──────────────────────────────────────────────


async def test_create_map_writes_v1_snapshot(session_factory):
    m = await mm.create_map("快照图", actor="agent")
    revs = await _revisions(session_factory, m.id)
    assert len(revs) == 1
    r = revs[0]
    assert (r.version, r.action, r.actor) == (1, "map_created", "agent")
    assert r.title == "快照图"  # title 随版本元数据行走
    _, snap = await mm.get_revision(m.id, 1)
    assert snap["title"] == "快照图"
    assert snap["nodes"] == [
        {
            "display_id": 1, "parent": None, "content": "快照图", "note": None, "position": 0,
            "collapsed": False, "updated_by": "agent", "updated_at": snap["nodes"][0]["updated_at"],
        }
    ]
    from datetime import datetime

    datetime.fromisoformat(snap["nodes"][0]["updated_at"])  # ISO 可解析


async def test_add_node_writes_snapshot(session_factory, seeded_map):
    await mm.add_node(100, 1, "new", actor="human")
    snap = await _latest_snapshot(session_factory)
    revs = await _revisions(session_factory)
    assert [r.version for r in revs] == [2]  # seed 直写无 v1
    assert len(snap["nodes"]) == 4
    assert snap["nodes"][3] | {"updated_at": ""} == {
        "display_id": 4, "parent": 1, "content": "new", "note": None, "position": 1,
        "collapsed": False, "updated_by": "human", "updated_at": "",
    }


async def test_update_node_snapshot_reflects_content(session_factory, seeded_map):
    await mm.update_node(100, 2, content="renamed", actor="agent")
    snap = await _latest_snapshot(session_factory)
    by = {n["display_id"]: n for n in snap["nodes"]}
    assert by[2]["content"] == "renamed"
    assert by[1]["content"] == "root"  # 未涉及节点不变


async def test_move_node_snapshot_reflects_parent(session_factory, seeded_map):
    await mm.move_node(100, 3, 1)  # a1 → root 下
    snap = await _latest_snapshot(session_factory)
    by = {n["display_id"]: n for n in snap["nodes"]}
    assert by[3]["parent"] == 1


async def test_delete_node_snapshot_excludes_subtree(session_factory, seeded_map):
    await mm.delete_node(100, 2)  # 删 a（含 a1）
    snap = await _latest_snapshot(session_factory)
    assert [n["display_id"] for n in snap["nodes"]] == [1]


async def test_apply_outline_replace_snapshot_is_final_state(session_factory, seeded_map):
    """覆盖 apply_outline 中途 flush 与快照构建（autoflush）的相互作用。"""
    await mm.apply_outline(
        100, "- 根v2\n  - x\n    - y\n  - z", mode="replace", actor="agent"
    )
    snap = await _latest_snapshot(session_factory)
    assert _tree_shape(snap) == {
        1: (None, "根v2", 0, False),
        2: (1, "x", 0, False),
        3: (2, "y", 0, False),
        4: (1, "z", 1, False),
    }


async def test_fold_ops_exit_version_history(session_factory, seeded_map):
    """收放是视图态：不递增 version、不落快照（不灌版本历史），但仍 WS 广播。"""
    from src.service.mindmap.events import subscribe, unsubscribe

    q = subscribe(100)
    try:
        await mm.update_node(100, 1, collapsed=True, actor="human")
        await mm.expand_all(100, actor="human")
        await mm.set_fold_level(100, 2)
        m = await mm.get_map(100)
        assert m.version == 1  # 三次收放，version 纹丝不动
        assert await _revisions(session_factory) == []  # 零快照
        events = [q.get_nowait() for _ in range(3)]  # 每次都广播（多端直接 patch 视图态）
        assert all(
            e["action"] in ("node_collapsed", "expanded_all", "folded_to_level")
            for e in events
        )
    finally:
        unsubscribe(100, q)


async def test_fold_only_update_keeps_updated_markers(session_factory, seeded_map):
    """仅折叠不刷新修改人/时间戳（内容高亮不误亮），传 content 才刷新。"""
    node = await mm.update_node(100, 2, content="改内容", actor="human")
    before = node.updated_at
    node = await mm.update_node(100, 2, collapsed=True, actor="agent")
    assert node.collapsed is True
    assert node.updated_by == "human"  # 未被 agent 的折叠覆写
    assert node.updated_at == before


async def test_noop_update_node_fold_unchanged(session_factory, seeded_map):
    """collapsed 与当前一致且未传 content：空操作，version/广播都不动。"""
    m0 = await mm.get_map(100)
    node = await mm.update_node(100, 2, collapsed=False)  # 默认就是 False
    assert node.collapsed is False
    assert (await mm.get_map(100)).version == m0.version
    assert await _revisions(session_factory) == []


# ── no-op 不落 ─────────────────────────────────────────────────────────


async def test_noop_expand_all_no_snapshot(session_factory, seeded_map):
    m = await mm.expand_all(100)  # 全展开树
    assert m.version == 1
    assert await _revisions(session_factory) == []


async def test_noop_set_fold_level_no_snapshot(session_factory, seeded_map):
    m = await mm.set_fold_level(100, 9)  # level ≥ 树深 = 全展开，无变化
    assert m.version == 1
    assert await _revisions(session_factory) == []


# ── undo log：逐版本 golden 物化（守护行语义翻转的正确性） ────────────


async def test_undo_materializes_every_version(session_factory, seeded_map):
    """操作序列的每个版本，undo 物化必须等于该时刻的真实树（golden 断言）。

    覆盖：单点改 / note 改 / move / 加 / 删子树（墓碑+复活值）/ replace
    同号重用 / restore。这是 scripts/undo_prototype.py 验证方式的测试化。
    """
    # 序列操作并逐步记录 golden（did -> (content, parent)）
    async def tree_at() -> dict[int, tuple[str | None, int | None]]:
        _, snap = await mm.get_revision(100, (await _latest_version(session_factory)))
        return {n["display_id"]: (n["content"], n["parent"]) for n in snap["nodes"]}

    golden: dict[int, dict] = {}
    async def step(fn) -> None:
        await fn()
        golden[(await _latest_version(session_factory))] = await tree_at()

    async def _latest_version(sf) -> int:
        revs = await _revisions(sf)
        return max(r.version for r in revs)

    await step(lambda: mm.update_node(100, 2, content="改1", note="备注"))     # v2
    await step(lambda: mm.update_node(100, 2, note="备注2"))                   # v3
    await step(lambda: mm.move_node(100, 3, 1))                                # v4
    await step(lambda: mm.add_node(100, 1, "新节点"))                          # v5
    await step(lambda: mm.delete_node(100, 2))                                 # v6：删 #2
    # v7：replace 同号重用（锚定带回 + 全树重排）
    await step(lambda: mm.apply_outline(
        100, "- [id:1] root\n  - 重排子\n    - [id:3] a1改", mode="replace", actor="human"))
    await step(lambda: mm.restore_revision(100, 5, actor="human"))             # v8：回滚到 v5

    for version, expect in sorted(golden.items()):
        _, snap = await mm.get_revision(100, version)
        got = {n["display_id"]: (n["content"], n["parent"]) for n in snap["nodes"]}
        assert got == expect, f"v{version} 的 undo 物化与操作时刻真实树不一致"


# ── list / get ─────────────────────────────────────────────────────────


async def test_get_revision_changes_kinds(session_factory, seeded_map):
    """版本间变更集：各 kind 判定（deleted→removed / NULL→added / content > note > moved）。

    before 行语义下「首版本全 added」消亡：seed 直写的图首个版本也知道
    before（快照在 mutation 里显式构造），v2 就是 touched 节点的 changed。
    """
    await mm.update_node(100, 2, content="基线", note="备注")  # v2
    ch = await mm.get_revision_changes(100, 2)
    assert [(r["display_id"], r["kind"], r["old_content"]) for r in ch["rows"]] == [
        (2, "changed", "a"),
    ]
    assert ch["title_change"] is False

    await mm.update_node(100, 2, content="改名")  # v3：changed（old=v2 值）
    ch = await mm.get_revision_changes(100, 3)
    assert [(r["display_id"], r["kind"], r["old_content"]) for r in ch["rows"]] == [
        (2, "changed", "基线"),
    ]

    await mm.update_node(100, 2, note="备注改")  # v4：note（content 未动）
    ch = await mm.get_revision_changes(100, 4)
    assert [(r["display_id"], r["kind"]) for r in ch["rows"]] == [(2, "note")]

    await mm.move_node(100, 3, 1)  # v5：moved（#3 从 #2 下移到 #1 下）
    ch = await mm.get_revision_changes(100, 5)
    assert [(r["display_id"], r["kind"]) for r in ch["rows"]] == [(3, "moved")]

    await mm.add_node(100, 1, "新节点")  # v6：added
    await mm.delete_node(100, 3)  # v7：removed（content 为被删内容）
    ch = await mm.get_revision_changes(100, 6)
    assert [(r["display_id"], r["kind"]) for r in ch["rows"]] == [(4, "added")]
    ch = await mm.get_revision_changes(100, 7)
    assert [(r["display_id"], r["kind"], r["content"]) for r in ch["rows"]] == [
        (3, "removed", "a1"),
    ]


async def test_get_revision_changes_fold_not_versioned(session_factory, seeded_map):
    # 折叠是视图态不落版本 → 不出现在任何版本的变更集里
    await mm.update_node(100, 2, content="基线")  # v2
    await mm.set_node_collapsed(100, 2, True, actor="human")  # 无新版本
    ch = await mm.get_revision_changes(100, 2)
    assert all(r["kind"] != "folded" for r in ch["rows"])
    assert len(await _revisions(session_factory)) == 1  # 仍只有 v2


async def test_get_revision_changes_title_and_errors(session_factory, seeded_map):
    # title_change：restore 恢复标题场景；错误路径照 get_revision
    async with session_factory() as s:
        m = await s.get(Map, 100)
        m.title = "改名后"
        s.add(m)
        await s.commit()
    await mm.update_node(100, 2, content="v2 基线")  # v2（title 已改）
    ch = await mm.get_revision_changes(100, 2)
    assert ch["title_change"] is False  # v2 是首版本（无 prev 可比）

    with pytest.raises(ValueError, match="v999"):
        await mm.get_revision_changes(100, 999)
    with pytest.raises(ValueError, match="not found"):
        await mm.get_revision_changes(999, 1)


async def test_list_revisions_desc_order(session_factory, seeded_map):
    await mm.add_node(100, 1, "a")
    await mm.update_node(100, 2, content="b")
    revs = await mm.list_revisions(100)
    assert [r.version for r in revs] == [3, 2]  # 最新在前，seed 无 v1
    assert revs[0].action == "node_updated"
    assert revs[0].detail is not None


async def test_get_revision_missing_raises(session_factory, seeded_map):
    await mm.add_node(100, 1, "a")
    _, snap = await mm.get_revision(100, 2)
    assert snap["nodes"][3]["content"] == "a"
    with pytest.raises(ValueError, match="v999"):
        await mm.get_revision(100, 999)
    with pytest.raises(ValueError, match="not found"):
        await mm.get_revision(999, 1)


# ── restore 往返 ───────────────────────────────────────────────────────


async def test_note_in_snapshot_and_restore(session_factory, seeded_map):
    # note 随节点行走；restore 重建后按 display_id 恢复
    await mm.update_node(100, 2, note="v2 备注")  # v2
    await mm.update_node(100, 2, note="v3 备注")  # v3
    _, snap = await mm.get_revision(100, 2)
    by = {nd["display_id"]: nd for nd in snap["nodes"]}
    assert by[2]["note"] == "v2 备注"

    await mm.restore_revision(100, 2, actor="human")
    n = await mm.get_node(100, 2)
    assert n.note == "v2 备注"  # 回滚到 v2 的 note，不是 v3


async def test_restore_null_note_row(session_factory, seeded_map):
    # before dict 的 note 为 None（字段缺省/旧数据）：物化输出 None，restore 不炸
    await mm.update_node(100, 2, content="先产生一个版本")  # seed 直写无版本
    async with session_factory() as s:
        row = (
            await s.exec(
                select(NodeRevision).where(
                    NodeRevision.map_id == 100, NodeRevision.display_id == 2
                )
            )
        ).first()
        row.before = {**row.before, "note": None}
        s.add(row)
        await s.commit()
    await mm.restore_revision(100, row.version, actor="human")
    assert (await mm.get_node(100, 2)).note is None

async def test_restore_roundtrip_tree_equivalent(session_factory, seeded_map):
    await mm.add_node(100, 1, "v2 节点")  # v2
    await mm.update_node(100, 2, content="v3 改动")  # v3
    _, v2_snap = await mm.get_revision(100, 2)

    m = await mm.restore_revision(100, 2, actor="human")
    assert m.version == 4

    async with session_factory() as s:
        nodes = (await s.exec(select(Node).where(Node.map_id == 100))).all()
    shape = {
        n.display_id: (n.parent_id, n.content, n.position, n.collapsed) for n in nodes
    }
    # 全局 id 允许不同；按 display_id 语义比较树等价
    gid_to_display = {n.id: n.display_id for n in nodes}
    shape = {
        n.display_id: (
            gid_to_display[n.parent_id] if n.parent_id else None,
            n.content, n.position, n.collapsed,
        )
        for n in nodes
    }
    assert shape == _tree_shape(v2_snap)


async def test_restore_keeps_history_and_can_forward_roll(session_factory, seeded_map):
    await mm.add_node(100, 1, "v2")  # v2
    await mm.update_node(100, 2, content="v3")  # v3
    _, v3_snap = await mm.get_revision(100, 3)

    await mm.restore_revision(100, 2)  # v4（回滚）
    m = await mm.restore_revision(100, 3)  # v5（前滚回 v3）
    assert m.version == 5
    assert len(await _revisions(session_factory)) == 4  # v2/v3/v4/v4 全保留

    async with session_factory() as s:
        nodes = (await s.exec(select(Node).where(Node.map_id == 100))).all()
    assert {n.display_id: n.content for n in nodes} == {
        n["display_id"]: n["content"] for n in v3_snap["nodes"]
    }


async def test_restore_v1_shrinks_to_root(session_factory):
    m = await mm.create_map("回滚图")
    map_id = m.id
    await mm.add_node(map_id, 1, "child")
    await mm.add_node(map_id, 1, "child2")
    m = await mm.restore_revision(map_id, 1)
    assert m.version == 4
    snap = await _latest_snapshot(session_factory, map_id)
    assert [n["display_id"] for n in snap["nodes"]] == [1]
    assert snap["title"] == "回滚图"


async def test_restore_notifies_agent_when_human(session_factory, seeded_map):
    await mm.add_node(100, 1, "x")  # v2
    await mm.restore_revision(100, 2, actor="human")  # v3
    pending = drain_pending(100)
    assert any(a == "human" and "回滚到 v2" in d for a, d in pending)


async def test_restore_corrupt_snapshot_rejected(session_factory, seeded_map):
    await mm.update_node(100, 2, content="v2")  # v2：#2 的 before 行
    await mm.update_node(100, 3, content="v3")  # v3：#3 的 before 行
    # 篡改 v3 行的 before.parent=None → 物化 v2（undo 撤 >2 即 v3 行）时
    # #3 变成根 → 双根畸形。注意 undo 只撤 >target 的行：篡改 v3 行只影响
    # 物化 v2 及更早，物化 v3 本身不受波及（node 表锚）
    async with session_factory() as s:
        row = (
            await s.exec(
                select(NodeRevision).where(
                    NodeRevision.map_id == 100, NodeRevision.version == 3, NodeRevision.display_id == 3
                )
            )
        ).first()
        row.before = {**row.before, "parent": None}
        s.add(row)
        await s.commit()

    with pytest.raises(ValueError, match="根节点数"):
        await mm.restore_revision(100, 2)
    # 事务回滚：树与 version 未动
    async with session_factory() as s:
        m2 = await s.get(Map, 100)
        nodes = (await s.exec(select(Node).where(Node.map_id == 100))).all()
    assert m2.version == 3
    assert len(nodes) == 3


# ── delete_map 清快照 ──────────────────────────────────────────────────


async def test_delete_map_keeps_revisions(session_factory):
    """软删除：快照随图保留（对外经 _get_map 已不可达，恢复时历史完整）。"""
    m = await mm.create_map("待删")
    await mm.add_node(m.id, 1, "x")
    assert len(await _revisions(session_factory, m.id)) == 2
    await mm.delete_map(m.id)
    assert len(await _revisions(session_factory, m.id)) == 2  # 保留，不物理删除


# ── 快照与广播的事件一致性 ─────────────────────────────────────────────


async def test_snapshot_version_matches_broadcast(session_factory, seeded_map):
    q = subscribe(100)
    try:
        await mm.add_node(100, 1, "evt")
        evt = q.get_nowait()
        snap = await _latest_snapshot(session_factory)
        assert evt["version"] == 2
        assert max(r.version for r in await _revisions(session_factory)) == evt["version"]
        assert snap["nodes"][3]["content"] == "evt"
    finally:
        unsubscribe(100, q)
