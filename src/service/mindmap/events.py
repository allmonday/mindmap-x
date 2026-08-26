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


def publish_change(map_id: int, version: int, action: str, actor: str) -> None:
    """脑图发生 mutation 后广播。action 如 'node_added' / 'outline_applied'。"""
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
