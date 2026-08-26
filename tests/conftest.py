"""共享 fixture：每测试一个独立的 in-memory SQLite。

关键（模板踩坑 #5）：methods.py 顶部 `from src.db import async_session` 已绑定
原始 factory，运行时 patch src.db 不生效，必须直接 patch methods 模块。
"""
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

import src.models  # noqa: F401  注册 SQLModel.metadata
from src.models import Map, Node


@pytest.fixture
async def session_factory(monkeypatch):
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,  # in-memory 库需要所有连接共享同一个连接
    )
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)

    import src.service.mindmap.methods as mm

    monkeypatch.setattr(mm, "async_session", factory)
    yield factory
    await engine.dispose()


async def seed_tree(factory) -> int:
    """建一棵测试树::

        root(200)
        └── a(201)
            └── a1(202)
    """
    async with factory() as session:
        session.add(Map(id=100, title="T", version=1))
        session.add(Node(id=200, map_id=100, parent_id=None, content="root", position=0))
        session.add(Node(id=201, map_id=100, parent_id=200, content="a", position=0))
        session.add(Node(id=202, map_id=100, parent_id=201, content="a1", position=0))
        await session.commit()
    return 100


@pytest.fixture
async def seeded_map(session_factory) -> int:
    """预置测试树，返回 map_id（100）。"""
    return await seed_tree(session_factory)
