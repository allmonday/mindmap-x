"""页内 Agent 对话通道 —— 应用内嵌 strands agents。

架构（specs/004）：
- Agent 跑在本进程内（strands Agent.stream_async），模型走 OpenAI 兼容网关
- 工具 = 应用自己的 MCP：MCPClient(url=SELF_MCP_URL) loopback streamable-http，
  与外部 Claude Code / Cursor 共用同一个 /mcp 权威接口
- Agent 调工具改树发生在主进程内 → events hub 快速路径完整保留：
  改树 → /ws 推送 → 画布 <50ms 刷新

为什么不用 stdio：见 specs/004（实时反馈退化到轮询兜底 + 引入第二个 DB 写进程）。

环境变量：
- OPENAI_BASE_URL / OPENAI_API_KEY / AGENT_MODEL  必填（OpenAI 兼容网关）
- SELF_MCP_URL        默认 http://127.0.0.1:8740/mcp/
- AGENT_CHAT_TIMEOUT  默认 180 秒
"""
import asyncio
import json
import os

import httpx
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()

SELF_MCP_URL = os.getenv("SELF_MCP_URL", "http://127.0.0.1:8740/mcp/")
AGENT_TIMEOUT_S = float(os.getenv("AGENT_CHAT_TIMEOUT", "180"))

SYSTEM_PROMPT = """\
你在一个人机协同脑图工具中充当 Agent，通过 mindmap MCP 工具操作当前脑图（map_id={map_id}）。
节点 ID 是 map 内编号（display_id，每图从 1 起）：
- get_tree(map_id) 读整树（outline 文本带 [id:N] 锚点）
- add_node / update_node / move_node / delete_node 按 (map_id, 节点编号) 精确操作
- apply_outline 用缩进文本批量重构（merge 不误删未提及节点）
注意：get_map 返回里的 parent_id 是全局内部键（组树用），不是节点编号，操作时请始终用 display_id；
拿不准时先 get_tree 核对。
用户的每轮消息都请实际完成操作，然后用一两句话说明你做了什么。\
"""

_MODEL_ENV = ("OPENAI_BASE_URL", "OPENAI_API_KEY", "AGENT_MODEL")


def _agent_model() -> str:
    """模型名：AGENT_MODEL 优先，回退 OPENAI_MODEL（沿用机器上已有的网关配置）。"""
    return os.getenv("AGENT_MODEL") or os.getenv("OPENAI_MODEL", "")


# ── 健康检查 ───────────────────────────────────────────────────────────


async def health_check() -> dict:
    """面板打开时前端先调——在用户发消息之前暴露问题。

    三级检查：环境变量完整性 → 模型网关探活 → MCP 握手。
    """
    missing = [
        name
        for name, value in (
            ("OPENAI_BASE_URL", os.getenv("OPENAI_BASE_URL")),
            ("OPENAI_API_KEY", os.getenv("OPENAI_API_KEY")),
            ("AGENT_MODEL / OPENAI_MODEL", _agent_model()),
        )
        if not value
    ]
    checks: dict[str, bool] = {"gateway": False, "mcp": False}
    reason: str | None = None

    if not missing:
        base = os.getenv("OPENAI_BASE_URL", "").rstrip("/")
        key = os.getenv("OPENAI_API_KEY", "")
        try:
            async with httpx.AsyncClient(timeout=3) as client:
                resp = await client.get(
                    f"{base}/models", headers={"Authorization": f"Bearer {key}"}
                )
            checks["gateway"] = resp.status_code < 400
            if not checks["gateway"]:
                reason = f"模型网关返回 HTTP {resp.status_code}（检查 OPENAI_BASE_URL / OPENAI_API_KEY）"
        except Exception as e:
            reason = f"模型网关不可达（{type(e).__name__}）——检查 OPENAI_BASE_URL: {base}"
    else:
        reason = f"未配置模型网关环境变量: {', '.join(missing)}（OpenAI 兼容网关三项，见 README）"

    try:
        async with httpx.AsyncClient(timeout=3) as client:
            resp = await client.post(
                SELF_MCP_URL,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-03-26",
                        "capabilities": {},
                        "clientInfo": {"name": "mindmap-chat", "version": "0"},
                    },
                },
                headers={"Accept": "application/json, text/event-stream"},
            )
            checks["mcp"] = resp.status_code == 200
            if not checks["mcp"] and reason is None:
                reason = f"MCP 端点返回 HTTP {resp.status_code}"
    except Exception as e:
        checks["mcp"] = False
        if reason is None:
            reason = f"MCP 服务不可达: {type(e).__name__}"

    return {"ok": all(checks.values()) and not missing, "checks": checks, "reason": reason}


