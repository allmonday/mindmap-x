"""mindmap 域业务方法测试：每个方法覆盖正常 + 边界/异常场景。

ID 语义：对外全部用 map 内 display_id（seed 树：root=#1, a=#2, a1=#3，map_id=100）。
"""
import pytest

from src.models import Map, Node
from src.service.mindmap import methods as mm
from src.service.mindmap.events import publish_change, subscribe, unsubscribe

# ── create_map / list_maps ────────────────────────────────────────────


async def test_create_map_makes_root(session_factory, seeded_map):
    m = await mm.create_map("新图", actor="agent")
    assert m.id is not None and m.version == 1
    from sqlmodel import select

    async with session_factory() as s:
        roots = (
            await s.exec(select(Node).where(Node.map_id == m.id, Node.parent_id == None))  # noqa: E712
        ).all()
        assert len(roots) == 1
        assert roots[0].content == "新图"
        assert roots[0].display_id == 1  # 根节点从 1 号起
        assert roots[0].updated_by == "agent"


async def test_list_maps_includes_created(session_factory, seeded_map):
    await mm.create_map("第二张")
    maps = await mm.list_maps()
    assert [m.title for m in maps] == ["T", "第二张"]


# ── get_tree ──────────────────────────────────────────────────────────


async def test_get_tree_renders_outline_with_display_ids(session_factory, seeded_map):
    text = await mm.get_tree(100)
    assert text == "- [id:1] root\n  - [id:2] a\n    - [id:3] a1"


async def test_get_tree_missing_map(session_factory):
    with pytest.raises(ValueError, match="not found"):
        await mm.get_tree(999)


# ── add_node ──────────────────────────────────────────────────────────


async def test_add_node_appends_to_end_and_numbers_per_map(session_factory, seeded_map):
    n = await mm.add_node(100, 1, "second child", actor="human")  # parent = root(#1)
    assert n.position == 1  # root 下已有 position=0 的 a
    assert n.display_id == 4  # map 内下一个号（已有 1..3）
    assert n.updated_by == "human"
    async with session_factory() as s:
        m = await s.get(Map, 100)
        assert m.version == 2  # version 递增


async def test_add_node_missing_parent(session_factory, seeded_map):
    with pytest.raises(ValueError, match="不存在节点 #999"):
        await mm.add_node(100, 999, "x")


# ── update_node ───────────────────────────────────────────────────────


async def test_update_node_partial(session_factory, seeded_map):
    n = await mm.update_node(100, 2, content="renamed", actor="agent")
    assert n.content == "renamed"
    assert n.collapsed is False  # 未指定的字段不动
    assert n.updated_by == "agent"


async def test_update_node_missing(session_factory, seeded_map):
    with pytest.raises(ValueError, match="不存在节点 #999"):
        await mm.update_node(100, 999, content="x")


async def test_update_node_wrong_map(session_factory, seeded_map):
    # display_id 只在 map 内唯一：map 101 的 #2 不是 map 100 的 a
    async with session_factory() as s:
        s.add(Map(id=101, title="other", version=1))
        s.add(Node(id=300, display_id=2, map_id=101, parent_id=None, content="别图根", position=0))
        await s.commit()
    n = await mm.update_node(101, 2, content="别图的 #2")
    assert n.content == "别图的 #2"


# ── move_node ─────────────────────────────────────────────────────────


async def test_move_node_reparents(session_factory, seeded_map):
    n = await mm.move_node(100, 3, 1)  # a1(#3) 移到 root(#1) 下
    assert n.parent_id == 200  # 内部全局 FK 指向 root
    assert n.position == 1  # root 下已有 a(0)，追加为 1


async def test_move_node_into_own_subtree_rejected(session_factory, seeded_map):
    with pytest.raises(ValueError, match="子树"):
        await mm.move_node(100, 2, 3)  # a 移到自己的子节点 a1 下 → 成环


