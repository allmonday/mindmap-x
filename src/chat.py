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
- AGENT_CHAT_TIMEOUT  默认 180 秒（空闲超时：连续无流式输出才算，输出不断则永不触发）
"""
import asyncio
import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from src.service.mindmap.events import drain_pending

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)  # root 默认 WARNING 会吞掉观测日志（stop_reason 等）


def _utc_iso(s: str) -> str:
    """归档时间统一为 UTC aware ISO。

    旧归档的 created_at 是 naive 服务器本地时间（历史约定）——astimezone()
    按服务器时区视为本地再转 UTC，显示值不变；新归档已带 offset 原样返回。
    """
    dt = datetime.fromisoformat(s)
    return dt.isoformat() if dt.tzinfo else dt.astimezone().isoformat()


def _load_dotenv(path: str = ".env") -> None:
    """极简 .env 加载（不覆盖已存在的环境变量，无额外依赖）。"""
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except FileNotFoundError:
        pass


_load_dotenv()

router = APIRouter()

SELF_MCP_URL = os.getenv("SELF_MCP_URL", "http://127.0.0.1:8740/mcp/")
AGENT_TIMEOUT_S = float(os.getenv("AGENT_CHAT_TIMEOUT", "180"))

# 会话持久化（strands FileSessionManager）：每张脑图一个 session、固定 agent_id，
# 历史存 var/sessions/（JSON 文件，随 var/* 进 gitignore）
SESSIONS_DIR = os.getenv("CHAT_SESSIONS_DIR", "var/sessions")
SESSION_AGENT_ID = "chat"

# 「清除 context」的归档目录：当前对话 → var/chat_history/map{N}/chat_{时间戳}.json
ARCHIVE_DIR = os.getenv("CHAT_ARCHIVE_DIR", "var/chat_history")
_ARCHIVE_ID_RE = re.compile(r"chat_\d{8}-\d{6}")  # 归档 id 白名单（防路径穿越）


def _session_id(map_id: int) -> str:
    return f"mindmap-map{map_id}"


def _history_payload(map_id: int) -> list[dict]:
    """读取该脑图的持久化对话历史，提取为 [{role, text}]（跳过工具调用块）。

    user 消息尾部注入的 <external_changes> 块是给 LLM 的上下文，气泡/归档不显示。
    """
    from strands.session import FileSessionManager
    from strands.types.exceptions import SessionException

    sm = FileSessionManager(session_id=_session_id(map_id), storage_dir=SESSIONS_DIR)
    try:
        entries = sm.list_messages(_session_id(map_id), SESSION_AGENT_ID)
    except SessionException:
        return []  # 新会话：messages 目录尚不存在 = 无历史
    out: list[dict] = []
    for sm_entry in entries:
        msg = sm_entry.message
        role = msg.get("role", "assistant")
        if role not in ("user", "assistant"):
            continue
        # strands 消息块无 type 字段：文本块直接 {"text": ...}；
        # 思考块 {"reasoningContent"}、工具块 {"toolUse"/"toolResult"} 均无 text 键
        text = "".join(
            block["text"]
            for block in msg.get("content", [])
            if isinstance(block, dict) and isinstance(block.get("text"), str)
        ).strip()
        # 思考块 {"reasoningContent": {"reasoningText": {"text": ...}}}（推理模型），
        # 作为可选 thinking 字段带给前端可折叠展示；不回传 LLM（多轮协议不支持）
        thinking = "".join(
            block["reasoningContent"].get("reasoningText", {}).get("text", "")
            for block in msg.get("content", [])
            if isinstance(block, dict) and isinstance(block.get("reasoningContent"), dict)
        ).strip()
        if role == "user":
            text = _EXTERNAL_CHANGES_RE.sub("", text).strip()
        if text or thinking:
            entry = {"role": role, "text": text}
            if thinking:
                entry["thinking"] = thinking
            out.append(entry)
    return out


# 剥掉 user 消息尾部的外部改动注入块（含前导空白，DOTALL 跨行匹配）
_EXTERNAL_CHANGES_RE = re.compile(r"<external_changes>.*?</external_changes>", re.DOTALL)


# ── 「清除 context」：当前对话归档 + 重置 strands 会话 ──────────────────


def _archive_current(map_id: int) -> dict | None:
    """把当前持久化对话写入归档文件，返回归档摘要（无历史时返回 None 不落盘）。

    必须先归档再清 session，保证数据不丢；文件名 = 归档 id（时间戳，可排序）。
    """
    messages = _history_payload(map_id)
    if not messages:
        return None
    now = datetime.now(timezone.utc)  # 归档时间统一 UTC（服务器时区无关）
    archive_id = f"chat_{now.strftime('%Y%m%d-%H%M%S')}"
    doc = {"id": archive_id, "created_at": now.isoformat(timespec="seconds"), "messages": messages}
    d = os.path.join(ARCHIVE_DIR, f"map{map_id}")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, f"{archive_id}.json"), "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    first_user = next((m["text"] for m in messages if m["role"] == "user"), "")
    return {
        "id": archive_id,
        "created_at": doc["created_at"],
        "count": len(messages),
        "preview": first_user[:40] + "…" if len(first_user) > 40 else first_user,
    }


def _clear_session(map_id: int) -> None:
    """删除该图的 strands 会话目录：Agent 下一轮从全新 context 开始。

    目录不存在（SessionException）视为已清空；FileSessionManager 构造时会自动
    重建空会话目录，后续 _history_payload / _run_agent 无需特殊处理。

    注意：delete_map（软删除）不调用本函数——会话/归档随图保留
    （rowid 不复用，不会被新图误读；恢复时对话还在）。
    """
    from strands.session import FileSessionManager
    from strands.types.exceptions import SessionException

    try:
        FileSessionManager(session_id=_session_id(map_id), storage_dir=SESSIONS_DIR).delete_session(
            _session_id(map_id)
        )
    except SessionException:
        pass


def _archive_list(map_id: int) -> list[dict]:
    """该图全部归档摘要，按时间倒序（最新在前）。"""
    d = os.path.join(ARCHIVE_DIR, f"map{map_id}")
    if not os.path.isdir(d):
        return []
    out: list[dict] = []
    for name in sorted(os.listdir(d), reverse=True):
        if not (name.startswith("chat_") and name.endswith(".json")):
            continue
        with open(os.path.join(d, name), encoding="utf-8") as f:
            doc = json.load(f)
        first_user = next((m["text"] for m in doc["messages"] if m["role"] == "user"), "")
        out.append(
            {
                "id": doc["id"],
                "created_at": _utc_iso(doc["created_at"]),
                "count": len(doc["messages"]),
                "preview": first_user[:40] + "…" if len(first_user) > 40 else first_user,
            }
        )
    return out


def _archive_read(map_id: int, archive_id: str) -> dict | None:
    """读单个归档全文；id 不合法或文件不存在返回 None。"""
    if not _ARCHIVE_ID_RE.fullmatch(archive_id):
        return None
    path = os.path.join(ARCHIVE_DIR, f"map{map_id}", f"{archive_id}.json")
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    doc["created_at"] = _utc_iso(doc["created_at"])  # 旧归档 naive → UTC，读取口径与列表一致
    return doc


@router.get("/api/chat/archives")
async def chat_archives(map_id: int) -> list[dict]:
    return await asyncio.to_thread(_archive_list, map_id)


@router.get("/api/chat/archives/{archive_id}")
async def chat_archive_detail(archive_id: str, map_id: int) -> dict:
    doc = await asyncio.to_thread(_archive_read, map_id, archive_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="归档不存在")
    return doc

SYSTEM_PROMPT = """\
你在一个人机协同脑图工具中充当 Agent，通过 mindmap MCP 工具操作当前脑图（map_id={map_id}）。
节点 ID 是 map 内编号（display_id，每图从 1 起）。工具全景（已绑定，无需探索）：
- 读：get_tree 整树 outline（带 [id:N] 锚点，要结构只读它）；get_map 结构化全量
- 单点写：add_node / update_node / move_node / delete_node
- 批量写：apply_outline（缩进文本重构，merge 不误删未提及节点）
- 收放：set_fold_level(map_id, level)（level=可见层数）；expand_all 全展开
- 版本：list_revisions / get_revision / restore_revision
- delete_map 整图删除（慎用）；list_maps 与你无关（map_id 已绑定）

