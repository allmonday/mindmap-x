"""页内 Agent 空闲超时语义：流式输出不断则永不触发；静默超限才放弃。

回归背景：旧实现用 asyncio.timeout(AGENT_TIMEOUT_S) 包全程 = 总时长上限，
长任务哪怕持续健康输出也会在 180s 被砍。改为空闲计时：delta/reasoning
到达即重置 last_activity。
"""
import asyncio
import json

import pytest
from fastapi.testclient import TestClient

import src.chat as chat


@pytest.fixture
def ws_client(monkeypatch):
    """入口探活置绿 + MCP 指向黑洞（连接挂起 → 无任何流式输出）。"""
    monkeypatch.setattr(chat, "health_check", lambda: async_ok())
    monkeypatch.setattr(chat, "AGENT_TIMEOUT_S", 1.5)
    monkeypatch.setattr(chat, "SELF_MCP_URL", "http://10.255.255.1:9/mcp/")

    from src.main import app

    with TestClient(app) as client:
        yield client


async def async_ok() -> dict:
    return {"ok": True, "checks": {"gateway": True, "mcp": True}}


def test_idle_timeout_fires_when_no_output(ws_client):
    """MCP 连接黑洞 → 工作线程挂起无输出 → 1.5s 空闲超时 error（非 done）。"""
    with ws_client.websocket_connect("/chat/15") as ws:
        ws.receive_text()  # status
        ws.send_text(json.dumps({"type": "user", "text": "hi"}))
        terminal = None
        for _ in range(20):
            msg = json.loads(ws.receive_text())
            if msg.get("type") == "error":
                terminal = msg
                break
            if msg.get("type") == "done":
                terminal = msg
                break
        assert terminal is not None, "20 条消息内无终态"
        assert terminal["type"] == "error"
        assert "空闲" in terminal["message"]
