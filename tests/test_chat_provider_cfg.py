"""Provider 配置（文件 > env）核心语义：合并优先级、来源标签、模型工厂、health_check 接线。

回归背景：health_check 旧实现只认 env（os.getenv 三连），文件配置存在时仍会
短路 env_missing——本文件锁定"文件配置可达网关探测"这一层。
"""
import asyncio
import json

import pytest

import src.chat as chat

_ENV_VARS = ("OPENAI_BASE_URL", "OPENAI_API_KEY", "AGENT_MODEL", "OPENAI_MODEL", "AGENT_PROVIDER")


@pytest.fixture(autouse=True)
def _isolated_env(monkeypatch, tmp_path):
    """清空真实 env（import 时 _load_dotenv 已把 .env 灌入）+ 配置文件指到 tmp。"""
    for var in _ENV_VARS:
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(chat, "PROVIDER_CFG_PATH", str(tmp_path / "provider.json"))


def _write_cfg(tmp_path, **fields) -> None:
    """模拟真实落盘文件形态（_write_provider_cfg 会附 updated_at）。"""
    fields.setdefault("updated_at", "2026-09-09T00:00:00+00:00")
    (tmp_path / "provider.json").write_text(json.dumps(fields), encoding="utf-8")


# ── 合并优先级 ─────────────────────────────────────────────────────────


def test_file_overrides_env(monkeypatch, tmp_path):
    _write_cfg(
        tmp_path,
        provider_type="anthropic",
        base_url="https://file.example/v1",
        api_key="sk-file-key",
        model="claude-file",
    )
    # 模拟部署 env；文件应逐字段赢
    monkeypatch.setenv("OPENAI_BASE_URL", "https://env.example/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env-key")
    monkeypatch.setenv("AGENT_MODEL", "env-model")
    cfg = chat._effective_provider_cfg()
    assert cfg == {
        "provider_type": "anthropic",
        "base_url": "https://file.example/v1",
        "api_key": "sk-file-key",
        "model": "claude-file",
    }


def test_no_file_falls_back_to_env(monkeypatch):
    monkeypatch.setenv("OPENAI_BASE_URL", "https://env.example/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env-key")
    monkeypatch.setenv("AGENT_MODEL", "env-model")
    cfg = chat._effective_provider_cfg()
    assert cfg["base_url"] == "https://env.example/v1"
    assert cfg["api_key"] == "sk-env-key"
    assert cfg["model"] == "env-model"
    assert cfg["provider_type"] == "openai"  # 默认


def test_corrupt_file_falls_back_to_env(monkeypatch, tmp_path):
    (tmp_path / "provider.json").write_text("{not json", encoding="utf-8")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://env.example/v1")
    cfg = chat._effective_provider_cfg()  # 不抛：损坏 = 无文件
    assert cfg["base_url"] == "https://env.example/v1"
    assert chat._cfg_source(cfg) == "env"  # 损坏文件不算 file 来源


def test_partial_file_merged_fieldwise(monkeypatch, tmp_path):
    """文件只配 model → 其余字段 env 补齐（逐字段覆盖，非整文件替换）。"""
    _write_cfg(tmp_path, model="file-model")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://env.example/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env-key")
    cfg = chat._effective_provider_cfg()
    assert cfg["model"] == "file-model"
    assert cfg["base_url"] == "https://env.example/v1"
    assert cfg["api_key"] == "sk-env-key"


def test_provider_type_env_var(monkeypatch):
    monkeypatch.setenv("AGENT_PROVIDER", "anthropic")
    assert chat._effective_provider_cfg()["provider_type"] == "anthropic"
    monkeypatch.setenv("AGENT_PROVIDER", "bogus")  # 非法值回退默认
    assert chat._effective_provider_cfg()["provider_type"] == "openai"


def test_invalid_file_provider_type_dropped(tmp_path):
    _write_cfg(tmp_path, provider_type="bogus", model="m")
    cfg = chat._effective_provider_cfg()
    assert cfg["provider_type"] == "openai"
    assert cfg["model"] == "m"


# ── 模型工厂（生产与探测共用路径） ────────────────────────────────────


def test_build_model_branches():
    openai_m = chat._build_model(
        {"provider_type": "openai", "base_url": "https://x/v1", "api_key": "k", "model": "gpt"}
    )
    assert type(openai_m).__name__ == "OpenAIModel"

    anth_m = chat._build_model(
        {"provider_type": "anthropic", "base_url": "https://x", "api_key": "k", "model": "claude"}
    )
    assert type(anth_m).__name__ == "AnthropicModel"
    assert anth_m.config["max_tokens"] == 8192  # AnthropicConfig 必填项的默认补值


