"""mindmap 域业务方法测试：每个方法覆盖正常 + 边界/异常场景。

ID 语义：对外全部用 map 内 display_id（seed 树：root=#1, a=#2, a1=#3，map_id=100）。
"""
import pytest

from src.models import Map, Node
from src.service.mindmap import methods as mm
from src.service.mindmap.events import drain_pending, publish_change, record_pending, subscribe, unsubscribe

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


async def test_set_node_collapsed_is_lightweight_and_correlates_event(
    session_factory, seeded_map
):
    from sqlmodel import select

    q = subscribe(100)
    try:
        changed = await mm.set_node_collapsed(
            100,
            2,
            True,
            actor="human",
            client_request_id="fold-123",
        )
        assert changed is True
        event = q.get_nowait()
        assert event["action"] == "node_collapsed"
        assert event["client_request_id"] == "fold-123"
        assert event["payload"] == {"node_id": 2, "collapsed": True}

        async with session_factory() as session:
            node = (
                await session.exec(
                    select(Node).where(Node.map_id == 100, Node.display_id == 2)
                )
            ).one()
            assert node.collapsed is True

        assert await mm.set_node_collapsed(100, 2, True) is False
        assert q.empty()
    finally:
        unsubscribe(100, q)


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


# ── delete_map ────────────────────────────────────────────────────────


async def test_delete_map_hides_map(session_factory, seeded_map):
    """软删除：广播照发、行保留（deleted_at 标记）、对外 not found。"""
    from sqlmodel import select

    await mm.add_node(100, 1, "x", actor="agent")
    q = subscribe(100)
    try:
        assert await mm.delete_map(100, actor="human") is True
        evt = q.get_nowait()
        assert evt["action"] == "map_deleted"
        async with session_factory() as s:
            m = await s.get(Map, 100)
            assert m is not None and m.deleted_at is not None  # 行保留（软删）
            assert len((await s.exec(select(Node).where(Node.map_id == 100))).all()) > 0
        with pytest.raises(ValueError, match="not found"):
            await mm.get_map(100)
    finally:
        unsubscribe(100, q)


async def test_delete_map_missing(session_factory):
    with pytest.raises(ValueError, match="not found"):
        await mm.delete_map(999)


async def test_delete_map_clears_pending(session_factory, seeded_map):
    record_pending(100, "update_node #2 折叠", "human")
    await mm.delete_map(100)
    assert drain_pending(100) == []


# ── expand_all ────────────────────────────────────────────────────────


async def test_expand_all(session_factory, seeded_map):
    # 先折叠 #1 root 和 #2 a
    await mm.update_node(100, 1, collapsed=True, actor="human")
    await mm.update_node(100, 2, collapsed=True, actor="human")
    q = subscribe(100)
    m = await mm.expand_all(
        100,
        actor="human",
        client_request_id="expand-123",
    )
    from sqlmodel import select

    try:
        event = q.get_nowait()
        assert event["client_request_id"] == "expand-123"
        assert event["payload"] == {}
        async with session_factory() as s:
            nodes = (await s.exec(select(Node).where(Node.map_id == 100))).all()
            assert all(n.collapsed is False for n in nodes)  # 全部展开
            # 视图操作不改变修改标记与时间戳
            assert all(n.updated_by == "human" for n in nodes if n.display_id == 1)
            assert m.version == 1  # 收放是视图态：不递增 version（两次折叠 + expand 都不动）
    finally:
        unsubscribe(100, q)


# ── set_fold_level ────────────────────────────────────────────────────


async def test_set_fold_level_folds_by_depth(session_factory, seeded_map):
    from sqlmodel import select

    await mm.update_node(100, 2, content="a(agent)", actor="agent")  # updated_by → agent
    q = subscribe(100)
    try:
        m = await mm.set_fold_level(
            100,
            2,
            actor="human",
            client_request_id="level-123",
        )
        assert m.version == 2  # 仅 update_node 计数；fold 是视图态不递增
        evt = q.get_nowait()
        assert evt["action"] == "folded_to_level" and evt["version"] == 2  # 仍广播（同 version）
        assert evt["client_request_id"] == "level-123"
        assert evt["payload"] == {"level": 2}
        async with session_factory() as s:
            nodes = (await s.exec(select(Node).where(Node.map_id == 100))).all()
            # root(d1) 展开、a(d2, 有孩子) 折叠、a1(d3, 叶子) 不折叠
            assert {n.display_id: n.collapsed for n in nodes} == {1: False, 2: True, 3: False}
            a = next(n for n in nodes if n.display_id == 2)
            assert a.updated_by == "agent"  # 视图操作不刷修改标记
    finally:
        unsubscribe(100, q)


