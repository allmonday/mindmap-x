"""进程内变更广播 hub。

设计（Phase 0 决策）：
- 事件不落库，仅进程内转发；无订阅者时 publish 是 no-op
- 内容变更事件语义是「某图变了，version 到了 N」，客户端全量重拉
- 高频收放事件额外携带最小 payload，客户端直接 patch，避免读取整棵树
- 慢消费者（队列满）直接丢消息：客户端重连时通过 hello 全量刷新，
  不依赖每条消息都送达
"""
import asyncio

_subscribers: dict[int, set[asyncio.Queue]] = {}


def subscribe(map_id: int) -> asyncio.Queue:
    """订阅某棵脑图的变更事件，返回该订阅的消息队列。"""
    q: asyncio.Queue = asyncio.Queue(maxsize=256)
    _subscribers.setdefault(map_id, set()).add(q)
    return q


def unsubscribe(map_id: int, q: asyncio.Queue) -> None:
    """取消订阅（WebSocket 断开时必须调用，避免泄漏）。"""
    subs = _subscribers.get(map_id)
    if subs is not None:
        subs.discard(q)
        if not subs:
            _subscribers.pop(map_id, None)


def publish_change(
    map_id: int,
    version: int,
    action: str,
    actor: str,
    detail: str | None = None,
    client_request_id: str | None = None,
    payload: dict[str, object] | None = None,
) -> None:
    """脑图发生 mutation 后广播。action 如 'node_added' / 'outline_applied'。

    detail 为该次改动的人类可读摘要（如 "update_node #9 →「xx」"）。除页内
    Agent 外的来源（actor != 'page_agent'：浏览器 human 与外部 MCP/CLI/REST
    agent）都落入待通知缓冲，由页内 Agent 在收到下一条用户消息时消费
    （drain_pending）。client_request_id 仅用于发起收放的浏览器识别自己的
    乐观更新事件；payload 为其他订阅者同步收放状态所需的最小增量。
    """
    if detail is not None and actor != "page_agent":
        record_pending(map_id, detail, actor)
    event = {
        "type": "changed",
        "map_id": map_id,
        "version": version,
        "action": action,
        "actor": actor,
    }
    if client_request_id is not None:
        event["client_request_id"] = client_request_id
    if payload is not None:
        event["payload"] = payload
    for q in list(_subscribers.get(map_id, ())):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            pass  # 极慢客户端可在重连收到 hello 后全量校准


# ── 外部改动待通知缓冲（页内 Agent 的"你不在时别人改了什么"清单） ──────
#
# 设计：进程内存、按 map_id 键控、消费即清空（drain_pending）。
# 记录范围 = 除页内 Agent 外的一切写入方：human（画布手动编辑）与
# agent（外部 MCP/CLI/REST，如 Claude Code / Cursor）。页内 Agent 自己
# （actor='page_agent'，经 X-Mindmap-Source header 识别）不进缓冲——
# 它的 toolResult 已自知，注入回去只是回声噪音。
# 取舍：重启即失（窗口极小，接受）；不做上限（UI 手动操作频率有限）。


_pending: dict[int, list[tuple[str, str]]] = {}


def record_pending(map_id: int, detail: str, actor: str) -> None:
    """记录一条外部改动摘要及来源 actor（事件循环单线程内调用，无竞态）。"""
    _pending.setdefault(map_id, []).append((actor, detail))


def drain_pending(map_id: int) -> list[tuple[str, str]]:
    """取走并清空该图的全部待通知改动，元素为 (actor, detail)。"""
    return _pending.pop(map_id, [])