def test_build_model_probe_timeout_injected():
    """timeout_s 只进探测路径的 client_args；strands 1.53.0 OpenAIModel 惰性建 client。"""
    args = chat._client_args(
        {"provider_type": "openai", "base_url": "https://x/v1", "api_key": "k", "model": "gpt"},
        timeout_s=5,
    )
    assert args["timeout"] == 5
    m = chat._build_model(
        {"provider_type": "openai", "base_url": "https://x/v1", "api_key": "k", "model": "gpt"}
    )
    assert m.client_args == {"base_url": "https://x/v1", "api_key": "k"}  # 运行时不带探测超时


# ── health_check 接线（文件配置可达探测，不短路 env_missing） ──────────


class _FakeResp:
    status_code = 200


class _FakeHttpClient:
    """httpx.AsyncClient 替身：MCP initialize 探测恒 200。"""

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, *args, **kwargs):
        return _FakeResp()


def test_health_check_uses_file_cfg(monkeypatch, tmp_path):
    """无 env + 仅文件配置：不再短路 env_missing，gateway 探测被真实调用。"""
    _write_cfg(
        tmp_path,
        provider_type="openai",
        base_url="https://file.example/v1",
        api_key="sk-file-key-123456",
        model="file-model",
    )

    probed = {}

    async def fake_probe(cfg):
        probed.update(cfg)
        return True, None, {}, False

    monkeypatch.setattr(chat, "_probe_gateway", fake_probe)
    monkeypatch.setattr(chat.httpx, "AsyncClient", _FakeHttpClient)

    status = asyncio.run(chat.health_check())

    assert status["reason_code"] != "env_missing"  # 旧实现此处直接 env_missing
    assert status["checks"]["gateway"] is True
    assert status["ok"] is True
    assert status["source"] == "file"
    assert probed["base_url"] == "https://file.example/v1"  # 探测吃到的是文件值
    assert probed["api_key"] == "sk-file-key-123456"


def test_health_check_env_missing_when_nowhere(monkeypatch):
    async def fail_probe(cfg):  # 不该被调用
        raise AssertionError("probe must not run when config missing")

    monkeypatch.setattr(chat, "_probe_gateway", fail_probe)
    monkeypatch.setattr(chat.httpx, "AsyncClient", _FakeHttpClient)

    status = asyncio.run(chat.health_check())

    assert status["ok"] is False
    assert status["reason_code"] == "env_missing"
    assert status["source"] == "none"


# ── REST 端点（GET/PUT/DELETE /api/chat/config） ──────────────────────


@pytest.fixture
def api():
    """裸 TestClient（不用 with）：mcp_http 的 lifespan 全进程只许 run 一次，
    已被字母序更早的 test_chat_idle_timeout 消耗；这些端点也不依赖 lifespan。"""
    from fastapi.testclient import TestClient

    from src.main import app

    return TestClient(app)


def _ok_probe(monkeypatch, ids=("some-model",)):
    async def fake_probe(cfg):
        return True, None, {}, cfg["model"] not in (ids or ())

    monkeypatch.setattr(chat, "_probe_gateway", fake_probe)


def test_get_masks_key_and_reports_source(monkeypatch, tmp_path, api):
    _write_cfg(
        tmp_path,
        provider_type="openai",
        base_url="https://file.example/v1",
        api_key="sk-secret-key-1234",
        model="m",
    )
    body = api.get("/api/chat/config").json()
    assert body["api_key_masked"] == "***1234"
    assert "sk-secret-key-1234" not in body["api_key_masked"]  # 明文永不出服务端
    assert body["source"] == "file"
    assert body["configured"] is True
    assert body["updated_at"]  # 文件回显带更新时间


