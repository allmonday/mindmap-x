# 基础镜像走 ARG（默认官方源）：国内网络可经 compose 的 build.args 换镜像站，
# 见 compose.yaml 注释。注意 ARG 必须在首个 FROM 之前声明才对所有 FROM 生效
ARG NODE_IMAGE=node:22-alpine
ARG UV_IMAGE=ghcr.io/astral-sh/uv:python3.12-bookworm-slim
ARG BASE_IMAGE=python:3.12-slim

# ── stage 1：前端构建 ──────────────────────────────────────────────────
# src/static 被 gitignore —— 产物必须在镜像内构建，保证与源码版本严格对应
FROM ${NODE_IMAGE} AS fe
WORKDIR /app/fe
COPY fe/package.json fe/package-lock.json ./
RUN npm ci
COPY fe/ ./
RUN npm run build # vite outDir=../src/static → /app/src/static

# ── stage 2：依赖构建（uv 只活在构建层，二进制不进最终镜像）───────────
FROM ${UV_IMAGE} AS deps
WORKDIR /app
# 以 app 身份 uv sync，.venv 属主天然正确（免事后 chown -R 整层复制）。
# uv 镜像的 python 与 python:3.12-slim 同源（/usr/local/bin/python3.12，
# 同为 bookworm 构建）——venv 可直接 COPY 进 stage 3 运行
RUN useradd -m app && chown app:app /app
USER app
COPY --chown=app:app pyproject.toml uv.lock ./
# uv.lock 锁定可复现；test/dev 依赖不进运行镜像；
# cache mount：uv 下载缓存只存在于构建期，不写入镜像层
RUN --mount=type=cache,target=/tmp/uv-cache,uid=1000,gid=1000 \
  UV_CACHE_DIR=/tmp/uv-cache uv sync --frozen --no-dev

# ── stage 3：运行时（纯 python slim，无 uv 二进制、无字节码缓存）─────
FROM ${BASE_IMAGE}
WORKDIR /app
RUN useradd -m app && chown app:app /app
USER app
ENV PATH="/app/.venv/bin:$PATH"
COPY --from=deps --chown=app:app /app/.venv ./.venv
COPY --chown=app:app alembic.ini ./
COPY --chown=app:app alembic/ ./alembic/
COPY --chown=app:app src/ ./src/
COPY --from=fe --chown=app:app /app/src/static ./src/static
# var/ 预建（named volume 首挂时继承属主与内容）
RUN mkdir -p /app/var
EXPOSE 8740
# 启动即幂等迁移（升级镜像自动演进 schema），随后起服务
CMD ["sh", "-c", "alembic upgrade head && uvicorn src.main:app --host 0.0.0.0 --port 8740"]
# /api/chat/status 会探外部模型网关（抖动会误杀容器），健康检查用轻量的 /docs
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8740/docs', timeout=3)"
