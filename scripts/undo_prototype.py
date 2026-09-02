"""逆向 undo（before 行）原型验证 —— 零侵入，不接入业务。

方案（specs/007 讨论 / Note tool 笔记 #50）：
    行只存 before（该节点本次变更前的状态，insert 行 before=null，墓碑行
    before=被删前状态）；回溯 vN = 从最新状态出发，把 version > vN 的行按
    版本降序逐行反向应用。理论支点：after(v) = 同节点下一行的 before，
    最近一行的 after = 最新状态 → before 是最小充分集，其余皆可计算。

验证方法：
    ground truth = 现有 after 语义行的正向物化（窗口聚合，已被充分验证）；
    before 行从 after 行流式推导（version 升序维护 latest，遇行的 pre-latest
    即 before）；逆向 undo(vN) 必须逐字段等于正向物化(vN)。

覆盖的坑场景（合成序列）：
    display_id 重用（删后同号重建）/ replace 式整树重排 / 删除→复活。
额外实测：
    折叠视图态（不落行的 node.collapsed 漂移）对"从 node 表出发"的影响——
    本原型因此从"最新版本物化态"出发（原因见输出注释）。
"""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path

DB = Path(__file__).resolve().parent.parent / "var" / "mindmap.db"
FIELDS = ("parent", "content", "note", "position", "collapsed", "updated_by", "updated_at")


# ── 数据加载 ───────────────────────────────────────────────────────────


def load_maps(db: Path) -> dict[int, dict]:
    """每图：after 行（升序）+ 版本列表。行 = (version, display_id, deleted, fields...)"""
    conn = sqlite3.connect(db)
    out: dict[int, dict] = {}
    for map_id, version, display_id, deleted, *vals in conn.execute(
        "SELECT map_id, version, display_id, deleted, parent, content, note,"
        " position, collapsed, updated_by, updated_at FROM node_revision"
        " ORDER BY map_id, version, display_id"
    ):
        m = out.setdefault(map_id, {"rows": [], "versions": set()})
        m["rows"].append((version, display_id, bool(deleted), dict(zip(FIELDS, vals))))
        m["versions"].add(version)
    conn.close()
    return out


def forward_materialize(rows: list, version: int) -> dict[int, dict]:
    """正向聚合（ground truth）：每节点取 ≤version 最新行（after 值），滤墓碑。"""
    latest: dict[int, tuple[bool, dict]] = {}
    for v, did, deleted, fields in rows:  # rows 升序
        if v <= version:
            latest[did] = (deleted, fields)
    return {did: f for did, (dead, f) in latest.items() if not dead}


def derive_before_rows(rows: list) -> list:
    """after 行 → before 行（方案的实际存储形态）。

    流式推导：version 升序维护每节点 latest；遇行的 pre-latest 即该行的
    before——这正是写入路径未来要做的事（diff 时 prev 侧本来就在手上）。
    """
    latest_alive: dict[int, dict] = {}
    out = []
    for v, did, deleted, fields in rows:
        before = latest_alive.get(did)  # None = 此前不存在（insert 行）
        out.append((v, did, before))
        if deleted:
            latest_alive.pop(did, None)
        else:
            latest_alive[did] = fields
    return out


# ── 逆向 undo（被验证的主角） ──────────────────────────────────────────


def undo_to(rows: list, before_rows: list, target: int, start_state: dict[int, dict]) -> dict[int, dict]:
    """从 start_state（最新状态）逆向撤销 > target 的全部行，返回 target 时刻的树。

    undo 规则：before=None → 删除节点；否则节点值 ← before（回退或复活）。
    同版本内行不重叠节点（主键保证），版本内顺序无关。
    """
    by_version: dict[int, list] = {}
    for v, did, before in before_rows:
        by_version.setdefault(v, []).append((did, before))
    tree = dict(start_state)
    for v in sorted(by_version, reverse=True):
        if v <= target:
            break
        for did, before in by_version[v]:
            if before is None:
                tree.pop(did, None)
            else:
                tree[did] = dict(before)
    return tree


# ── 验证与基准 ─────────────────────────────────────────────────────────


def verify(map_id: int, data: dict, label: str) -> None:
    rows, versions = data["rows"], sorted(data["versions"])
    before_rows = derive_before_rows(rows)
    # 出发点 = 最新版本的物化态（不用 node 表：折叠是视图态不落行，
    # node.collapsed 可能领先最新版本 → 会引入与 undo 无关的假性偏差）
    start = forward_materialize(rows, versions[-1])

    bad = 0
    for v in versions:
        expect = forward_materialize(rows, v)
        got = undo_to(rows, before_rows, v, start)
        if got != expect:
            bad += 1
            print(f"    ✗ v{v}: undo 与正向物化不一致！")
    n = len(versions)
    print(f"  {label}: {n} 个版本逐个回溯（含 v{n and versions[-1]}→v{versions[0]} 全程），"
          f"{'全部与正向物化一致 ✓' if bad == 0 else f'{bad} 个版本不一致 ✗'}")
    assert bad == 0


