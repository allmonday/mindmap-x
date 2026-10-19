# MindMap X backend image
# python:3.13-slim + uv + 我们的代码
# 用 DaoCloud 镜像避免 Docker Hub 在国内访问超时
FROM docker.m.daocloud.io/library/python:3.13-slim

WORKDIR /app

# PyPI 国内镜像（uv 和 pip 都走它）
ENV UV_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple

# 安装 uv
RUN pip install --no-cache-dir uv

# 先装依赖（利用 docker layer cache；--no-dev 不装 test/desktop extras）
COPY pyproject.toml uv.lock ./
RUN uv sync --no-dev --frozen

# 拷贝源码（.dockerignore 已排除 src/static——前端静态由 lzc 内容目录承载，
# 容器只做 API/MCP/WS 服务）
COPY src/ ./src/
COPY alembic/ ./alembic/
COPY alembic.ini ./

# ── 持久化（/lzcapp/var 是 LPK 唯一保证重启后存在的目录）──
ENV DATABASE_URL=sqlite+aiosqlite:////lzcapp/var/mindmap.db
ENV DATABASE_URL_SYNC=sqlite:////lzcapp/var/mindmap.db
ENV MINDMAPX_UPLOADS_DIR=/lzcapp/var/uploads
ENV CHAT_SESSIONS_DIR=/lzcapp/var/sessions

# 页内 Agent 的回环 MCP 地址：容器内端口 8000（默认 8740 是裸机部署约定）
ENV SELF_MCP_URL=http://127.0.0.1:8000/mcp/

ENV PYTHONUNBUFFERED=1
# 容器时区：日志时间戳与系统提示的"今天"对齐（DB 内部统一 UTC 不受影响）
ENV TZ=Asia/Shanghai

# 启动脚本
COPY images/startup.sh /startup.sh
RUN chmod +x /startup.sh

EXPOSE 8000

CMD ["/startup.sh"]
