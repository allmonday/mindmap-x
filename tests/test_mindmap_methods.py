"""mindmap 域业务方法测试：每个方法覆盖正常 + 边界/异常场景。"""
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
        assert roots[0].updated_by == "agent"

async def test_list_maps_includes_created(session_factory, seeded_map):
    await mm.create_map("第二张")
    maps = await mm.list_maps()
    assert [m.title for m in maps] == ["T", "第二张"]

# ── get_tree ──────────────────────────────────────────────────────────

async def test_get_tree_renders_outline_with_ids(session_factory, seeded_map):
    text = await mm.get_tree(100)
    assert text == "- [id:200] root\n  - [id:201] a\n    - [id:202] a1"

async def test_get_tree_missing_map(session_factory, seeded_map):
    with pytest.raises(ValueError, match="not found"):
        await mm.get_tree(999)

# ── add_node ──────────────────────────────────────────────────────────

async def test_add_node_appends_to_end(session_factory, seeded_map):
    n = await mm.add_node(100, 200, "second child", actor="human")
    assert n.position == 1  # root 下已有 position=0 的 a
    assert n.updated_by == "human"
    async with session_factory() as s:
        m = await s.get(Map, 100)
        assert m.version == 2  # version 递增

async def test_add_node_parent_in_other_map(session_factory, seeded_map):
    other = await mm.create_map("other")
    with pytest.raises(ValueError, match="不属于"):
        await mm.add_node(other.id, 200, "x")  # parent 200 属于 map 100

# ── update_node ───────────────────────────────────────────────────────

async def test_update_node_partial(session_factory, seeded_map):
    n = await mm.update_node(201, content="renamed", actor="agent")
    assert n.content == "renamed"
    assert n.collapsed is False  # 未指定的字段不动
    assert n.updated_by == "agent"

async def test_update_node_missing(session_factory, seeded_map):
    with pytest.raises(ValueError, match="not found"):
        await mm.update_node(999, content="x")

# ── move_node ─────────────────────────────────────────────────────────

async def test_move_node_reparents(session_factory, seeded_map):
    n = await mm.move_node(202, 200)  # a1 从 a 下移到 root 下
    assert n.parent_id == 200
    assert n.position == 1  # root 下已有 a(0)，追加为 1

async def test_move_node_into_own_subtree_rejected(session_factory, seeded_map):
    with pytest.raises(ValueError, match="子树"):
        await mm.move_node(201, 202)  # a 移到自己的子节点 a1 下 → 成环

async def test_move_root_rejected(session_factory, seeded_map):
    with pytest.raises(ValueError, match="根节点不可移动"):
        await mm.move_node(200, 201)

# ── delete_node ───────────────────────────────────────────────────────

async def test_delete_node_removes_subtree(session_factory, seeded_map):
    assert await mm.delete_node(201) is True  # 删 a，子节点 a1 一并删除
    from sqlmodel import select

    async with session_factory() as s:
        left = (await s.exec(select(Node.id).where(Node.map_id == 100))).all()
        assert set(left) == {200}

async def test_delete_root_rejected(session_factory, seeded_map):
    with pytest.raises(ValueError, match="根节点不可删除"):
        await mm.delete_node(200)

# ── apply_outline ─────────────────────────────────────────────────────

async def test_apply_outline_merge(session_factory, seeded_map):
    m = await mm.apply_outline(
        100,
        "- [id:200] root\n  - [id:201] a renamed\n    - brand new\n      - deeper",
        mode="merge",
        actor="agent",
    )
    assert m.version == 2
    text = await mm.get_tree(100)
    # 202 (a1) 未在 outline 中出现 → 保留；新节点按缩进挂载
    assert text == (
        "- [id:200] root\n"
        "  - [id:201] a renamed\n"
        "    - [id:202] a1\n"
        "    - [id:203] brand new\n"
        "      - [id:204] deeper"
    )

async def test_apply_outline_replace(session_factory, seeded_map):
    await mm.apply_outline(
        100,
        "- root v2\n  - fresh\n  - nodes",
        mode="replace",
        actor="human",
    )
    text = await mm.get_tree(100)
    lines = text.splitlines()
    assert lines[0].startswith("- [id:200] root v2")  # 根 id 保留
    assert "fresh" in text and "nodes" in text
    assert "a1" not in text and "] a" not in text  # 旧子树全删

async def test_apply_outline_bad_indent(session_factory, seeded_map):
    with pytest.raises(ValueError, match="跳级"):
        await mm.apply_outline(100, "- root\n      - jumped two levels")

async def test_apply_outline_foreign_id_rejected(session_factory, seeded_map):
    with pytest.raises(ValueError, match="不能跨图锚定"):
        await mm.apply_outline(100, "- [id:200] root\n  - [id:300] fake")

# ── events hub ────────────────────────────────────────────────────────

async def test_publish_subscribe_roundtrip(session_factory, seeded_map):
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
