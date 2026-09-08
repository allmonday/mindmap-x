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
