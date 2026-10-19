#!/bin/bash
# LPK 容器启动脚本：建持久目录 → 检查依赖 → DB 迁移 → 启 uvicorn
set -e

# 1. 建持久化目录（容器每次启动都跑，幂等）
mkdir -p /lzcapp/var/uploads /lzcapp/var/sessions

# 2. 选择代码源：dev sync (project-mirror) 优先，回退到镜像内的 /app
mirror_root="/lzcapp/cache/project-mirror"
if [ -f "$mirror_root/pyproject.toml" ]; then
  echo "[startup] Using dev-mirrored code from $mirror_root"
  cd "$mirror_root"
  uv sync --no-dev 2>&1 | tail -3 || {
    echo "[startup] uv sync failed (mirror)!"
    exit 1
  }
else
  cd /app
  echo "[startup] Verifying dependencies..."
  uv sync --no-dev --frozen 2>/dev/null || uv sync --no-dev 2>&1 | tail -3 || {
    echo "[startup] uv sync failed!"
    exit 1
  }
fi

# 3. 应用 alembic 迁移（fresh DB 建全 schema，已有 DB 幂等前滚）
echo "[startup] Running alembic upgrade head..."
uv run alembic upgrade head

# 4. 启动 uvicorn（mirror 态带 --reload 便于 dev 热更）
echo "[startup] Starting uvicorn on :8000..."
if [ -f "$mirror_root/pyproject.toml" ]; then
  exec uv run uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload
else
  exec uv run uvicorn src.main:app --host 0.0.0.0 --port 8000
fi
