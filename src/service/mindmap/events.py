"""进程内变更广播 hub。

设计（Phase 0 决策）：
- 事件不落库，仅进程内转发；无订阅者时 publish 是 no-op
- 事件语义是「某图变了，version 到了 N」——通知客户端全量重拉，不做细粒度 patch
- 慢消费者（队列满）直接丢消息：客户端重连/收到后续事件时按 version 对比，
  发现落后就全量刷新，不依赖每条消息都送达
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
) -> None:
    """脑图发生 mutation 后广播。action 如 'node_added' / 'outline_applied'。

    detail 为该次改动的人类可读摘要（如 "update_node #9 →「xx」"）。非 agent
    来源（actor != 'agent'，即浏览器 UI 等外部改动）时落入待通知缓冲，
    由页内 Agent 在收到下一条用户消息时消费（drain_pending）。
    """
    if detail is not None and actor != "agent":
        record_pending(map_id, detail)
    event = {
        "type": "changed",
        "map_id": map_id,
        "version": version,
        "action": action,
        "actor": actor,
    }
    for q in list(_subscribers.get(map_id, ())):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            pass  # 丢消息安全：客户端按 version 全量重拉


# ── 外部改动待通知缓冲（页内 Agent 的"你不在时用户改了什么"清单） ──────
#
# 设计：进程内存、按 map_id 键控、消费即清空（drain_pending）。
# Agent 自己的改动（actor='agent'）不进缓冲——它的 toolResult 已自知。
# 取舍：重启即失（窗口极小，接受）；不做上限（UI 手动操作频率有限）。


_pending: dict[int, list[str]] = {}


def record_pending(map_id: int, detail: str) -> None:
    """记录一条外部改动摘要（事件循环单线程内调用，无竞态）。"""
    _pending.setdefault(map_id, []).append(detail)


def drain_pending(map_id: int) -> list[str]:
    """取走并清空该图的全部待通知改动。"""
    return _pending.pop(map_id, [])
