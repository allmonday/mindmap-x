"""Database engine + session factory (no model imports).

File-backed SQLite（Phase 0 Step 0-7 确认）：
- async URL:  sqlite+aiosqlite:///./var/mindmap.db（app 运行用，环境变量 DATABASE_URL 可覆盖）
- sync URL:   sqlite:///./var/mindmap.db（alembic / load_seed 用，见环境变量 DATABASE_URL_SYNC）
- schema 由 alembic 管理，db.py 不做 create_all

This module is safe to import from both models.py and database.py.
"""
import os

from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./var/mindmap.db")

# sqlite 建文件时不会自动创建父目录，任何入口（uvicorn / alembic / seed 脚本）都先保证目录存在；
# 从 URL 推导路径（make_url 天然兼容相对/绝对两种写法），不假设 cwd
_db_path = make_url(DATABASE_URL).database
if _db_path and _db_path != ":memory:":
    _db_dir = os.path.dirname(os.path.abspath(_db_path))
    os.makedirs(_db_dir, exist_ok=True)

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
