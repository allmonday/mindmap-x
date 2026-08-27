"""FastAPI application entry point.

Phase 1: Voyager (ER diagram) — schema 可视化供确认
Phase 2: + entity-first GraphQL and GraphiQL
Phase 3: + REST + MCP（UseCase GraphQL）+ Voyager（services 视图）；CLI 见 src/cli.py
"""
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, PlainTextResponse
from pydantic import BaseModel

from src.database import init_db
from src.models import BaseEntity, mount_method

# ── Mount methods onto entities (must be called before GraphQL handler) ──

mount_method()

# ── GraphQL handler (must be created AFTER mount_method) ──────────────

from nexusx import (  # noqa: E402
    GraphQLHandler,
    UseCaseAppConfig,
    create_use_case_graphql_mcp_server,
    create_use_case_router,
    create_use_case_voyager,
)

from src.db import async_session  # noqa: E402
from src.models import er  # noqa: E402
from src.service.mindmap.service import MindmapService  # noqa: E402

graphql_handler = GraphQLHandler(
    base=BaseEntity,
    session_factory=async_session,
)

# ── UseCase 接口配置（REST / CLI / MCP / Voyager 共用） ────────────────

use_case_config = UseCaseAppConfig(
    name="mindmap",
    services=[MindmapService],
    description="人 + Agent 协同脑图：读写同一棵树",
)

# ── MCP server（必须在 lifespan 定义之前创建 http_app） ───────────────

mcp = create_use_case_graphql_mcp_server(
    apps=[use_case_config],
    name="Agent MindMap MCP",
)
mcp_http = mcp.http_app(path="/", transport="streamable-http", stateless_http=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    async with mcp_http.lifespan(mcp_http):
        yield


app = FastAPI(
    title="Agent MindMap",
    version="0.1.0",
    description="人 + AI Agent 协同脑图：Human 浏览器编辑 / Agent CLI·MCP·REST 读写 / 实时互见",
    lifespan=lifespan,
)


# ── 业务错误 → HTTP 400（ValueError 是 methods 层的业务校验异常约定） ──
# 只影响 REST 出口；CLI/MCP 不经过 FastAPI，保持协议中立。

from fastapi import Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── REST（create_use_case_router 自动生成，response_model 来自返回注解） ──

app.include_router(create_use_case_router(use_case_config))

# ── Voyager（services 视图：service 节点 + method） ────────────────────

voyager_app = create_use_case_voyager(
    services=use_case_config.services,
    er_manager=er,
    name="Agent MindMap API",
)
app.mount("/voyager", voyager_app)

# ── MCP mount ─────────────────────────────────────────────────────────

app.mount("/mcp", mcp_http)


# FastAPI Mount("/mcp") 对无尾斜杠的 POST /mcp 返回 405（子 app 只注册了 "/"），
# MCP 客户端（claude mcp add http://host:8740/mcp）因此挂载失败 —— 这里在 scope 层重写。
@app.middleware("http")
async def mcp_trailing_slash(request, call_next):
    if request.url.path == "/mcp":
        request.scope["path"] = "/mcp/"
    return await call_next(request)

# ── GraphQL endpoints（Phase 2: entity-first 辅助测试接口） ────────────


class GraphQLRequest(BaseModel):
    query: str
    variables: dict[str, Any] | None = None
    operation_name: str | None = None


@app.get("/graphql", response_class=HTMLResponse)
async def graphiql():
    return graphql_handler.get_graphiql_html()


@app.post("/graphql")
async def graphql_endpoint(req: GraphQLRequest):
    return await graphql_handler.execute(
        query=req.query,
        variables=req.variables,
        operation_name=req.operation_name,
    )


@app.get("/schema", response_class=PlainTextResponse)
async def graphql_schema():
    return graphql_handler.get_sdl()


# ── WebSocket 实时广播（Human / Agent 修改互见的通道） ─────────────────


@app.websocket("/ws/{map_id}")
async def watch_map(ws: WebSocket, map_id: int):
    """订阅某棵脑图的变更事件。

    协议：连接即发 {"type":"hello","version":N}；此后每次 mutation 推
    {"type":"changed","version":M,"action":...,"actor":...}。
    客户端策略：本地 version < 收到 version → 全量重拉。

    双通道检测：
    - 快速路径：服务进程内的 mutation（REST/MCP/前端）→ events hub 即时推送
    - 兜底轮询：外部进程直连 DB 的修改（CLI 等）→ 每 0.4s 对比 version，
      变化即推（action=external）。保证任何写入方都能被浏览器感知。
    """
    import asyncio

    from src.models import Map
    from src.service.mindmap.events import subscribe, unsubscribe

    await ws.accept()
    async with async_session() as session:
        m = await session.get(Map, map_id)
    if m is None:
        await ws.close(code=4404)
        return
    last_version = m.version
    await ws.send_json({"type": "hello", "map_id": map_id, "version": last_version})

    q = subscribe(map_id)
    try:
        while True:
            try:
                event = await asyncio.wait_for(q.get(), timeout=0.4)
            except asyncio.TimeoutError:
                async with async_session() as session:
                    m = await session.get(Map, map_id)
                if m is not None and m.version > last_version:
                    event = {
                        "type": "changed",
                        "map_id": map_id,
                        "version": m.version,
                        "action": "external",
                        "actor": "external",
                    }
                else:
                    continue
            last_version = max(last_version, event.get("version", last_version))
            await ws.send_json(event)
    except WebSocketDisconnect:
        pass
    finally:
        unsubscribe(map_id, q)


# ── 页内 Agent 对话通道（ChatPanel 用） ────────────────────────────────

from src import chat  # noqa: E402

app.include_router(chat.router)


@app.get("/")
async def root():
    return {
        "service": "agent-mindmap",
        "phase": 3,
        "rest_docs": "/docs",
        "graphql": "/graphql",
        "mcp": "/mcp",
        "voyager": "/voyager",
        "chat_status": "/api/chat/status",
        "cli": "uv run python -m src.cli",
    }


# ── 前端静态资源（fe/ 的 Vite 构建产物，构建后可用） ─────────────────
# 必须是全文件最后注册的路由：Mount("/") 会匹配一切未命中的路径，
# 注册在其后的任何 route（含 WS）都会被它截胡（StaticFiles 只收 http scope，WS 会 500）。

import os  # noqa: E402

if os.path.isdir("src/static"):
    from fastapi.staticfiles import StaticFiles  # noqa: E402

    app.mount("/", StaticFiles(directory="src/static", html=True), name="fe")
