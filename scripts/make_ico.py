"""生成 assets/MindMapX.ico（多尺寸透明，Windows exe 图标）。

与 make_icns.py 同源：Chromium omitBackground 渲染 SVG 为透明 PNG，
PIL 缩放出 ICO 标准尺寸集（16/24/32/48/64/128/256）。角透明自检同款。

用法（项目根）：
  UV_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
  LD_LIBRARY_PATH=$HOME/.local/opt/nss-libs/usr/lib \
  uv run --with playwright --with pillow python scripts/make_ico.py
"""
import io
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SVG = ROOT / "assets" / "app-icon.svg"
OUT_ICO = ROOT / "assets" / "MindMapX.ico"
RENDER = 1024
SIZES = [16, 24, 32, 48, 64, 128, 256]


def main() -> None:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
        page = b.new_context(viewport={"width": RENDER, "height": RENDER}).new_page()
        page.goto(SVG.as_uri())
        page.wait_for_timeout(300)
        png = page.screenshot(omit_background=True)
        b.close()

    base = Image.open(io.BytesIO(png)).convert("RGBA").resize((RENDER, RENDER), Image.LANCZOS)
    for x, y in [(1, 1), (RENDER - 2, 1), (1, RENDER - 2), (RENDER - 2, RENDER - 2)]:
        assert base.getpixel((x, y))[3] == 0, f"角像素不透明 {(x, y)}——渲染管线丢了透明"

    base.save(OUT_ICO, format="ICO", sizes=[(s, s) for s in SIZES])
    print(f"written {OUT_ICO} ({OUT_ICO.stat().st_size}B, sizes={SIZES}, corners transparent)")


if __name__ == "__main__":
    main()
