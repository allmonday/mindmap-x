"""delete_map 软删除语义。

回归背景：硬删 + SQLite rowid 复用 max(id) 曾让新建图读到上一个图
（同 id）的聊天历史。软删除行占住 rowid，id 永不复用；对外表现与
硬删一致（列表不见、get_map not found）；数据保留可手工恢复。
"""
import os

import pytest
import src.chat as chat
from src.models import Map
import src.service.mindmap.methods as mm

# conftest 的 session_factory/seeded_map：map_id=100 的图
MAP_ID = 100


def _make_chat_data(sessions_dir: str, archive_dir: str) -> None:
    session_dir = os.path.join(sessions_dir, f"session_mindmap-map{MAP_ID}")
    os.makedirs(os.path.join(session_dir, "agents"), exist_ok=True)
    archive_dir = os.path.join(archive_dir, f"map{MAP_ID}")
    os.makedirs(archive_dir, exist_ok=True)
    with open(os.path.join(archive_dir, "chat_20260830-000000.json"), "w") as f:
        f.write('{"id": "chat_20260830-000000", "messages": []}')


async def test_delete_map_is_soft_and_hidden(session_factory, seeded_map):
    """删除后：DB 行保留（deleted_at 非空）、对外 not found、列表不出现。"""
    assert await mm.delete_map(MAP_ID) is True

    async with session_factory() as s:
        m = await s.get(Map, MAP_ID)  # 行还在
        assert m is not None and m.deleted_at is not None
    with pytest.raises(ValueError, match="not found"):
        await mm.get_map(MAP_ID)
    assert all(x.id != MAP_ID for x in await mm.list_maps())


async def test_delete_map_keeps_chat_data(session_factory, seeded_map, tmp_path, monkeypatch):
    """软删不清理聊天数据：会话/归档保留（恢复时对话还在）。"""
    sessions = str(tmp_path / "sessions")
    archives = str(tmp_path / "archives")
    monkeypatch.setattr(chat, "SESSIONS_DIR", sessions)
    monkeypatch.setattr(chat, "ARCHIVE_DIR", archives)
    _make_chat_data(sessions, archives)

    await mm.delete_map(MAP_ID)

    assert os.path.exists(os.path.join(sessions, f"session_mindmap-map{MAP_ID}"))
    assert os.path.exists(os.path.join(archives, f"map{MAP_ID}"))


async def test_map_id_never_reused_after_soft_delete(session_factory, seeded_map):
    """删除 max id 图后新建：拿到新 id（rowid 被软删行占住，不复用）。"""
    assert await mm.delete_map(MAP_ID) is True  # 100 是 conftest 里的 max id
    m = await mm.create_map("新图")
    assert m.id is not None and m.id > MAP_ID
