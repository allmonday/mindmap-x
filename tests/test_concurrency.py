"""并发串行化：per-map 锁让并行 mutation 排队全胜；锁外残余竞争翻译为友好错误。

回归背景：agent 并行发 6 个 update_node，无锁时各方读到同一 Map.version、
各算出同一 +1，5 个撞 MapRevision UNIQUE(map_id, version) 裸 IntegrityError
（用户实测）。@_serialized 锁住"读版本→改树→提交"全程；跨进程 CLI 直写 DB
的残余竞争由 _commit_with_revision 的 IntegrityError 兜底翻译。
"""
import asyncio

import pytest
from sqlalchemy import select

import src.service.mindmap.methods as mm
from src.models import Map, MapRevision


async def test_parallel_update_node_all_succeed(seeded_map, session_factory):
    """6 个并发 update_node：全部成功、version 连续、每版本一条 revision。"""
    await asyncio.gather(
        *[mm.update_node(100, 1 + (i % 3), content=f"c{i}", actor="agent") for i in range(6)]
    )

    async with session_factory() as session:
        m = await session.get(Map, 100)
        versions = [
            row[0]
            for row in (
                await session.exec(
                    select(MapRevision.version)
                    .where(MapRevision.map_id == 100)
                    .order_by(MapRevision.version)
                )
            ).all()
        ]
    assert m.version == 7  # 种子 v1 + 6 次
    assert versions == [2, 3, 4, 5, 6, 7]  # 无撞号、无跳号


async def test_stale_version_commit_translated_to_friendly_error(
    seeded_map, session_factory
):
    """锁外竞争（跨进程直写场景）：UNIQUE 冲突 → ValueError 可执行提示。

    用两个 session 同读 version=1 直接进漏斗，复现无锁时序（不经入口函数，
    锁不参与）——确定性制造 MapRevision 撞号。
    """
    async with session_factory() as s1, session_factory() as s2:
        m1 = await s1.get(Map, 100)
        m2 = await s2.get(Map, 100)  # stale：与 s1 同读 version=1
        await mm._commit_with_revision(s1, m1, before={}, action="a", actor="agent")
        with pytest.raises(ValueError, match="版本冲突"):
            await mm._commit_with_revision(s2, m2, before={}, action="b", actor="agent")
        # 败方事务回滚：树与版本元数据不被半吊子污染
        await s2.rollback()
        m = await s1.get(Map, 100)
        assert m.version == 2
