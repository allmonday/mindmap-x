"""桌面版入口（pywebview 壳 + 进程内 uvicorn）。

用法：python -m src.desktop [--smoke]

架构：单进程 = 主线程 GUI + daemon 线程 HTTP 服务（127.0.0.1:port）。
REST / WS / MCP 协议零改动——前端全相对路径，外部 MCP 客户端连
http://127.0.0.1:{port}/mcp（端口显示在窗口标题栏）。

执行顺序是正确性约束：DATABASE_URL / DATABASE_URL_SYNC / SELF_MCP_URL /
CHAT_SESSIONS_DIR / CHAT_ARCHIVE_DIR 五个环境变量在 src.db / src.chat 的
import 时刻被模块级冻结，必须在延迟 import src.main 之前全部就位。
"""
from __future__ import annotations

import fcntl
import logging
import os
import socket
import sys
import threading
import time
import urllib.request
from logging.handlers import RotatingFileHandler
from pathlib import Path

from platformdirs import user_data_dir

PREFERRED_PORT = 8740  # 与 README 的 MCP 文档地址一致；被占则降级随机端口

# 桌面版数据一律落用户数据目录（DB / 会话 / 归档 / .env / 日志），env 用于覆盖（CI smoke）
DATA_DIR = Path(os.getenv("MINDMAPX_DATA_DIR") or user_data_dir("MindMapX", appauthor=False))

_lock_file = None  # 持引用防 GC 关闭，锁随进程退出自动释放


def _setup_logging() -> None:
    """windowed 模式无控制台，desktop.log 是唯一排障通道。"""
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    handler = RotatingFileHandler(
        DATA_DIR / "desktop.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s [%(name)s] %(message)s"))
    root.addHandler(handler)


def _acquire_single_instance_lock() -> bool:
    global _lock_file  # fd 必须存活于进程生命周期，否则 GC 关闭即失锁
    _lock_file = open(DATA_DIR / ".lock", "w")
    try:
        fcntl.flock(_lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


def _pick_port() -> int:
    """优先固定端口，被占则由 OS 分配空闲端口。

    bind 探测与 uvicorn 实际监听之间有极小竞态窗口，内部分发可接受；
    真撞上时 uvicorn 启动失败会写入 desktop.log。
    """
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", PREFERRED_PORT))
            return PREFERRED_PORT
        except OSError:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]


def _load_env_file(path: Path) -> None:
    """极简 .env 解析，语义与 src.chat._load_dotenv 一致：不覆盖已有环境变量。"""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _resource_path(rel: str) -> Path:
    """打包资源定位：frozen 走 _MEIPASS（spec datas 落点），源码走仓库根。"""
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    return base / rel


def _run_migrations() -> None:
    """编程式 alembic upgrade head（无 ini；env.py 读 DATABASE_URL_SYNC env）。"""
    from alembic import command
    from alembic.config import Config

    cfg = Config()
    cfg.set_main_option("script_location", str(_resource_path("alembic")))
    cfg.set_main_option("sqlalchemy.url", os.environ["DATABASE_URL_SYNC"])
    command.upgrade(cfg, "head")


def _wait_http_ready(url: str, timeout: float = 30.0) -> None:
    """轮询探活而非依赖 server.started 内部标志——顺便验证整条 HTTP 栈可用。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if resp.status == 200:
                    return
        except OSError:
            pass
        time.sleep(0.1)
    raise SystemExit(f"server not ready within {timeout}s: {url}")


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _setup_logging()
    log = logging.getLogger("mindmap.desktop")

    if not _acquire_single_instance_lock():
        import webview

        log.warning("another instance is already running")
        webview.create_window(
            "MindMap X", html="<p>MindMap X is already running.</p>", width=360, height=160
        )
        webview.start()
        os._exit(0)

    port = _pick_port()

    # ── 环境变量先于一切 src.* import（见模块 docstring）──────────────
    db_posix = (DATA_DIR / "mindmap.db").as_posix()
    os.environ.setdefault("DATABASE_URL", f"sqlite+aiosqlite:///{db_posix}")
    os.environ.setdefault("DATABASE_URL_SYNC", f"sqlite:///{db_posix}")
    os.environ.setdefault("CHAT_SESSIONS_DIR", str(DATA_DIR / "sessions"))
    os.environ.setdefault("CHAT_ARCHIVE_DIR", str(DATA_DIR / "chat_history"))
    # 端口运行时才确定，强制覆盖——.env 里的 SELF_MCP_URL 只会对着错误端口
    os.environ["SELF_MCP_URL"] = f"http://127.0.0.1:{port}/mcp/"
    # 桌面模式标记：chat health 接口透传给前端，配置指引文案按模式指向数据目录
    os.environ["MINDMAPX_DESKTOP"] = "1"

    _load_env_file(DATA_DIR / ".env")

    _run_migrations()

    import uvicorn

    from src.main import app

    # loop/ws 显式指定：消除 uvicorn 的 auto 字符串动态 import 分支，减小打包盲区
    # log_config=None：uvicorn 日志冒泡到 root，统一落 desktop.log
    config = uvicorn.Config(
        app, host="127.0.0.1", port=port, loop="asyncio", ws="websockets-sansio", log_config=None
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True, name="uvicorn")
    thread.start()

    base = f"http://127.0.0.1:{port}"
    _wait_http_ready(f"{base}/docs")

    if "--smoke" in sys.argv:  # CI 产物自检：迁移 + 起服 + 探活，退出码即结果
        log.info("smoke ok: %s", base)
        server.should_exit = True
        thread.join(timeout=10)
        os._exit(0)

    import webview

    # 标题栏是 MCP 端口的零成本展示位：claude mcp add http://127.0.0.1:{port}/mcp
    webview.create_window(
        f"MindMap X — MCP :{port}",
        f"{base}/",
        width=1440,
        height=900,
        min_size=(960, 600),
    )
    webview.start()  # 阻塞主线程直到窗口关闭（GUI 必须在主线程）

    server.should_exit = True
    thread.join(timeout=10)
    os._exit(0)  # strands/httpx/pywebview 的残留线程会挂住普通退出


if __name__ == "__main__":
    main()
