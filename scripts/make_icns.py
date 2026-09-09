"""重新生成 assets/MindMapX.icns（圆角外透明）。

背景：旧 icns 由 macOS qlmanage 渲染 SVG 生成——qlmanage 把圆角外的
透明区域填成纯白（实测角像素 (255,255,255,255)），系统圆角遮罩外露出
白底边。本脚本改用 Chromium（Playwright，omitBackground）渲染 SVG 为
透明 PNG，再缩放各尺寸拼 icns 容器（PNG-based entries），跨平台可跑。

用法（项目根）：
  UV_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
  LD_LIBRARY_PATH=$HOME/.local/opt/nss-libs/usr/lib \
  uv run --with playwright --with pillow python scripts/make_icns.py
"""
import struct
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SVG = ROOT / "assets" / "app-icon.svg"
OUT_ICNS = ROOT / "assets" / "MindMapX.icns"
RENDER = 1024

# icns PNG-based 条目（type → 边长 px；@2x 变体与基准尺寸共用图像）
ENTRIES = [
    (b"ic10", 1024),  # 512@2x / 1024
    (b"ic09", 512),
    (b"ic14", 512),  # 256@2x
    (b"ic08", 256),
    (b"ic13", 256),  # 128@2x
    (b"ic07", 128),
    (b"ic12", 64),  # 32@2x
    (b"ic11", 32),  # 16@2x
]


def render_transparent_png() -> bytes:
    """Chromium 渲染 SVG → 透明背景 PNG（圆角外 alpha=0）。"""
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
        page = b.new_context(viewport={"width": RENDER, "height": RENDER}, device_scale_factor=1)
        p2 = page.new_page()
        p2.goto(SVG.as_uri())
        p2.wait_for_timeout(300)
        png = p2.screenshot(omit_background=True)  # 页面背景透明 → SVG 透明区保留
        b.close()
    return png


def main() -> None:
    base = Image.open(__import__("io").BytesIO(render_transparent_png())).convert("RGBA")
    base = base.resize((RENDER, RENDER), Image.LANCZOS)

    # 角像素自检：圆角外必须透明（不透明则后续全部白边，直接失败）
    for x, y in [(1, 1), (RENDER - 2, 1), (1, RENDER - 2), (RENDER - 2, RENDER - 2)]:
        r, g, bb, a = base.getpixel((x, y))
        assert a == 0, f"角像素不透明 {(x, y)}: {(r, g, bb, a)}——渲染管线又丢了透明"

    chunks = [b"icns"]
    body = b""
    import io as _io

    for icon_type, size in ENTRIES:
        im = base.resize((size, size), Image.LANCZOS)
        buf = _io.BytesIO()
        im.save(buf, "PNG", optimize=True)
        png = buf.getvalue()
        body += icon_type + struct.pack(">I", len(png) + 8) + png
    chunks.append(struct.pack(">I", len(body) + 8))
    OUT_ICNS.write_bytes(b"".join(chunks) + body)
    print(f"written {OUT_ICNS} ({OUT_ICNS.stat().st_size}B, {len(ENTRIES)} entries, corners transparent)")


if __name__ == "__main__":
    main()
