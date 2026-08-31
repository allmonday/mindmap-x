# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec：macOS 桌面应用（onedir + .app bundle）。

datas 落点与运行时定位对齐：
- src/static  → _MEIPASS/src/static（src/main.py 用 __file__ 定位）
- alembic/*   → _MEIPASS/alembic/（src/desktop.py 用 _MEIPASS 定位 script_location；
                versions/*.py 由 alembic ScriptDirectory 从磁盘读取，作数据文件即可）
"""
import tomllib
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

# 版本唯一事实源：pyproject.toml 的 project.version（写入 .app 的 Info.plist）
VERSION = tomllib.loads((Path(SPECPATH) / "pyproject.toml").read_text())["project"]["version"]

datas = [
    ("alembic/env.py", "alembic"),
    ("alembic/versions", "alembic/versions"),
    ("src/static", "src/static"),
]

# 包内数据文件（voyager 的 web 静态资源等）不会随 import 分析收集，必须显式收
datas += collect_data_files("nexusx")
datas += collect_data_files("strands")

# 运行时 importlib.metadata 查版本的库（fastmcp/fastapi 等在 import 期就查），frozen 环境必须显式携带 dist-info；
# agent-mindmap 是本项目（src/main.py 的 FastAPI version 读它）
for _pkg in (
    "agent-mindmap", "fastmcp", "nexusx", "strands-agents", "fastapi", "uvicorn",
    "starlette", "pydantic", "sqlalchemy", "sqlmodel", "alembic", "aiosqlite",
    "greenlet", "pywebview", "platformdirs",
):
    datas += copy_metadata(_pkg)

hiddenimports = [
    "webview.platforms.cocoa",  # pywebview 按 sys.platform 字符串选 gui 后端
    *collect_submodules("uvicorn"),  # loop / ws 实现按字符串动态选择
    # sqlalchemy dialect 由 URL 字符串在运行时解析加载，静态分析不可见
    "sqlalchemy.dialects.sqlite.aiosqlite",
    "aiosqlite",
    "greenlet",
]

a = Analysis(
    ["src/desktop.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="MindMapX",
    console=False,  # windowed：无终端（日志落数据目录 desktop.log）
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="MindMapX")

app = BUNDLE(coll, name="MindMapX.app", version=VERSION, console=False)  # icon 后续可加（favicon.svg 转 .icns）
