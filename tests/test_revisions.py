"""版本快照（map_revision）测试：每个 mutation 落快照、no-op 不落、restore 往返。

注意：seed_tree 直写 session 不走 methods——seed 树没有 v1 快照，
快照行数断言从 0 起算（存量图从下一个 mutation 起开始有快照）。
"""
import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from src.models import Map, MapRevision, Node
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
    revs = await _revisions(session_factory, map_id)
    assert revs, "应有快照"
    return max(revs, key=lambda r: r.version).snapshot


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
    snap = r.snapshot
    assert snap["title"] == "快照图"
    assert snap["nodes"] == [
        {
            "display_id": 1, "parent": None, "content": "快照图", "position": 0,
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
        "display_id": 4, "parent": 1, "content": "new", "position": 1,
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


# ── list / get ─────────────────────────────────────────────────────────


async def test_list_revisions_desc_order(session_factory, seeded_map):
    await mm.add_node(100, 1, "a")
    await mm.update_node(100, 2, content="b")
    revs = await mm.list_revisions(100)
    assert [r.version for r in revs] == [3, 2]  # 最新在前，seed 无 v1
    assert revs[0].action == "node_updated"
    assert revs[0].detail is not None


async def test_get_revision_missing_raises(session_factory, seeded_map):
    await mm.add_node(100, 1, "a")
    rev = await mm.get_revision(100, 2)
    assert rev.snapshot["nodes"][3]["content"] == "a"
    with pytest.raises(ValueError, match="v999"):
        await mm.get_revision(100, 999)
    with pytest.raises(ValueError, match="not found"):
        await mm.get_revision(999, 1)


# ── restore 往返 ───────────────────────────────────────────────────────


async def test_restore_roundtrip_tree_equivalent(session_factory, seeded_map):
    await mm.add_node(100, 1, "v2 节点")  # v2
    await mm.update_node(100, 2, content="v3 改动")  # v3
    v2_snap = (await mm.get_revision(100, 2)).snapshot

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
    v3_snap = (await mm.get_revision(100, 3)).snapshot

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
    await mm.add_node(100, 1, "x")  # v2
    # 手工把 v2 快照改成双根
    async with session_factory() as s:
        rev = (
            await s.exec(
                select(MapRevision).where(MapRevision.map_id == 100, MapRevision.version == 2)
            )
        ).first()
        rev.snapshot = {
            "title": "T",
            "nodes": [
                {"display_id": 1, "parent": None, "content": "a", "position": 0, "collapsed": False, "updated_by": "x", "updated_at": "t"},
                {"display_id": 2, "parent": None, "content": "b", "position": 0, "collapsed": False, "updated_by": "x", "updated_at": "t"},
            ],
        }
        s.add(rev)
        await s.commit()

    with pytest.raises(ValueError, match="根节点数"):
        await mm.restore_revision(100, 2)
    # 事务回滚：树与 version 未动
    async with session_factory() as s:
        m2 = await s.get(Map, 100)
        nodes = (await s.exec(select(Node).where(Node.map_id == 100))).all()
    assert m2.version == 2
    assert len(nodes) == 4


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
