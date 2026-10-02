"""备注图片上传 —— Vditor 编辑器的 upload.handler 后端。

落点三态兼容（照抄 CHAT_SESSIONS_DIR 模式）：
- 开发/服务：cwd/var/uploads（默认）
- Docker：named volume 挂 /app/var
- 桌面版：desktop.py 在 import 本模块前 setdefault MINDMAPX_UPLOADS_DIR
  → 用户数据目录（platformdirs），与 DB/会话同域

按 map 分目录（2026-09-26）：带 map_id 上传 → var/uploads/<map_id>/<uuid>.<ext>，
各图文件互不混住；不带的（历史调用形态）落根目录，旧文件/旧 URL 原地不动
（StaticFiles 递归服务子目录，天然兼容）。

返回相对 URL（/uploads/<map_id>/<name>）——项目既定架构：前端全相对路径，
桌面版随机端口下天然同源。备注里存的也是相对 URL（换域名/端口不失效）。

安全边界：扩展名白名单 + 大小上限；排除 svg（StaticFiles 直出
image/svg+xml 时内嵌脚本在同源上下文可执行，收益不抵风险）。
"""
import os
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

router = APIRouter()

UPLOADS_DIR = Path(os.getenv("MINDMAPX_UPLOADS_DIR", "var/uploads"))
_EXT_ALLOW = {"png", "jpg", "jpeg", "gif", "webp", "bmp"}
_MAX_BYTES = 10 * 1024 * 1024  # 与 Vditor upload.max 对齐


@router.post("/api/uploads")
async def upload_image(
    file: UploadFile = File(...),
    map_id: int | None = Form(None),  # 按 map 分目录；None = 根目录（兼容旧形态）
) -> dict:
    ext = (file.filename or "").rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else ""
    if ext not in _EXT_ALLOW:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的图片类型 .{ext}（允许：{'/'.join(sorted(_EXT_ALLOW))}）",
        )
    data = await file.read()
    if len(data) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail="图片超过 10MB 上限")
    if not data:
        raise HTTPException(status_code=400, detail="空文件")

    name = f"{uuid.uuid4().hex[:12]}.{ext}"
    sub = UPLOADS_DIR if map_id is None else UPLOADS_DIR / str(map_id)
    sub.mkdir(parents=True, exist_ok=True)
    (sub / name).write_bytes(data)
    base = "" if map_id is None else f"{map_id}/"
    return {"url": f"/uploads/{base}{name}"}
