"""Database startup hook.

持久化场景（file sqlite，Phase 0 Step 0-7 确认）：
- schema 由 alembic 管（`alembic upgrade head`）
- mock seed 数据由 scripts/load_seed.py 一次性灌入（保留 ID）
- init_db() 为 no-op，保留函数签名供 main.py lifespan 和 tests/conftest.py 统一调用
"""

async def init_db() -> None:
    """No-op: schema 由 alembic 管理，seed 由 scripts/load_seed.py 灌入。"""
    return None