效率守则：
1. 思考阶段零调用：推理/思考内容只能是纯文本（计划与分析），严禁在其中发起任何
   工具调用——它们会被真实执行、产生副作用和多余轮次。先想清完整方案，再在执行
   阶段一次性发出调用。
2. 信任写返回：写操作的成功返回即最终事实，禁止写后复读核对；结果与预期矛盾才重读。
3. 批量优先：折叠/展开 → set_fold_level / expand_all（严禁逐节点 update_node）；
   ≥2 处结构或内容变化 → apply_outline 一次完成；单点改动 → 对应单方法。
4. 读择一：要结构和节点号只 get_tree（不要 get_map + get_tree 双读）；开局不例行读树
   ——上一轮自己的操作结果 + 消息尾部 <external_changes> 就是当前状态，两者都缺位
   才读一次建立基线。
5. 节点号稳定：上次 get_tree 看到的 display_id 无需重新核对（outline replace 重排除外，
   其返回会说明）。

apply_outline 的 outline 格式（与 get_tree 输出同构）：
- 每行必须以 "- " 开头："- 内容" 或 "- [id:N] 内容"（无 id = 新建节点）
- 缩进每 2 个空格深一级，不能跳级；首行必须是无缩进的根，且只能一行
- 内容中的换行写作 \\n（行协议转义，get_tree 输出同理）
示例：
- [id:1] 根
  - [id:2] 已有子节点
  - 全新子节点
    - 孙节点
