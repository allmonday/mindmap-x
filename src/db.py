"""Database engine + session factory (no model imports).

File-backed SQLite（Phase 0 Step 0-7 确认）：
- async URL:  sqlite+aiosqlite:///./var/mindmap.db（app 运行用）
- sync URL:   sqlite:///./var/mindmap.db（alembic / load_seed 用，见环境变量 DATABASE_URL_SYNC）
- schema 由 alembic 管理，db.py 不做 create_all

This module is safe to import from both models.py and database.py.
"""
import os

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

# sqlite 建文件时不会自动创建父目录，任何入口（uvicorn / alembic / seed 脚本）都先保证 var/ 存在
os.makedirs("var", exist_ok=True)

engine = create_async_engine(
    "sqlite+aiosqlite:///./var/mindmap.db",
    echo=False,
)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
