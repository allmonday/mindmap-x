#!/usr/bin/env bash
# ── MindMap X 本地启动 ─────────────────────────────────────────────────
# 环境要求：Python ≥ 3.12，Node ^20.19 || ≥22.12（仅构建前端时需要）
# 用法：
#   ./scripts/start.sh            # 依赖 → 迁移 → 前端构建（缺产物时）→ 启动
#   ./scripts/start.sh --seed     # 额外灌入示例脑图（load_seed --force）
#   PORT=9000 ./scripts/start.sh  # 换端口（默认 8740）
# Ctrl+C：优雅关闭服务 → 超时强杀 → 兜底清理端口残留，确保可立即重启
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8740}"
SEED=0
[ "${1:-}" = "--seed" ] && SEED=1

log() { printf '\033[36m[start]\033[0m %s\n' "$*"; }

# 1) 端口预检：被占用直接退出，避免和残留进程/容器打架
if PID="$(lsof -ti tcp:"$PORT")"; then
  echo "端口 $PORT 已被占用（PID: $(echo "$PID" | tr '\n' ' ')）。"
  echo "若为残留进程，执行 kill $PID 后重试。"
  exit 1
fi

# 2) 依赖：.venv 缺失才装（幂等）
if [ ! -x .venv/bin/python ]; then
  log "安装依赖（uv sync --all-extras）…"
  uv sync --all-extras
fi

# 3) 数据库迁移：幂等，git pull 后重启即自动升级 schema
log "数据库迁移（alembic upgrade head）…"
uv run alembic upgrade head

# 4) 前端产物：src/static 被 gitignore，缺失时构建
if [ ! -f src/static/index.html ]; then
  log "构建前端（fe → src/static）…"
  (cd fe && npm install && npm run build)
fi

# 5) 可选种子数据
if [ "$SEED" = 1 ]; then
  log "灌入示例脑图…"
  uv run python scripts/load_seed.py --force
fi

# 6) 启动 + 信号清理
log "启动 http://localhost:${PORT}（Ctrl+C 停止）"
uv run uvicorn src.main:app --host 0.0.0.0 --port "$PORT" &
SERVER_PID=$!

CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return
  CLEANED=1
  log "收到停止信号，正在清理…"
  kill "$SERVER_PID" 2>/dev/null || true
  # 等优雅退出，最多 5 秒
  for _ in $(seq 1 50); do
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 0.1
  done
  kill -9 "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  # 兜底：端口仍有进程则强杀（确保可立即重启）
  if LEFT="$(lsof -ti tcp:"$PORT")"; then
    echo "$LEFT" | xargs kill -9 2>/dev/null || true
    log "已清理端口 $PORT 残留进程"
  fi
  log "端口 $PORT 已释放。"
}
trap cleanup INT TERM EXIT

wait "$SERVER_PID"