注意：get_map 返回里的 parent_id 是全局内部键（组树用），不是节点编号，操作时始终用 display_id。
用户的每轮消息都请实际完成操作，然后用一两句话说明你做了什么。
用户消息尾部可能附带 <external_changes> 块 = 你上一轮之后用户在画布上手动
修改的清单；与你历史记忆冲突时以其为准，拿不准再 get_tree 核对。\
"""

_MODEL_ENV = ("OPENAI_BASE_URL", "OPENAI_API_KEY", "AGENT_MODEL")


def _agent_model() -> str:
    """模型名：AGENT_MODEL 优先，回退 OPENAI_MODEL（沿用机器上已有的网关配置）。"""
    return os.getenv("AGENT_MODEL") or os.getenv("OPENAI_MODEL", "")


# ── 健康检查 ───────────────────────────────────────────────────────────


async def health_check() -> dict:
    """面板打开时前端先调——在用户发消息之前暴露问题。

    三级检查：环境变量完整性 → 模型网关探活 → MCP 握手。
    失败原因结构化返回（reason_code + reason_detail 插值参数），
    文案由前端按 UI 语言渲染——服务端不感知界面语言。
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
    reason_code: str | None = None
    reason_detail: dict[str, str | int] = {}

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
                reason_code, reason_detail = "gateway_http", {"status": resp.status_code}
        except Exception as e:
            reason_code, reason_detail = "gateway_unreachable", {
                "error": type(e).__name__,
                "base": base,
            }
    else:
        reason_code, reason_detail = "env_missing", {"missing": ", ".join(missing)}

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
            if not checks["mcp"] and reason_code is None:
                reason_code, reason_detail = "mcp_http", {"status": resp.status_code}
    except Exception as e:
        checks["mcp"] = False
        if reason_code is None:
            reason_code, reason_detail = "mcp_unreachable", {"error": type(e).__name__}

    return {
        "ok": all(checks.values()) and not missing,
        "checks": checks,
        "reason_code": reason_code,
        "reason_detail": reason_detail or None,
    }


@router.get("/api/chat/status")
async def chat_status() -> dict:
    return await health_check()


# ── strands Agent runner（进程内） ─────────────────────────────────────


def _new_interrupt_ctl() -> dict:
    """中断握手：WS 主循环（事件循环线程）→ 工作线程里的 strands Agent。

    基于 strands Agent.cancel()（线程安全 threading.Event、幂等；检查点遍布
    LLM 流 chunk 间/工具前后/MCP 调用内）。取消后 agent(text) 正常返回
    AgentResult(stop_reason="cancelled")，流中未完成的消息不入历史。

    无锁双向握手——顺序是正确性约束，覆盖任意真实时序：
      工作线程：先 ctl["agent"] = agent，再查 ctl["event"]
      事件循环：先 ctl["event"].set()，再读 ctl["agent"]
    后发生一侧的检查必然看到对方的写（GIL 下单键 dict 赋值原子可见）。
    """
    evt = threading.Event()
    ctl: dict = {"event": evt, "agent": None, "stop_reason": None}

    def request() -> None:
        evt.set()
        if (agent := ctl["agent"]) is not None:
            agent.cancel()

    ctl["request"] = request
    return ctl


