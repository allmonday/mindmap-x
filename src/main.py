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


def _extract_source(request) -> dict[str, str]:
    """context_extractor：从请求头提取来源标记 X-Mindmap-Source。

    页内 Agent 自调 MCP 时携带它（chat.py 的 MCPClient headers），
    经 FromContext 注入 MindmapService 方法的 source 参数。两条路径入参
    不同（nexusx 现状）：REST router 传 FastAPI Request；MCP compose_query
    传 None——后者用 fastmcp 的 contextvars 取当前请求头。非 HTTP 上下文
    取不到头时按无标记处理。header 无值/伪造他值均等价于普通外部调用。
    注意：键必须始终存在（值可为 None）——nexusx REST router 对缺失的
    context 键直接 400，不支持方法默认值回退（MCP executor 支持，两者
    行为不一致）；None 值在 _resolve_actor 里等价于"无标记"。
    """
    value = None
    if request is not None:
        value = request.headers.get("x-mindmap-source")
    else:
        try:
            from fastmcp.server.dependencies import get_http_headers

            value = get_http_headers().get("x-mindmap-source")
        except Exception:
            value = None
    return {"source": value}


use_case_config = UseCaseAppConfig(
    name="mindmap",
    services=[MindmapService],
    description="人 + Agent 协同脑图：读写同一棵树",
    context_extractor=_extract_source,
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
                if m is None:
                    # 图已被删除（外部直写 DB 等，未经 events hub 的路径）：
                    # 补发 map_deleted 让客户端退回列表，然后关闭连接
                    await ws.send_json({
                        "type": "changed",
                        "map_id": map_id,
                        "version": last_version + 1,
                        "action": "map_deleted",
                        "actor": "external",
                    })
                    await ws.close(code=4404)
                    break
                if m.version > last_version:
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


# ── 前端静态资源（fe/ 的 Vite 构建产物，构建后可用） ─────────────────
# 必须是全文件最后注册的路由：Mount("/") 会匹配一切未命中的路径。
# 注意：不要再在它之后（或之前）注册 GET / ——之前 root() JSON 端点曾被静态
# mount 遮蔽为死代码，路由顺序调整后又反向抢走 /（浏览器看到 JSON 而非页面）。
# 服务信息可通过 /docs（OpenAPI）查看。

import os  # noqa: E402

if os.path.isdir("src/static"):
    from fastapi.staticfiles import StaticFiles  # noqa: E402

    app.mount("/", StaticFiles(directory="src/static", html=True), name="fe")