async def test_set_fold_level_level_eq_depth_expands_all(session_factory, seeded_map):
    from sqlmodel import select

    await mm.update_node(100, 1, collapsed=True, actor="human")
    await mm.update_node(100, 2, collapsed=True, actor="human")
    m = await mm.set_fold_level(100, 3)  # level = 树深 → 等价全展开
    assert m.version == 1  # 折叠与展开都是视图态，version 纹丝不动
    async with session_factory() as s:
        nodes = (await s.exec(select(Node).where(Node.map_id == 100))).all()
        assert all(n.collapsed is False for n in nodes)


async def test_set_fold_level_noop(session_factory, seeded_map):
    m1 = await mm.set_fold_level(100, 2)
    assert m1.version == 1
    q = subscribe(100)
    try:
        m2 = await mm.set_fold_level(100, 2)  # 已是目标态
        assert m2.version == 1  # version 不动
        assert q.empty()  # 不广播
    finally:
        unsubscribe(100, q)


async def test_set_fold_level_multi_branch_depth(session_factory, seeded_map):
    from sqlmodel import select

    # 搭不对称树：root(#1)┬ a(#2)└a1(#3)  └ b(#4)└b1(#5)└b2(#6)
    await mm.add_node(100, 1, "b")  # #4 d2
    await mm.add_node(100, 4, "b1")  # #5 d3
    await mm.add_node(100, 5, "b2")  # #6 d4
    m = await mm.set_fold_level(100, 3)
    assert m.version == 4  # 仅 3 次 add 计数；fold 是视图态不递增
    async with session_factory() as s:
        nodes = (await s.exec(select(Node).where(Node.map_id == 100))).all()
        state = {n.display_id: n.collapsed for n in nodes}
        # d1/d2 全展开；b1(d3, 有孩子) 折叠；a1/b2 叶子恒 False
        assert state == {1: False, 2: False, 3: False, 4: False, 5: True, 6: False}


async def test_set_fold_level_rejects_level_one(session_factory, seeded_map):
    with pytest.raises(ValueError, match="level 必须 ≥ 2"):
        await mm.set_fold_level(100, 1)


async def test_set_fold_level_missing_map(session_factory):
    with pytest.raises(ValueError, match="not found"):
        await mm.set_fold_level(999, 2)


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


# ── External Changes 判定矩阵（按 actor 区分内外 Agent） ──────────────


async def test_pending_records_human_and_external_agent_not_page_agent(session_factory):
    """只有页内 Agent（page_agent）豁免；human 与外部 agent 都进待通知缓冲。"""
    drain_pending(100)  # 清场：模块级缓冲可能残留其他测试的记录
    publish_change(100, version=2, action="node_updated", actor="human", detail="h")
    publish_change(100, version=3, action="node_updated", actor="agent", detail="e")
    publish_change(100, version=4, action="node_updated", actor="page_agent", detail="p")
    assert drain_pending(100) == [("human", "h"), ("agent", "e")]


def test_resolve_actor_maps_page_agent_source():
    """source='page-agent'（页内 Agent header）映射为专属 actor；
    其他值 / None（外部调用方）actor 原样保留。"""
    from src.service.mindmap.service import _resolve_actor

    assert _resolve_actor("agent", "page-agent") == "page_agent"
    assert _resolve_actor("agent", None) == "agent"
    assert _resolve_actor("agent", "other") == "agent"
    assert _resolve_actor("human", None) == "human"


async def test_outline_multiline_content_roundtrip(session_factory, seeded_map):
    """多行内容（Shift+Enter）经 outline 行协议往返不破协议、内容无损。

    outline 一行一节点：内容里的换行必须转义为 \\n、反斜杠转义为 \\\\，
    get_tree → apply_outline(merge) 闭环后原样还原。
    """
    await mm.update_node(100, 2, content="第一行\n第二行反斜杠\\路径")  # noqa: W605
    tree = await mm.get_tree(100)
    # 3 节点 = 3 行：换行被转义后没有多出来的行（协议未破）
    assert len(tree.splitlines()) == 3
    assert "\\n" in tree and "\\\\" in tree  # 转义形态在 outline 文本里可见
    await mm.apply_outline(100, tree, mode="merge")
    from sqlmodel import select

    async with session_factory() as s:
        nodes = (await s.exec(select(Node).where(Node.map_id == 100))).all()
    n2 = next(n for n in nodes if n.display_id == 2)
    assert n2.content == "第一行\n第二行反斜杠\\路径"  # noqa: W605
