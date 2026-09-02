"""MVCC 节点版本表原型 —— 等价性验证 + 存储基准（独立模块，不接入业务）。

背景
----
map_revision.snapshot 现在每版本存整树明文 JSON（实测全库 1.13 MB / 225 条，
DDD 图树 1.5 KB → 历史 104 KB，约 70× 放大）。候选替代方案：

    node_revision 表只在节点变化时写一行自己的新状态（含墓碑），
    任意版本用窗口函数物化整树——无重放、无 checkpoint、天然 append。

验证方法（零侵入）
------------------
ground truth = 现有 map_revision 的快照序列（真实库 or 合成序列）；
MVCC 行 = 相邻快照按 display_id 对齐的节点级 diff（insert/update/墓碑）；
等价性 = 对每个 v：materialize(v)["nodes"] == snapshot(v)["nodes"]。

合成序列额外覆盖两个已知语义坑：
  1. display_id 重用（replace 重排：#2 的内容换成另一个逻辑节点）
  2. 节点消失再出现（delete → restore 重建同号）

用法
----
    uv run python scripts/mvcc_prototype.py              # 真实库 + 合成 2000 步
    uv run python scripts/mvcc_prototype.py --synth-only # 只跑合成序列
"""
from __future__ import annotations

import argparse
import json
import random
import sqlite3
import tempfile
import time
import zlib
from dataclasses import dataclass
from pathlib import Path

DB = Path(__file__).resolve().parent.parent / "var" / "mindmap.db"
NODE_FIELDS = ("parent", "content", "note", "position", "collapsed", "updated_by", "updated_at")


# ── MVCC 核心：行定义 / diff 生成 / 物化 ────────────────────────────────


@dataclass(frozen=True)
class NodeRevRow:
    map_id: int
    version: int
    display_id: int
    deleted: bool
    parent: int | None
    content: str | None
    note: str | None
    position: int | None
    collapsed: bool | None
    updated_by: str | None
    updated_at: str | None


def _nodes(snap: dict) -> dict[int, dict]:
    return {n["display_id"]: n for n in snap["nodes"]}


def diff_snapshots(map_id: int, prev: dict | None, cur: dict, version: int) -> list[NodeRevRow]:
    """相邻快照 → 节点行。prev=None 表示首版本（全部 insert）。

    按 display_id 对齐（与物化的取数口径一致）：replace 重排导致的
    "同号新内容" 表现为 update 行——物化按最新行还原，树等价性不受影响，
    但节点级历史的语义会混入不同逻辑节点（报告里单列说明）。
    """
    old, new = ({} if prev is None else _nodes(prev)), _nodes(cur)
    rows: list[NodeRevRow] = []

    def row(did: int, n: dict | None, deleted: bool) -> NodeRevRow:
        return NodeRevRow(
            map_id=map_id, version=version, display_id=did, deleted=deleted,
            parent=(n or {}).get("parent"), content=(n or {}).get("content"),
            note=(n or {}).get("note"), position=(n or {}).get("position"),
            collapsed=(n or {}).get("collapsed"), updated_by=(n or {}).get("updated_by"),
            updated_at=(n or {}).get("updated_at"),
        )

    for did, n in new.items():
        o = old.get(did)
        # .get 比较：历史快照缺 key（note 是后加的字段）按 None 归一——
        # MVCC 行 schema 也要面对字段演进，diff 侧宽容、物化侧输出统一形状
        if o is None or any(o.get(f) != n.get(f) for f in NODE_FIELDS):
            rows.append(row(did, n, deleted=False))  # insert / update
    for did in old.keys() - new.keys():
        rows.append(row(did, None, deleted=True))  # 墓碑
    return rows


def materialize_mem(rows: list[NodeRevRow], version: int) -> list[dict]:
    """参考实现：内存物化 ≤version 的整树（每 display_id 取最新行）。"""
    latest: dict[int, NodeRevRow] = {}
    for r in rows:  # rows 按 version 升序
        if r.version <= version:
            latest[r.display_id] = r
    out = []
    for did in sorted(latest):
        r = latest[did]
        if r.deleted:
            continue
        out.append({
            "display_id": did, "parent": r.parent, "content": r.content, "note": r.note,
            "position": r.position, "collapsed": r.collapsed,
            "updated_by": r.updated_by, "updated_at": r.updated_at,
        })
    return out


# SQL 物化（工程形态）：把行灌进真表，窗口函数取数，验证 SQLite 路径可行
_DDL = """
CREATE TABLE node_revision (
  map_id INTEGER NOT NULL, version INTEGER NOT NULL, display_id INTEGER NOT NULL,
  deleted INTEGER NOT NULL, parent INTEGER, content TEXT, note TEXT,
  position INTEGER, collapsed INTEGER, updated_by TEXT, updated_at TEXT,
  PRIMARY KEY (map_id, version, display_id)
) WITHOUT ROWID
"""
_SQL_MATERIALIZE = """
SELECT display_id, parent, content, note, position, collapsed, updated_by, updated_at FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY display_id ORDER BY version DESC) rn
  FROM node_revision WHERE map_id=? AND version<=?
) WHERE rn=1 AND deleted=0 ORDER BY display_id
"""


