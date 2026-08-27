"""页内 Agent 对话通道。

架构（specs/003 计划批准稿）：
- 每轮用户消息 spawn 一个 headless claude 子进程（--mcp-config 指向本服务 /mcp）
- Agent 经 MCP 工具改树 → 既有 /ws/{map_id} 广播驱动画布即时刷新（本模块不碰树）
- 本模块只负责对话文本流转：WS /chat/{map_id} 双向 + 启动前健康检查

安全：spawn 用 argv 数组（无 shell 拼接）；--allowedTools 精确放行 mindmap MCP
工具（不给 --dangerously-skip-permissions，Agent 只能操作脑图）。
"""
import asyncio
import json
import os
import shutil

import httpx
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()

AGENT_CHAT_CMD = os.getenv("AGENT_CHAT_CMD", "claude")
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


# ── 健康检查 ───────────────────────────────────────────────────────────


async def health_check() -> dict:
    """面板打开时前端先调——在用户发消息之前暴露问题。"""
    cli_ok = shutil.which(AGENT_CHAT_CMD) is not None
    mcp_ok = False
    mcp_reason: str | None = None
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
            mcp_ok = resp.status_code == 200
            if not mcp_ok:
                mcp_reason = f"MCP 端点返回 HTTP {resp.status_code}"
    except Exception as e:  # 连接失败/超时等统一归为不可达
        mcp_reason = f"MCP 服务不可达: {type(e).__name__}"

    reason = None
    if not cli_ok:
        reason = f"未找到 Agent CLI（{AGENT_CHAT_CMD}）——可安装或用环境变量 AGENT_CHAT_CMD 指定"
    elif not mcp_ok:
        reason = mcp_reason or "MCP 服务不可用"
    return {"ok": cli_ok and mcp_ok, "checks": {"cli": cli_ok, "mcp": mcp_ok}, "reason": reason}


@router.get("/api/chat/status")
async def chat_status() -> dict:
    return await health_check()


# ── Agent 子进程 ───────────────────────────────────────────────────────


def _build_argv(map_id: int, text: str, resume_id: str | None) -> list[str]:
    mcp_config = json.dumps(
        {"mcpServers": {"mindmap": {"type": "http", "url": SELF_MCP_URL}}}
    )
    argv = [
        AGENT_CHAT_CMD,
        "-p",
        text,
        "--mcp-config",
        mcp_config,
        "--allowedTools",
        "mcp__mindmap__*",
        "--append-system-prompt",
        SYSTEM_PROMPT.format(map_id=map_id),
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    if resume_id:
        argv += ["--resume", resume_id]
    return argv


async def _run_agent(ws: WebSocket, map_id: int, text: str, state: dict) -> None:
    """spawn claude、转发流式回复；成功后把 session_id 存进 state 供下轮 resume。"""
    argv = _build_argv(map_id, text, state.get("session_id"))
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        await ws.send_json({"type": "error", "message": f"无法启动 {AGENT_CHAT_CMD}"})
        return

    async def pump_stdout() -> None:
        """逐行解析 stream-json：assistant 文本 → delta；result → 记录 session_id。"""
        assert proc.stdout is not None
        async for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                evt = json.loads(line)
            except json.JSONDecodeError:
                continue  # 非 JSON 行（CLI 杂音）忽略
            if evt.get("type") == "assistant":
                for block in evt.get("message", {}).get("content", []):
                    if block.get("type") == "text" and block.get("text"):
                        await ws.send_json({"type": "delta", "text": block["text"]})
            elif evt.get("type") == "result":
                sid = evt.get("session_id")
                if sid:
                    state["session_id"] = sid

    async def collect_stderr() -> str:
        assert proc.stderr is not None
        data = await proc.stderr.read()
        return data.decode("utf-8", errors="replace")[-2000:]  # 尾部 2KB 够定位问题

    try:
        stderr_task = asyncio.create_task(collect_stderr())
        await asyncio.wait_for(pump_stdout(), AGENT_TIMEOUT_S)
        returncode = await asyncio.wait_for(proc.wait(), 10)
        stderr = await stderr_task
        if returncode != 0:
            # resume 失效等场景：清掉 session_id，下一轮自然全新会话（不失忆不崩）
            state.pop("session_id", None)
            await ws.send_json(
                {"type": "error", "message": f"Agent 进程退出（{returncode}）: {stderr.strip()[-400:]}"}
            )
        else:
            await ws.send_json({"type": "done"})
    except asyncio.TimeoutError:
        proc.kill()
        await ws.send_json({"type": "error", "message": f"Agent 超时（{AGENT_TIMEOUT_S:.0f}s），已终止"})


# ── WS 端点 ───────────────────────────────────────────────────────────


@router.websocket("/chat/{map_id}")
async def chat(ws: WebSocket, map_id: int):
    await ws.accept()

    status = await health_check()
    await ws.send_json({"type": "status", **status})
    if not status["ok"]:
        await ws.close()
        return

    state: dict = {}  # {"session_id": str} —— 会话延续锚点
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
            task = asyncio.create_task(_run_agent(ws, map_id, text, state))
    except WebSocketDisconnect:
        pass
    finally:
        if task is not None and not task.done():
            task.cancel()  # 浏览器关面板/切图：带走正在跑的 Agent
