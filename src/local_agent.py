"""本地 Claude Code 对话通道 —— 第二种页内 Agent 形式（Raft 模式 Demo）。

架构（参考 Raft External Agents 调研，笔记 #52/#53；自托管单用户最简形态：
服务端与 claude 同机，无需 daemon/bridge）：
- 每轮 spawn 本机 `claude -p`（headless，--output-format stream-json 流式）
- MCP 能力经 --mcp-config 指向本服务 /mcp（与外部 Claude Code / strands
  共用同一权威接口），X-Mindmap-Source: page-agent → 与页内 Agent 同权
  （写入不进 <external_changes> 待通知缓冲）
- 多轮上下文：claude 自管 transcript（--resume <session_id>），本模块只
  在内存存一份展示用历史（服务重启即新会话，Demo 边界）
- 权限：--dangerously-skip-permissions（用户确认的全权限形态——可读写
  本地文件、执行 shell，串联线上树与本地机器信息）

与 chat.py 的关系：协议形状完全一致（status/history/delta/reasoning/tool/
done/error/busy/cleared），前端 ChatPanel 复用同一套渲染；实现独立成模块，
strands 链路零改动。

环境变量：
- LOCAL_AGENT_ENABLED   全局开关，默认关闭（false/0 之外的 1/true/yes/on 开启）。
                        打磨期默认关：状态接口报 enabled=false + reason_code=
                        "disabled"，前端隐藏入口（探测失败也按未开启处理）
- LOCAL_AGENT_CMD       默认 claude（可覆盖为绝对路径）
- SELF_MCP_URL          默认 http://127.0.0.1:8740/mcp/（与 chat.py 同源）
- LOCAL_AGENT_TIMEOUT   默认 300 秒（空闲语义：JSONL 无任何行到达才算）
"""
import asyncio
import json
import logging
import os
import signal
import time

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect

from src.service.mindmap.events import drain_pending

logger = logging.getLogger(__name__)
# uvicorn 默认只配置 uvicorn.* logger，应用 logger 传播到 root 无 handler 时
# INFO 会被 lastResort(WARNING) 吞掉——显式挂 handler 才能落进 uvicorn.log
if not logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s:%(name)s:%(message)s", "%H:%M:%S"))
    logger.addHandler(_h)
logger.setLevel(logging.INFO)
logger.propagate = False

router = APIRouter()

LOCAL_CMD = os.getenv("LOCAL_AGENT_CMD", "claude")
SELF_MCP_URL = os.getenv("SELF_MCP_URL", "http://127.0.0.1:8740/mcp/")
IDLE_TIMEOUT_S = float(os.getenv("LOCAL_AGENT_TIMEOUT", "300"))
KILL_GRACE_S = 3.0  # SIGTERM → SIGKILL 宽限（claude 清理 MCP 连接的窗口）
# 全局开关（默认关闭）：false/0/空 → 关；1/true/yes/on（大小写不敏感）→ 开
LOCAL_AGENT_ENABLED = os.getenv("LOCAL_AGENT_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")

# 内存态：map_id → {"session_id": claude 会话 id（--resume 用）, "messages": 展示历史}
# Demo 不落盘；claude 侧 transcript 在 ~/.claude 下持久，重启后仅丢失展示层
_state: dict[int, dict] = {}


def _session_of(map_id: int) -> dict:
    return _state.setdefault(map_id, {"session_id": None, "messages": []})


# ── 在跑轮次注册表：一轮对话的存活与 WS 连接解耦（与 chat.py 同构） ────
#
# 切图/关面板只是「离场」（摘订阅者），claude 进程继续跑完；回到该图重连 WS
# 时重新附着（重放缓冲 + 续流 + busy 态）。一轮结束（done/error/超时）经
# 身份守卫摘表；clear/busy/interrupt 以本表为权威。


class _Turn:
    """一轮进行中的对话（map 级单例：同图同时至多一轮，busy 拒绝保证）。"""

    def __init__(self) -> None:
        self.interrupted = asyncio.Event()
        self.task: asyncio.Task | None = None
        self.subscribers: set[WebSocket] = set()
        # 本轮全部 delta/reasoning/tool 事件（附着重放用）。无需 flush：本通道
        # 历史只在轮次结束 append（user 消息在轮首），重放与历史天然不重叠
        self.buffer: list[dict] = []
        # 重放 vs 续流互斥：附着重放期间事件泵不得插队，防文本增量乱序
        self.lock = asyncio.Lock()


