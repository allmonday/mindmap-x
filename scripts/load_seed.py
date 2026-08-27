"""一次性把 var/seed_data.json 灌入文件 DB（保留 ID 和时间戳）。

用法：uv run python scripts/load_seed.py [--force]
  --force: 清空现有 map/node 表后再灌入（默认：已有数据时跳过）

走同步 sqlite 驱动（与 alembic 一致），不依赖 async 事件循环。
"""
import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

# 保证从任意 cwd 都能 import src.*
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import create_engine, text
from sqlmodel import Session

from src.models import Map, Node

DB_PATH = os.getenv("DATABASE_URL_SYNC", "sqlite:///./var/mindmap.db")
SEED_PATH = Path(__file__).resolve().parent.parent / "var" / "seed_data.json"


def parse_dt(value: str) -> datetime:
    return datetime.fromisoformat(value)


def main() -> None:
    parser = argparse.ArgumentParser(description="Load mock seed data into file DB")
    parser.add_argument("--force", action="store_true", help="清空现有 map/node 后再灌入")
    args = parser.parse_args()

    if not SEED_PATH.exists():
        print(f"seed 文件不存在: {SEED_PATH}")
        sys.exit(1)

    data = json.loads(SEED_PATH.read_text(encoding="utf-8"))

    # SQLite 建文件时不会自动创建父目录
    db_file = DB_PATH.split("///")[-1]
    os.makedirs(os.path.dirname(db_file) or ".", exist_ok=True)

    engine = create_engine(DB_PATH, echo=False)

    with Session(engine) as session:
        existing = session.exec(text("select count(*) from map")).one()
        count = existing[0] if isinstance(existing, tuple) else existing
        if count and not args.force:
            print(f"DB 已有 {count} 条 map 记录，跳过灌入（使用 --force 强制覆盖）")
            return
        if args.force and count:
            session.exec(text("delete from node"))
            session.exec(text("delete from map"))
            session.commit()

        for m in data["maps"]:
            session.add(
                Map(
                    id=m["id"],
                    title=m["title"],
                    version=m["version"],
                    created_at=parse_dt(m["created_at"]),
                )
            )
        for n in data["nodes"]:
            session.add(
                Node(
                    id=n["id"],
                    display_id=n["display_id"],
                    map_id=n["map_id"],
                    parent_id=n["parent_id"],
                    content=n["content"],
                    position=n["position"],
                    collapsed=n["collapsed"],
                    updated_by=n["updated_by"],
                    updated_at=parse_dt(n["updated_at"]),
                )
            )
        session.commit()

        # 说明：SQLModel 整型主键是普通 rowid 别名（无 AUTOINCREMENT），
        # 新行 id = max(id)+1，显式插入 seed 后自动增不会与 seed id 冲突，无需重置序列。

    print(f"seed 灌入完成: {len(data['maps'])} maps, {len(data['nodes'])} nodes -> {DB_PATH}")


if __name__ == "__main__":
    main()