async def _run_agent(ws: WebSocket, map_id: int, text: str, ctl: dict) -> None:
    """一轮对话：strands Agent（工作线程）经 loopback MCP 操作脑图。

    并发模型（关键）：strands 的 MCPClient 是同步 API——`__enter__` 起后台线程
    后**阻塞当前线程**等初始化。若直接在协程里调用，会卡死事件循环，而它等待的
    MCP 响应又需要本进程的事件循环服务（loopback）→ 死锁（实测踩过）。
    因此整轮 agent 丢 `asyncio.to_thread`，同步 streaming 回调经
    `loop.call_soon_threadsafe` 桥回事件循环转发 WS。

    会话延续：FileSessionManager 持久化（构造恢复 / 每轮 sync_agent 落盘）。
    超时：空闲语义——流式输出（delta/reasoning）持续到达就永不触发，仅当
    连续 AGENT_TIMEOUT_S 无输出才放弃；工作线程不可强杀，但中断/超时/断开
    都会经 ctl 递刀，Agent 在下一个取消检查点（通常亚秒级，最坏 = 当前
    LLM 请求首字节）优雅停止，不再孤儿化跑完整轮。
    """
    # 局部 import：启动期不依赖 strands（未配 env 时服务其余功能照常）
    from strands import Agent
    from strands.models.openai import OpenAIModel
    from strands.tools.mcp import MCPClient

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue()

    def on_event(**kwargs) -> None:
        """strands 同步流式回调（工作线程内执行，事件 dict 以 kwargs 展开）。

        文本增量 = delta + data（TextStreamEvent）；思考增量 = delta + reasoning +
        reasoningText（ReasoningTextStreamEvent，GLM 推理模型先思考后作答）；
        complete=True 是消息收尾（完整文本重复送达，跳过）。
        """
        if "delta" in kwargs and kwargs.get("reasoning"):
            text = kwargs.get("reasoningText")
            if isinstance(text, str) and text:
                loop.call_soon_threadsafe(queue.put_nowait, ("reasoning", text))
            return
        data = kwargs.get("data")
        if "delta" in kwargs and isinstance(data, str) and data and not kwargs.get("complete"):
            loop.call_soon_threadsafe(queue.put_nowait, ("delta", data))

    def work() -> None:
        """工作线程：同步 MCP 上下文 + 同步 agent 循环。

        会话持久化交给 FileSessionManager（Agent 注册为 hook，每轮结束
        sync_agent 自动写盘；构造时自动恢复该 session 的历史——跨 WS 连接延续）。
        """
        from strands.session import FileSessionManager

        sm = FileSessionManager(session_id=_session_id(map_id), storage_dir=SESSIONS_DIR)
        # X-Mindmap-Source 标记自己是页内 Agent：服务端 context_extractor 提取
        # → FromContext 注入 → actor='page_agent' → 不进 <external_changes>
        # 待通知缓冲（自己的改动 toolResult 已自知，注入回去是回声噪音）。
        # 外部 Agent（Claude Code / Cursor）不带此头，写入会被记录并注入。
        with MCPClient(
            url=SELF_MCP_URL,
            headers={"X-Mindmap-Source": "page-agent"},
        ) as mcp:
            agent = Agent(
                agent_id=SESSION_AGENT_ID,
                session_manager=sm,
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
                callback_handler=on_event,
            )
            # 中断握手：先挂 agent，再查 event（顺序是 _new_interrupt_ctl 的约束）。
            # 注意：Agent 每轮新建、用完即弃是前提——若跨轮复用实例，残留的
            # _cancel_signal 会让下一轮在首个 chunk 被静默取消。
            ctl["agent"] = agent
            if ctl["event"].is_set():
                # 创建窗口期到达的中断：首轮 LLM 请求仍会发出（SDK 无更早
                # 检查点），第一个 chunk 处即截断返回 cancelled
                agent.cancel()
            result = agent(text)  # 同步执行完整「LLM ↔ 工具」循环；逐消息自动落盘
            # stop_reason 紧跟调用、留在 with 块内：__exit__ 抛异常也拿得到
            ctl["stop_reason"] = result.stop_reason
            logger.info(
                "page-agent turn finished: map=%s stop_reason=%s", map_id, result.stop_reason
            )

    work_task = asyncio.create_task(asyncio.to_thread(work))
    # 空闲超时（非总时长）：只要流式输出在动（delta/reasoning 到达）计时器就
    # 重置——长任务哪怕跑几十分钟也不会被砍；仅当连续 AGENT_TIMEOUT_S 无任何
    # 输出（典型：网关挂起、模型停滞）才放弃。静默窗口的正常上界 = MCP 工具
    # 执行（毫秒级）+ 下一轮 LLM 首字节，远小于 180s。
    last_activity = time.monotonic()
    timed_out = False
    try:
        while not work_task.done() or not queue.empty():
            try:
                kind, payload = await asyncio.wait_for(queue.get(), timeout=0.2)
            except asyncio.TimeoutError:
                if time.monotonic() - last_activity > AGENT_TIMEOUT_S:
                    timed_out = True
                    break
                continue  # 工作线程仍在跑，回来看 task 状态
            last_activity = time.monotonic()
            if kind == "delta":
                await ws.send_json({"type": "delta", "text": payload})
            elif kind == "reasoning":
                await ws.send_json({"type": "reasoning", "text": payload})
    except asyncio.CancelledError:
        # 连接关闭：事件循环侧退出，同时给工作线程递刀（不留孤儿继续写库写盘）
        ctl["request"]()
        raise
    if timed_out:
        ctl["request"]()  # 切断工作线程：孤儿窗口从"跑完整轮"缩到下一检查点
        await ws.send_json(
            {"type": "error", "message": f"Agent 空闲超时（{AGENT_TIMEOUT_S:.0f}s 无输出），已放弃等待"}
        )
        return
    interrupted = ctl.get("stop_reason") == "cancelled"
    if (exc := work_task.exception()) is not None:
        if interrupted or ctl["event"].is_set():
            # 中断引发的异常（如取消后的 MCP 会话清理失败）：按已中断汇报，
            # 不给用户报"执行失败"
            logger.warning("agent turn ended with exception after interrupt: %r", exc)
            await ws.send_json({"type": "done", "interrupted": True})
        else:
            await ws.send_json({"type": "error", "message": f"Agent 执行失败: {type(exc).__name__}: {exc}"})
    else:
        await ws.send_json({"type": "done", "interrupted": interrupted})