@router.get("/api/chat/status")
async def chat_status() -> dict:
    return await health_check()


# ── strands Agent runner（进程内） ─────────────────────────────────────


async def _run_agent(ws: WebSocket, map_id: int, text: str, state: dict) -> None:
    """一轮对话：strands Agent（工作线程）经 loopback MCP 操作脑图。

    并发模型（关键）：strands 的 MCPClient 是同步 API——`__enter__` 起后台线程
    后**阻塞当前线程**等初始化。若直接在协程里调用，会卡死事件循环，而它等待的
    MCP 响应又需要本进程的事件循环服务（loopback）→ 死锁（实测踩过）。
    因此整轮 agent 丢 `asyncio.to_thread`，同步 streaming 回调经
    `loop.call_soon_threadsafe` 桥回事件循环转发 WS。

    会话延续：strands 的 messages 历史（含工具调用轨迹）存在 state，下轮传入。
    超时：asyncio.timeout 取消 async 侧；工作线程无法强杀，会自然跑完（无害）。
    """
    # 局部 import：启动期不依赖 strands（未配 env 时服务其余功能照常）
    from strands import Agent
    from strands.models.openai import OpenAIModel
    from strands.tools.mcp import MCPClient

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue()

    def on_event(**kwargs) -> None:
        """strands 同步流式回调（工作线程内执行，事件 dict 以 kwargs 展开）。

        文本增量的特征键组合是 delta + data（TextStreamEvent）；
        complete=True 是消息收尾（完整文本重复送达，跳过）。
        """
        data = kwargs.get("data")
        if "delta" in kwargs and isinstance(data, str) and data and not kwargs.get("complete"):
            loop.call_soon_threadsafe(queue.put_nowait, ("delta", data))

    def work() -> None:
        """工作线程：同步 MCP 上下文 + 同步 agent 循环。"""
        with MCPClient(url=SELF_MCP_URL) as mcp:
            agent = Agent(
                model=OpenAIModel(
                    model_id=_agent_model(),
                    client_args={
                        "base_url": os.environ["OPENAI_BASE_URL"],
                        "api_key": os.environ["OPENAI_API_KEY"],
                    },
                ),
                # with 内同步取工具快照（1.53.0 无 .tools 属性；也不能传 ToolProvider
                # 形式 tools=[mcp]——Agent 会自行 start provider，与 with 冲突）
                tools=list(mcp.list_tools_sync()),
                system_prompt=SYSTEM_PROMPT.format(map_id=map_id),
                messages=state.get("messages") or None,
                callback_handler=on_event,
            )
            agent(text)  # 同步执行完整「LLM ↔ 工具」循环
            state["messages"] = list(agent.messages)

    work_task = asyncio.create_task(asyncio.to_thread(work))
    try:
        async with asyncio.timeout(AGENT_TIMEOUT_S):
            while not work_task.done() or not queue.empty():
                try:
                    kind, payload = await asyncio.wait_for(queue.get(), timeout=0.2)
                except asyncio.TimeoutError:
                    continue  # 工作线程仍在跑，回来看 task 状态
                if kind == "delta":
                    await ws.send_json({"type": "delta", "text": payload})
    except TimeoutError:
        await ws.send_json(
            {"type": "error", "message": f"Agent 超时（{AGENT_TIMEOUT_S:.0f}s），已放弃等待"}
        )
        return
    except asyncio.CancelledError:
        raise  # 连接关闭：事件循环侧退出（工作线程自然结束）
    if (exc := work_task.exception()) is not None:
        await ws.send_json({"type": "error", "message": f"Agent 执行失败: {type(exc).__name__}: {exc}"})
    else:
        await ws.send_json({"type": "done"})


# ── WS 端点 ───────────────────────────────────────────────────────────


@router.websocket("/chat/{map_id}")
async def chat(ws: WebSocket, map_id: int):
    await ws.accept()

    status = await health_check()
    await ws.send_json({"type": "status", **status})
    if not status["ok"]:
        await ws.close()
        return

    state: dict = {}  # {"messages": [...]} —— 会话延续锚点
    task: asyncio.Task | None = None
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("type") != "user":
                continue
            text = str(msg.get("text", "")).strip()
            if not text:
                continue
            if task is not None and not task.done():
                await ws.send_json({"type": "busy", "message": "Agent 正在处理上一条消息…"})
                continue
            # 不 await：主循环继续收消息（busy 拒绝可达）；超时由 runner 内部 asyncio.timeout 处理
            task = asyncio.create_task(_run_agent(ws, map_id, text, state))
    except WebSocketDisconnect:
        pass
    finally:
        if task is not None and not task.done():
            task.cancel()  # 浏览器关面板/切图：带走正在跑的 Agent