def bench(map_id: int, data: dict, label: str) -> None:
    rows, versions = data["rows"], sorted(data["versions"])
    before_rows = derive_before_rows(rows)
    start = forward_materialize(rows, versions[-1])
    n_rows = len(rows)

    for which, v in (("最近版本", versions[-2] if len(versions) > 1 else versions[-1]),
                     ("最老版本", versions[0])):
        t0 = time.perf_counter()
        for _ in range(50):
            undo_to(rows, before_rows, v, start)
        ms = (time.perf_counter() - t0) / 50 * 1000
        t0 = time.perf_counter()
        for _ in range(50):
            forward_materialize(rows, v)
        fw = (time.perf_counter() - t0) / 50 * 1000
        undo_n = sum(1 for vv, _, _ in before_rows if vv > v)
        print(f"    回溯{which} v{v}: undo {ms:.2f} ms（撤销 {undo_n} 行）vs 正向聚合 {fw:.2f} ms")

    print(f"    行存储：after 行 {n_rows} 条 ↔ before 行 {len(before_rows)} 条（一一对应，单值不翻倍）")


# ── 合成坑场景 ─────────────────────────────────────────────────────────


def synth_rows() -> tuple[list, set[int]]:
    """合成 after 行序列，刻意埋三个坑：同号重用 / 删除→复活 / replace 重排。"""
    rows: list = []
    latest: dict[int, dict] = {}

    def commit(v: int, changes: dict[int, dict | None]):
        """changes: {did: fields(变更后) | None(删除)}——after 行存变更后的状态。"""
        for did, after in sorted(changes.items()):
            rows.append((v, did, after is None, dict(after) if after is not None else None))
        for did, after in changes.items():
            if after is None:
                latest.pop(did, None)
            else:
                latest[did] = dict(after)

    def node(parent, content, **kw):
        return {"parent": parent, "content": content, "note": kw.get("note"), "position": kw.get("position", 0),
                "collapsed": False, "updated_by": "t", "updated_at": f"t{kw.get('v', 0)}"}

    commit(1, {i: node(None if i == 1 else 1, f"n{i}") for i in range(1, 6)})     # v1 基线 5 节点
    commit(2, {2: node(1, "n2改")})                                                # v2 update
    commit(3, {6: node(2, "n6")})                                                  # v3 insert
    commit(4, {3: None})                                                           # v4 删 #3
    commit(5, {3: node(1, "重用同号", note="新节点")})                                # v5 坑1：同号重用
    commit(6, {2: node(1, "n2再改", position=3)})                                   # v6
    commit(7, {4: None, 5: None})                                                  # v7 删两个
    commit(8, {3: node(1, "复活态", note="复活备注")})                                # v8 坑2：复活（又改值）
    # v9 坑3：replace 式重排——存活节点全部换内容、#6 删除
    alive = {1: node(None, "根重排"), 2: node(1, "重排2"), 3: node(1, "重排3"), 6: None}
    commit(9, alive)
    return rows, set(range(1, 10))


def main() -> None:
    maps = load_maps(DB)
    print("── 真实库（node_revision，after 行）──")
    for map_id in sorted(maps, key=lambda m: -len(maps[m]["versions"]))[:3]:
        verify(map_id, maps[map_id], f"map {map_id}")
        bench(map_id, maps[map_id], f"map {map_id}")

    print("\n── 合成坑场景（同号重用 / 删除复活 / replace 重排）──")
    rows, versions = synth_rows()
    verify(999, {"rows": rows, "versions": versions}, "合成序列")

    # 推导链自检：after(v) 应等于同节点下一行的 before / 最新态
    before_rows = derive_before_rows(rows)
    latest = forward_materialize(rows, 10)
    nxt: dict[int, dict] = {}
    chain_ok = True
    for v, did, before in reversed(before_rows):  # 降序：先见到的是"下一行"
        after = nxt.get(did, latest.get(did))
        # 该行的 after 应等于我们记录的 next-before（或最新态）
        row_after = None
        # 找该行的 after 值（从正向 rows 里）
        for vv, dd, dead, f in rows:
            if vv == v and dd == did:
                row_after = None if dead else f
        if (row_after or None) != (after or None):
            chain_ok = False
        nxt[did] = before
    print(f"  after(v) = 下一行 before / 最新态 的推导链自检: {'✓ 成立' if chain_ok else '✗ 有反例'}")


if __name__ == "__main__":
    main()