# ── WS 端点 ───────────────────────────────────────────────────────────


@router.websocket("/chat/{map_id}")
async def chat(ws: WebSocket, map_id: int):
    await ws.accept()

    status = await health_check()
    await ws.send_json({"type": "status", **status})
    if not status["ok"]:
        await ws.close()
        return

    # 推送持久化的对话历史（文件 IO 丢线程，避免阻塞事件循环）
    history = await asyncio.to_thread(_history_payload, map_id)
    if history:
        await ws.send_json({"type": "history", "messages": history})

    task: asyncio.Task | None = None
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("type") == "clear":
                # busy 时必须拒绝：in-flight 删除会被工作线程的落盘
                # makedirs(exist_ok=True) 静默重建目录并写回本轮对话（"复活"）
                if task is not None and not task.done():
                    await ws.send_json({"type": "busy", "message": "Agent 正在思考，稍后再清空"})
                    continue
                def clear_all() -> dict | None:
                    archive = _archive_current(map_id)  # 先归档再清，保证不丢
                    _clear_session(map_id)
                    return archive
                archive = await asyncio.to_thread(clear_all)
                await ws.send_json({"type": "cleared", "archive": archive})
                continue
            if msg.get("type") == "interrupt":
                # 前端"停止"按钮。不回执：前端本地置 stopping 防重复点击，
                # 权威信号是随后的 done.interrupted。task 已结束（含两轮之间
                # 的空档）→ 静默忽略；重复 interrupt 幂等无害。
                if task is not None and not task.done():
                    ctl["request"]()
                continue
            if msg.get("type") != "user":
                continue
            text = str(msg.get("text", "")).strip()
            if not text:
                continue
            if task is not None and not task.done():
                await ws.send_json({"type": "busy", "message": "Agent 正在处理上一条消息…"})
                continue
            # 外部改动通知：你不在时别人改了树（用户手改 / 外部 Agent 写入）→
            # 拼在本轮 user 消息尾部发给 LLM（消费即清空）。注入在末尾追加区，
            # system prompt 与既有历史不动，KV-cache 前缀安全。页内 Agent 自己
            # 的写入不在此列（actor='page_agent' 豁免，见 events.py）。
            pending = drain_pending(map_id)
            if pending:
                by_human = [d for a, d in pending if a == "human"]
                by_agent = [d for a, d in pending if a != "human"]
                sections = []
                if by_human:
                    sections.append(
                        "用户在画布上手动修改了：\n"
                        + "\n".join(f"- {d}" for d in by_human)
                    )
                if by_agent:
                    sections.append(
                        "外部 Agent（MCP/CLI/REST）修改了：\n"
                        + "\n".join(f"- {d}" for d in by_agent)
                    )
                text += "\n\n<external_changes>\n" + "\n".join(sections) + "\n</external_changes>"
            # 不 await：主循环继续收消息（busy 拒绝可达）；空闲超时由 runner 内部处理
            # ctl 先于 create_task 武装：消灭"发送后瞬间点停止"的丢包窗口
            ctl = _new_interrupt_ctl()
            task = asyncio.create_task(_run_agent(ws, map_id, text, ctl))
    except WebSocketDisconnect:
        pass
    finally:
        if task is not None and not task.done():
            task.cancel()  # 浏览器关面板/切图：带走正在跑的 Agent
