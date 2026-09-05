"""POST /api/uploads：扩展名白名单 / 大小上限 / 落盘与相对 URL。

照 test_fold_rest.py 的 ASGITransport 模式（不起真服务）。UPLOADS_DIR 是模块级
Path，monkeypatch 属性即可重定向落盘（mount 的 StaticFiles 绑定原目录，但本测试
只打 POST 端点不验静态回显）。
"""
import httpx
import pytest
from httpx import ASGITransport, AsyncClient

from src import uploads
from src.main import app

# 1x1 透明 PNG
_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082"
)


async def _post(name: str, content: bytes) -> httpx.Response:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.post("/api/uploads", files={"file": (name, content, "image/png")})


@pytest.mark.asyncio
async def test_upload_png_writes_file_and_returns_relative_url(tmp_path, monkeypatch):
    monkeypatch.setattr(uploads, "UPLOADS_DIR", tmp_path)
    resp = await _post("截图.png", _PNG)
    assert resp.status_code == 200
    url = resp.json()["url"]
    assert url.startswith("/uploads/") and url.endswith(".png")
    saved = tmp_path / url.rsplit("/", 1)[-1]
    assert saved.read_bytes() == _PNG


@pytest.mark.asyncio
async def test_upload_rejects_disallowed_extension(tmp_path, monkeypatch):
    monkeypatch.setattr(uploads, "UPLOADS_DIR", tmp_path)
    resp = await _post("evil.svg", b"<svg onload=alert(1)>")
    assert resp.status_code == 400
    assert "svg" in resp.json()["detail"] or "类型" in resp.json()["detail"]
    # 扩展名大小写不敏感绕过也不行
    assert (await _post("evil.PNG.bak", b"x")).status_code == 400


@pytest.mark.asyncio
async def test_upload_rejects_oversize(tmp_path, monkeypatch):
    monkeypatch.setattr(uploads, "UPLOADS_DIR", tmp_path)
    resp = await _post("big.png", b"\x89PNG" + b"0" * (10 * 1024 * 1024 + 1))
    assert resp.status_code == 413


@pytest.mark.asyncio
async def test_upload_rejects_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(uploads, "UPLOADS_DIR", tmp_path)
    resp = await _post("empty.png", b"")
    assert resp.status_code == 400