async def test_move_root_rejected(session_factory, seeded_map):
    with pytest.raises(ValueError, match="根节点不可移动"):
        await mm.move_node(100, 1, 2)


# ── delete_node ───────────────────────────────────────────────────────


async def test_delete_node_removes_subtree(session_factory, seeded_map):
    assert await mm.delete_node(100, 2) is True  # 删 a，子节点 a1 一并删除
    from sqlmodel import select

    async with session_factory() as s:
        left = (await s.exec(select(Node.id).where(Node.map_id == 100))).all()
        assert set(left) == {200}


async def test_delete_root_rejected(session_factory, seeded_map):
    with pytest.raises(ValueError, match="根节点不可删除"):
        await mm.delete_node(100, 1)


# ── expand_all ────────────────────────────────────────────────────────


async def test_expand_all(session_factory, seeded_map):
    # 先折叠 #1 root 和 #2 a
    await mm.update_node(100, 1, collapsed=True, actor="human")
    await mm.update_node(100, 2, collapsed=True, actor="human")
    m = await mm.expand_all(100, actor="human")
    from sqlmodel import select

    async with session_factory() as s:
        nodes = (await s.exec(select(Node).where(Node.map_id == 100))).all()
        assert all(n.collapsed is False for n in nodes)  # 全部展开
        # 视图操作不改变修改标记与时间戳
        assert all(n.updated_by == "human" for n in nodes if n.display_id == 1)
        assert m.version == 4  # 两次折叠 + 一次 expand


# ── apply_outline ─────────────────────────────────────────────────────


async def test_apply_outline_merge(session_factory, seeded_map):
    m = await mm.apply_outline(
        100,
        "- [id:1] root\n  - [id:2] a renamed\n    - brand new\n      - deeper",
        mode="merge",
        actor="agent",
    )
    assert m.version == 2
    text = await mm.get_tree(100)
    # #3 (a1) 未在 outline 中出现 → 保留；新节点分配 map 内下一个号 4、5
    assert text == (
        "- [id:1] root\n"
        "  - [id:2] a renamed\n"
        "    - [id:3] a1\n"
        "    - [id:4] brand new\n"
        "      - [id:5] deeper"
    )


async def test_apply_outline_replace_renumbers(session_factory, seeded_map):
    await mm.apply_outline(
        100,
        "- root v2\n  - fresh\n  - nodes",
        mode="replace",
        actor="human",
    )
    text = await mm.get_tree(100)
    lines = text.splitlines()
    # replace 后按 outline 顺序重排 1..n，根保持 #1
    assert lines[0] == "- [id:1] root v2"
    assert lines[1] == "  - [id:2] fresh"
    assert lines[2] == "  - [id:3] nodes"
    assert "a1" not in text  # 旧子树全删


async def test_apply_outline_bad_indent(session_factory, seeded_map):
    with pytest.raises(ValueError, match="跳级"):
        await mm.apply_outline(100, "- root\n      - jumped two levels")


async def test_apply_outline_foreign_id_rejected(session_factory, seeded_map):
    with pytest.raises(ValueError, match="不是 map 100 的节点编号"):
        await mm.apply_outline(100, "- [id:1] root\n  - [id:300] fake")


async def test_apply_outline_double_root_rejected(session_factory, seeded_map):
    with pytest.raises(ValueError, match="只能有一个根节点"):
        await mm.apply_outline(100, "- [id:1] root\n- [id:2] 第二个根")


# ── events hub ────────────────────────────────────────────────────────


async def test_publish_subscribe_roundtrip(session_factory):
    q = subscribe(100)
    try:
        publish_change(100, version=7, action="node_added", actor="agent")
        evt = q.get_nowait()
        assert evt == {
            "type": "changed",
            "map_id": 100,
            "version": 7,
            "action": "node_added",
            "actor": "agent",
        }
    finally:
        unsubscribe(100, q)
    publish_change(100, version=8, action="node_added", actor="agent")
    assert q.empty()  # 退订后不再收到