def test_put_empty_key_keeps_old(tmp_path, api, monkeypatch):
    _ok_probe(monkeypatch)  # 默认清单不含 new-model → 顺带验证 model_unverified
    api.put(
        "/api/chat/config",
        json={"provider_type": "openai", "base_url": "https://x/v1", "api_key": "sk-old-key-9999", "model": "m"},
    )
    # 空 key：保持旧值
    r1 = api.put(
        "/api/chat/config",
        json={"base_url": "https://y/v1", "api_key": "", "model": "new-model"},
    )
    assert r1.status_code == 200
    assert r1.json()["model_unverified"] is True  # list 里没有 new-model → 软提示
    # 掩码回显值：同样保持旧值
    r2 = api.put(
        "/api/chat/config",
        json={"base_url": "https://z/v1", "api_key": "***9999", "model": "m"},
    )
    assert r2.status_code == 200
    saved = json.loads((tmp_path / "provider.json").read_text())
    assert saved["api_key"] == "sk-old-key-9999"
    assert saved["base_url"] == "https://z/v1"  # rstrip("/") 归一
    assert saved["provider_type"] == "openai"


def test_put_success_writes_file_with_0600(tmp_path, api, monkeypatch):
    _ok_probe(monkeypatch)
    r = api.put(
        "/api/chat/config",
        json={
            "provider_type": "anthropic",
            "base_url": "https://api.anthropic.com/",
            "api_key": "sk-ant-key-abcd",
            "model": "claude-sonnet-4-5",
        },
    )
    assert r.status_code == 200
    path = tmp_path / "provider.json"
    saved = json.loads(path.read_text())
    assert saved["provider_type"] == "anthropic"
    assert saved["base_url"] == "https://api.anthropic.com"  # 尾斜杠归一
    assert saved["updated_at"]
    assert path.stat().st_mode & 0o777 == 0o600


def test_put_rejected_when_no_old_key(tmp_path, api, monkeypatch):
    _ok_probe(monkeypatch)
    r = api.put(
        "/api/chat/config",
        json={"base_url": "https://x/v1", "api_key": "", "model": "m"},
    )
    assert r.status_code == 400  # 无旧值可保
    assert not (tmp_path / "provider.json").exists()


def test_put_probe_failure_rejects_without_writing(tmp_path, api, monkeypatch):
    async def bad_probe(cfg):
        return False, "gateway_http", {"status": 401}, False

    monkeypatch.setattr(chat, "_probe_gateway", bad_probe)
    r = api.put(
        "/api/chat/config",
        json={"base_url": "https://x/v1", "api_key": "sk-k", "model": "m"},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["reason_code"] == "gateway_http"  # 前端 gateReasonText 可渲染
    assert not (tmp_path / "provider.json").exists()


def test_delete_falls_back_to_env_then_none(monkeypatch, tmp_path, api):
    _write_cfg(tmp_path, base_url="https://file/v1", api_key="sk-file-key", model="m")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://env.example/v1")

    body = api.delete("/api/chat/config").json()
    assert not (tmp_path / "provider.json").exists()
    assert body["source"] == "env"
    assert body["base_url"] == "https://env.example/v1"

    monkeypatch.delenv("OPENAI_BASE_URL")
    body2 = api.get("/api/chat/config").json()
    assert body2["source"] == "none"
    assert body2["configured"] is False


# ── WS：文件配置喂到工作线程（不因 cfg 读取炸） ────────────────────────


def test_ws_user_message_with_file_cfg(monkeypatch, tmp_path, api):
    """无 env、仅文件配置：user 消息能过 cfg 完整性检查，挂在 MCP 连接而非配置。"""
    _write_cfg(
        tmp_path,
        provider_type="openai",
        base_url="https://file.example/v1",
        api_key="sk-file-key",
        model="file-model",
    )
    monkeypatch.setattr(chat, "health_check", lambda: _async_status_ok())
    monkeypatch.setattr(chat, "SELF_MCP_URL", "http://10.255.255.1:9/mcp/")  # 黑洞：连接挂起
    monkeypatch.setattr(chat, "AGENT_TIMEOUT_S", 1.5)

    with api.websocket_connect("/chat/15") as ws:
        ws.receive_text()  # status
        ws.send_text(json.dumps({"type": "user", "text": "hi"}))
        terminal = None
        for _ in range(20):
            msg = json.loads(ws.receive_text())
            if msg.get("type") in ("error", "done"):
                terminal = msg
                break
        assert terminal is not None, "20 条消息内无终态"
        # 配置缺失会报 "provider config incomplete"；此处必须是空闲超时——
        # 证明工作线程吃到了文件配置并正常走到 MCP 连接
        assert terminal["type"] == "error"
        assert "provider config" not in terminal["message"]


async def _async_status_ok() -> dict:
    return {"ok": True, "checks": {"gateway": True, "mcp": True}}