def materialize_sql(conn: sqlite3.Connection, map_id: int, version: int) -> list[dict]:
    return [
        {"display_id": r[0], "parent": r[1], "content": r[2], "note": r[3],
         "position": r[4], "collapsed": bool(r[5]), "updated_by": r[6], "updated_at": r[7]}
        for r in conn.execute(_SQL_MATERIALIZE, (map_id, version))
    ]


# ── 验证与基准 ─────────────────────────────────────────────────────────


def verify(map_id: int, snaps: list[tuple[int, dict]], label: str) -> list[NodeRevRow]:
    """逐版本断言 物化 == 快照（内存版 + SQLite 版），返回全部行。"""
    rows: list[NodeRevRow] = []
    prev = None
    for version, snap in snaps:  # version 升序
        rows.extend(diff_snapshots(map_id, prev, snap, version))
        prev = snap

    # SQLite 侧行只灌一次，逐版本物化比对
    with tempfile.NamedTemporaryFile(suffix=".db") as f:
        conn = sqlite3.connect(f.name)
        conn.execute(_DDL)
        conn.executemany(
            "INSERT INTO node_revision VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [tuple(r.__dict__.values()) for r in rows],
        )
        for version, snap in snaps:
            expect = [{**{k: n.get(k) for k in NODE_FIELDS}, "display_id": n["display_id"]}
                      for n in snap["nodes"]]
            assert materialize_mem(rows, version) == expect, f"{label} v{version}: 内存物化不等价"
            assert materialize_sql(conn, map_id, version) == expect, f"{label} v{version}: SQL 物化不等价"
        conn.close()

    edits = sum(1 for r in rows if not r.deleted)
    tombs = sum(r.deleted for r in rows)
    print(f"  {label}: {len(snaps)} 个版本 → {len(rows)} 行（变更 {edits} + 墓碑 {tombs}），"
          f"全部版本双路物化等价 ✓")
    return rows