_turns: dict[int, _Turn] = {}  # map_id → in-flight turn


async def _send_all(turn: _Turn, msg: dict) -> None:
    """发给全部订阅者；发送失败（连接已死）即摘除。须持 turn.lock 调用。"""
    dead: list[WebSocket] = []
    for ws in turn.subscribers:
        try:
            await ws.send_json(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        turn.subscribers.discard(ws)


async def _broadcast(turn: _Turn, msg: dict) -> None:
    """一次性事件（done/error 等，不重放）。"""
    async with turn.lock:
        await _send_all(turn, msg)


async def _replayable(turn: _Turn, msg: dict) -> None:
    """可重放事件（delta/reasoning/tool）：入缓冲 + 广播（同一把锁内，原子有序）。"""
    async with turn.lock:
        turn.buffer.append(msg)
        await _send_all(turn, msg)


def _turn_done(turn: _Turn, map_id: int) -> None:
    """轮次终态摘表；身份守卫防摘掉后来的新轮次。"""
    if _turns.get(map_id) is turn:
        _turns.pop(map_id, None)


SYSTEM_PROMPT = """\
你在一个人机协同脑图工具中充当 Agent，通过 mindmap MCP 服务操作当前脑图（map_id={map_id}）。
节点 ID 是 map 内编号（display_id，每图从 1 起）。工具全景（已绑定，无需探索）：
- 读：get_tree 整树 outline（带 [id:N] 锚点，要结构只读它）；get_node 单节点全文（含 note）
- 单点写：add_node / update_node / move_node / delete_node
- 批量写：apply_outline（缩进文本重构，merge 不误删未提及节点）；
  update_notes 批量改备注（一次往返、原子生效，≥2 个节点改备注必用）
- 收放：set_fold_level(map_id, level)；expand_all；版本：list_revisions / restore_revision

apply_outline 的 outline 格式（与 get_tree 输出同构）：
- ⚠ 全量结构写入而非局部补丁：outline 描述写入后整棵子树的样子；只改单个节点
  用 update_node。**缩进即父子关系**——锚定 [id:N] 行的层级必须照抄 get_tree 的
  真实深度，写浅了节点会被移动（如写在根下 = 挂到根节点下方）
- 每行以 "- " 开头："- 内容" 或 "- [id:N] 内容"（无 id = 新建）；缩进每 2 空格
  深一级不能跳级；首行必须是无缩进的根，且只能一行

节点分工：content 是画布短标题（一行），note 是该节点的 markdown 长文备注
（背景/细节/展开论述，前端备注面板渲染）。长内容写 note 而不是撑长 content。
compose_query 的字符串参数（备注、标题等）一律用 GraphQL variables 传，严禁内联：
- query 里声明 $note: String!，值放 variables 参数；variables 是 JSON 对象本身，
  不是序列化后的字符串
- 变量值里的换行直接写真实换行字符（MCP 参数原生支持）；写成 \\n 两个字符会被
  当作字面量存入数据库
- 内联为什么禁：query 字符串里的内容要过 GraphQL 转义层（普通字符串里的
  反斜杠 n 是换行转义、block string 三引号里不转义且吞紧跟引号的首换行），
  多层转义叠加后几乎必错；variables 的值只穿一层 JSON，所见即所得
你同时在用户的本地机器上拥有完整工具（读写文件、执行命令等），需要结合本地
信息（文件、环境、脚本）完成用户请求时直接使用。
用户的每轮消息请实际完成操作，然后用一两句话说明你做了什么。用户消息尾部可能
附带 <external_changes> 块 = 你上一轮之后用户在画布上手动修改的清单。\
"""


def _mcp_config_json() -> str:
    """claude --mcp-config 参数体：指向本服务 /mcp，page-agent 同权。"""
    return json.dumps(
        {
            "mcpServers": {
                "mindmap": {
                    "type": "http",
                    "url": SELF_MCP_URL,
                    "headers": {"X-Mindmap-Source": "page-agent"},
                }
            }
        }
    )


def _spawn_args(text: str, map_id: int, session_id: str | None) -> list[str]:
    args = [
        LOCAL_CMD,
        "-p",
        text,
        "--output-format",
        "stream-json",
        "--verbose",  # stream-json 必须 --verbose 才有逐事件流（否则只有一个 result）
        "--dangerously-skip-permissions",
        "--mcp-config",
        _mcp_config_json(),
        "--append-system-prompt",
        SYSTEM_PROMPT.format(map_id=map_id),
    ]
    if session_id:
        args += ["--resume", session_id]
    return args


async def _kill(proc: asyncio.subprocess.Process) -> None:
    """终止整进程组：claude 会 spawn 子进程（shell 工具/MCP 线程），只杀
    主进程会留孤儿。start_new_session=True 使其自成进程组，killpg 可全灭。"""
    if proc.returncode is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(proc.wait(), timeout=KILL_GRACE_S)
    except asyncio.TimeoutError:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await proc.wait()


async def _drain_stderr(stream: asyncio.StreamReader, sink: list, limit: int = 4000) -> None:
    """后台抽干 stderr：PIPE 不读会满管道死锁；只留尾部 limit 字符做错误诊断。"""
    while True:
        line = await stream.readline()
        if not line:
            return
        sink.append(line.decode("utf-8", "replace"))
        if sum(len(s) for s in sink) > limit:
            del sink[0]  # 粗截断：保留最近内容即可


async def _run_local_agent(turn: _Turn, map_id: int, text: str) -> None:
    """一轮对话：spawn claude → 逐行读 stream-json → 转发订阅者。

    与连接解耦：事件经 turn 的订阅者广播（无人订阅 = 后台继续跑）；轮次终态
    经 _turn_done 摘表。中断信号 = turn.interrupted（Event）。

    事件映射（实测 claude 2.1.229）：
    - system/init → 记 session_id（多轮 --resume 的锚点）
    - system/thinking_tokens → 心跳（不转发，但证明流活着，重置空闲计时）
    - assistant.message.content[]：text 块 → delta；thinking 块 → reasoning；
      tool_use 块 → tool（name + input 预览，前端渲染成 chip）
    - user（tool_result）→ 忽略；result → done
    """
    interrupted = turn.interrupted
    state = _session_of(map_id)
    state["messages"].append({"role": "user", "text": text})

    try:
        try:
            proc = await asyncio.create_subprocess_exec(
                *_spawn_args(text, map_id, state["session_id"]),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
        except FileNotFoundError:
            await _broadcast(
                turn, {"type": "error", "message": f"未找到本地命令 `{LOCAL_CMD}`，请安装 Claude Code 或设 LOCAL_AGENT_CMD"}
            )
            return

        stderr_tail: list[str] = []
        stderr_task = asyncio.create_task(_drain_stderr(proc.stderr, stderr_tail))

        answer_parts: list[str] = []
        thinking_parts: list[str] = []
        timed_out = False
        was_error = False
        try:
            while True:
                try:
                    raw = await asyncio.wait_for(proc.stdout.readline(), timeout=IDLE_TIMEOUT_S)
                except asyncio.TimeoutError:
                    timed_out = True
                    break
                if not raw:
                    break  # EOF：claude 进程退出
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue  # 非完整行（理论上不该有）容错跳过
                etype = ev.get("type")
                if etype == "system" and ev.get("subtype") == "init":
                    if sid := ev.get("session_id"):
                        state["session_id"] = sid
                elif etype == "assistant":
                    for block in ev.get("message", {}).get("content", []):
                        btype = block.get("type")
                        if btype == "text" and block.get("text"):
                            answer_parts.append(block["text"])
                            await _replayable(turn, {"type": "delta", "text": block["text"]})
                        elif btype == "thinking" and block.get("thinking"):
                            thinking_parts.append(block["thinking"])
                            await _replayable(turn, {"type": "reasoning", "text": block["thinking"]})
                        elif btype == "tool_use":
                            preview = json.dumps(block.get("input", {}), ensure_ascii=False)
                            await _replayable(
                                turn,
                                {"type": "tool", "name": block.get("name", "?"), "input_preview": preview[:120]},
                            )
                elif etype == "result":
                    if ev.get("is_error"):
                        was_error = True
                    break
        except asyncio.CancelledError:
            # 服务关闭等强制取消：带走 claude 进程
            await _kill(proc)
            raise
        finally:
            if timed_out or interrupted.is_set():
                await _kill(proc)  # 幂等：已收割（returncode 非空）直接返回
            else:
                await proc.wait()  # 正常 EOF：收割僵尸进程，returncode 才有值

        stderr_task.cancel()
        answer = "".join(answer_parts).strip()
        thinking = "".join(thinking_parts).strip()
        if timed_out:
            await _broadcast(
                turn, {"type": "error", "message": f"Claude Code 空闲超时（{IDLE_TIMEOUT_S:.0f}s 无输出），已终止"}
            )
            return
        if interrupted.is_set():
            # 被中断的轮次不入历史（与 strands 语义一致：未完成的消息不落盘）
            state["messages"].pop()
            await _broadcast(turn, {"type": "done", "interrupted": True})
            return
        if proc.returncode != 0 or was_error:
            detail = "".join(stderr_tail)[-500:] or f"exit={proc.returncode}"
            await _broadcast(turn, {"type": "error", "message": f"Claude Code 执行失败: {detail}"})
            return
        entry = {"role": "agent", "text": answer}
        if thinking:
            entry["thinking"] = thinking
        state["messages"].append(entry)
        logger.info(
            "local-agent turn finished: map=%s exit=%s turns=%s", map_id, proc.returncode, len(answer_parts)
        )
        await _broadcast(turn, {"type": "done", "interrupted": False})
    finally:
        _turn_done(turn, map_id)


# ── 可用性探测 ─────────────────────────────────────────────────────────


_status_cache: dict = {"at": 0.0, "payload": None}  # 缓存：spawn 探测不便宜
_STATUS_TTL_S = 30.0
_STATUS_FAIL_TTL_S = 5.0  # 失败短缓存：偶发探测超时不应造成半分钟重连全拒窗口


async def _probe_status() -> dict:
    # 全局开关关闭：常量应答（无 spawn 无缓存），available=false + reason_code=
    # "disabled"。前端拿到 enabled=false 即隐藏入口，此分支正常不出现在 UI
    if not LOCAL_AGENT_ENABLED:
        return {"available": False, "enabled": False, "cmd": LOCAL_CMD, "version": None, "reason_code": "disabled"}
    now = time.monotonic()
    if _status_cache["payload"] is not None:
        ttl = _STATUS_TTL_S if _status_cache["payload"]["available"] else _STATUS_FAIL_TTL_S
        if now - _status_cache["at"] < ttl:
            return _status_cache["payload"]
    payload = {"available": False, "enabled": True, "cmd": LOCAL_CMD, "version": None}
    try:
        proc = await asyncio.create_subprocess_exec(
            LOCAL_CMD, "--version",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        except asyncio.TimeoutError:
            _kill_sync(proc.pid)
            payload["reason_code"] = "probe_timeout"
        else:
            version = out.decode("utf-8", "replace").strip() or None
            payload.update({"available": proc.returncode == 0, "version": version})
    except FileNotFoundError:
        payload["reason_code"] = "not_found"
    _status_cache.update({"at": now, "payload": payload})
    return payload


def _kill_sync(pid: int) -> None:
    """探测超时的同步兜底杀（_kill 是 async，这里在 except 分支拿不到 await 点）。"""
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


@router.get("/api/local-agent/status")
async def local_agent_status() -> dict:
    return await _probe_status()


@router.post("/api/ws-close-report")
async def ws_close_report(request: Request) -> dict:
    """前端 WS 断连观测（sendBeacon，text/plain 的 JSON）——移动端被掐连接的铁证。

    通用端点（channel 字段区分 strands/local），只在诊断"连接中卡死"期间存在。
    """
    try:
        data = json.loads(await request.body())
    except (json.JSONDecodeError, UnicodeDecodeError):
        data = {}
    logger.info(
        "ws close report: channel=%s map=%s code=%s reason=%s",
        data.get("channel"), data.get("map_id"), data.get("code"), data.get("reason"),
    )
    return {"ok": True}


# ── WS 端点 ───────────────────────────────────────────────────────────


@router.websocket("/local-chat/{map_id}")
async def local_chat(ws: WebSocket, map_id: int):
    await ws.accept()

    status = await _probe_status()
    await ws.send_json({"type": "status", **status})
    # 探测失败也保持连接（不再 close）：历史可看、连接活着，避免前端重连死循环；
    # 输入禁用由前端按 available 处理。失败缓存短 TTL，恢复窗口见 _probe_status

    state = _session_of(map_id)
    if state["messages"]:
        await ws.send_json({"type": "history", "messages": state["messages"]})

    # 附着到在跑的一轮（切图回来 / 断线重连）：重放本轮缓冲，之后续流。
    # 持 turn.lock 保证重放与续流不乱序
    turn = _turns.get(map_id)
    if turn is not None and turn.task is not None and not turn.task.done():
        async with turn.lock:
            await ws.send_json({"type": "resume"})
            for msg in turn.buffer:
                await ws.send_json(msg)
            turn.subscribers.add(ws)

    def running() -> _Turn | None:
        t = _turns.get(map_id)
        return t if t is not None and t.task is not None and not t.task.done() else None

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            mtype = msg.get("type")
            if mtype == "client_close_report":
                # 前端上报的上次断连原因（诊断移动端/中间设备掐连接：1006=异常断）
                logger.info(
                    "local-chat client close report: map=%s code=%s reason=%s",
                    map_id, msg.get("code"), msg.get("reason"),
                )
                continue
            if mtype == "clear":
                if running() is not None:
                    await ws.send_json({"type": "busy", "message": "Claude Code 正在思考，稍后再清空"})
                    continue
                state["messages"] = []
                state["session_id"] = None  # 下轮全新 claude 会话（旧 transcript 留在 ~/.claude）
                await ws.send_json({"type": "cleared", "archive": None})
                continue
            if mtype == "interrupt":
                # 与 chat.py 相同语义：不回执，权威信号是随后的 done.interrupted。
                # 注册表为权威 → 附着连接也能停掉"你不在时"启动/继续的那一轮
                if (t := running()) is not None:
                    t.interrupted.set()
                continue
            if mtype != "user":
                continue
            text = str(msg.get("text", "")).strip()
            if not text:
                continue
            if not LOCAL_AGENT_ENABLED:
                # 服务端兜底强制（UI 已隐藏入口，这里防直连 WS 的旧客户端）
                await ws.send_json({"type": "error", "message": "本地 Claude Code 通道未开启（LOCAL_AGENT_ENABLED）"})
                continue
            if running() is not None:
                await ws.send_json({"type": "busy", "message": "Claude Code 正在处理上一条消息…"})
                continue
            # 外部改动注入：用户手改树 → 拼尾部发给 claude（local 自身写入已豁免）
            pending = drain_pending(map_id)
            if pending:
                # 与 chat.py 同构的双分类注入（local 自身写入已带 page-agent 豁免）
                by_human = [d for a, d in pending if a == "human"]
                by_agent = [d for a, d in pending if a != "human"]
                parts = []
                if by_human:
                    parts.append("用户在画布上手动修改了：\n" + "\n".join(f"- {d}" for d in by_human))
                if by_agent:
                    parts.append("外部 Agent（MCP/CLI/REST）修改了：\n" + "\n".join(f"- {d}" for d in by_agent))
                text += "\n\n<external_changes>\n" + "\n".join(parts) + "\n</external_changes>"
            # 订阅者/注册表都先于 create_task 就位（语义同 chat.py）
            turn = _Turn()
            turn.subscribers.add(ws)
            _turns[map_id] = turn
            turn.task = asyncio.create_task(_run_local_agent(turn, map_id, text))
    except WebSocketDisconnect:
        pass
    finally:
        # 离场只摘订阅，不杀 claude 进程：切图/关面板后本轮继续跑完，
        # 回来重连即附着（见入口的 attach 逻辑）
        if (t := _turns.get(map_id)) is not None:
            t.subscribers.discard(ws)