def bench(snaps: list[tuple[int, dict]], rows: list[NodeRevRow], map_id: int, label: str) -> None:
    """存储对比（真实 SQLite 文件大小）+ 物化耗时。"""
    raw = "".join(json.dumps(s, ensure_ascii=False) for _, s in snaps).encode()

    def file_db(build) -> int:
        with tempfile.NamedTemporaryFile(suffix=".db") as f:
            conn = sqlite3.connect(f.name)
            build(conn)
            conn.commit()
            conn.isolation_level = None  # VACUUM 不能在事务内执行
            conn.execute("VACUUM")
            size = Path(f.name).stat().st_size
            conn.close()
            return size

    def build_snapshot_plain(c):
        c.execute("CREATE TABLE r (map_id INT, version INT, snapshot TEXT)")
        c.executemany("INSERT INTO r VALUES (?,?,?)",
                      [(map_id, v, json.dumps(s, ensure_ascii=False)) for v, s in snaps])

    def build_snapshot_zlib(c):
        c.execute("CREATE TABLE r (map_id INT, version INT, snapshot BLOB)")
        c.executemany("INSERT INTO r VALUES (?,?,?)",
                      [(map_id, v, zlib.compress(json.dumps(s, ensure_ascii=False).encode(), 6)) for v, s in snaps])

    def build_mvcc(c):
        c.execute(_DDL)
        c.executemany("INSERT INTO node_revision VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                      [tuple(r.__dict__.values()) for r in rows])

    sizes = {
        "全量快照明文（现状）": file_db(build_snapshot_plain),
        "全量快照 zlib": file_db(build_snapshot_zlib),
        "MVCC 节点行": file_db(build_mvcc),
    }
    mid = snaps[len(snaps) // 2][0]
    with tempfile.NamedTemporaryFile(suffix=".db") as f:
        conn = sqlite3.connect(f.name)
        build_mvcc(conn)
        t0 = time.perf_counter()
        for _ in range(20):
            materialize_sql(conn, map_id, mid)
        sql_ms = (time.perf_counter() - t0) / 20 * 1000
        conn.close()

    base = sizes["全量快照明文（现状）"]
    print(f"  {label} 存储对比（SQLite 实文件，VACUUM 后）:")
    for k, v in sizes.items():
        print(f"    {k:<22} {v/1024:8.1f} KB  ({v/base*100:5.1f}%)")
    print(f"    SQL 物化 v{mid}: {sql_ms:.2f} ms/次（节点行 {len(rows)}）")


# ── 数据源：真实库 / 合成序列 ──────────────────────────────────────────


def load_real(db: Path) -> dict[int, list[tuple[int, dict]]]:
    conn = sqlite3.connect(db)
    out: dict[int, list[tuple[int, dict]]] = {}
    for map_id, version, snap in conn.execute(
        "SELECT map_id, version, snapshot FROM map_revision ORDER BY map_id, version"
    ):
        out.setdefault(map_id, []).append((version, json.loads(snap)))
    conn.close()
    return out


def synth_sequence(n_ops: int, seed: int = 42) -> list[tuple[int, dict]]:
    """合成真实形状的编辑序列（直接生成快照，不依赖业务代码）。

    从一棵 30 节点树出发，按权重随机：改 content / 改 note / 加节点 / 删节点
    / 挪节点。末段刻意埋两个坑：删 #3 后重建同号（display_id 重用）、
    整树 replace 重排（大量同号 update）。
    """
    rng = random.Random(seed)
    nodes: dict[int, dict] = {}
    nid = 1
    nodes[1] = {"display_id": 1, "parent": None, "content": "根", "note": None, "position": 0,
                "collapsed": False, "updated_by": "human", "updated_at": "2026-09-01T00:00:00"}
    for did in range(2, 31):
        nodes[did] = {"display_id": did, "parent": rng.randrange(1, did), "content": f"节点{did}",
                      "note": None, "position": rng.randrange(8), "collapsed": False,
                      "updated_by": "human", "updated_at": "2026-09-01T00:00:00"}
    snaps: list[tuple[int, dict]] = []
    for v in range(1, n_ops + 1):
        op = rng.choices(["content", "note", "add", "del", "move"], weights=[4, 3, 2, 1, 1])[0]
        if op == "content":
            n = nodes[rng.choice(list(nodes))]
            n["content"] = f"改写{v}-{rng.randrange(999)}"
            n["updated_at"] = f"2026-09-01T00:{v // 60:02d}:{v % 60:02d}"
        elif op == "note":
            n = nodes[rng.choice(list(nodes))]
            n["note"] = f"## 备注{v}\n\n- 要点{rng.randrange(99)}\n- 详情..." if rng.random() > 0.2 else None
        elif op == "add":
            did = max(nodes) + 1
            nodes[did] = {"display_id": did, "parent": rng.choice(list(nodes)), "content": f"新增{did}",
                          "note": None, "position": 0, "collapsed": False,
                          "updated_by": rng.choice(["human", "page_agent"]), "updated_at": "2026-09-01T01:00:00"}
        elif op == "del" and len(nodes) > 5:
            dead = rng.choice([d for d in nodes if d != 1])
            nodes = {d: n for d, n in nodes.items() if d != dead}
        elif op == "move":
            n = nodes[rng.choice(list(nodes))]
            if n["display_id"] != 1:
                n["parent"] = rng.choice([d for d in nodes if d != n["display_id"]])
        snaps.append((v, {"title": "合成图", "nodes": [dict(nodes[d]) for d in sorted(nodes)]}))
    # 坑 1：删 #3 → 重建同号
    snaps.append((n_ops + 1, {"title": "合成图", "nodes": [dict(n) for d, n in sorted(nodes.items()) if d != 3]}))
    nodes[3] = {"display_id": 3, "parent": 1, "content": "重用号的新节点", "note": "新备注", "position": 9,
                "collapsed": False, "updated_by": "agent", "updated_at": "2026-09-01T02:00:00"}
    snaps.append((n_ops + 2, {"title": "合成图", "nodes": [dict(n) for d, n in sorted(nodes.items())]}))
    # 坑 2：replace 式重排（大量同号 update：display_id 语义整体变化）
    remap = sorted(nodes)
    renumbered = {}
    for new_id, old_id in enumerate(remap, 1):
        n = dict(nodes[old_id])
        n["display_id"] = new_id
        n["content"] = f"重排{new_id}"
        renumbered[new_id] = n
    renumbered = {d: {**n, "parent": 1 if n["parent"] is None else n["parent"]} for d, n in renumbered.items()}
    snaps.append((n_ops + 3, {"title": "合成图", "nodes": [dict(renumbered[d]) for d in sorted(renumbered)]}))
    return snaps


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--synth-only", action="store_true", help="跳过真实库，只跑合成序列")
    ap.add_argument("--synth-ops", type=int, default=2000)
    args = ap.parse_args()

    if not args.synth_only:
        print("── 真实库快照（var/mindmap.db）──")
        real = load_real(DB)
        for map_id in sorted(real, key=lambda m: -len(real[m]))[:3]:
            snaps = real[map_id]
            rows = verify(map_id, snaps, f"map {map_id}")
            bench(snaps, rows, map_id, f"map {map_id}")

    print(f"\n── 合成序列（{args.synth_ops} 次编辑 + 2 个语义坑场景）──")
    synth = synth_sequence(args.synth_ops)
    rows = verify(999, synth, "合成图")
    bench(synth, rows, 999, "合成图")


if __name__ == "__main__":
    main()
