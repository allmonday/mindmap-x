"""mindmap domain — 独立业务方法。

方法为普通 async 函数（不含 cls），由 models.mount_method() 桥接挂载到 Map 实体。

接口约定：
- **节点 ID 语义 = display_id（map 内编号，每图从 1 起）**。全局主键 node.id
  仅作内部 FK/环检测使用，不对外暴露。所有单节点操作以 (map_id, display_id) 定位。
- ``actor`` 参数标识修改来源（'human' / 'agent' / 'page_agent'），写入
  node.updated_by，前端据此高亮 Agent 修改的节点。浏览器前端显式传
  'human'；外部 Agent（CLI/MCP/REST，如 Claude Code）默认 'agent'；页内
  Agent 经 X-Mindmap-Source header 被 service 层识别为 'page_agent'
  （见 service.py _resolve_actor）——events 层据此豁免 External Changes。
- outline 文本格式（get_tree 输出 / apply_outline 输入）::

    - [id:1] Q3 产品规划
      - [id:2] 用户增长
        - 邀请裂变活动            ← 无 id 前缀 = 新节点（apply_outline 时）

  缩进每 2 个空格一级；`[id:N]` 中的 N 是 display_id（map 内编号）。
- apply_outline 两种 mode：
  - merge   —— 有 id 的行更新内容并按缩进重排结构，无 id 的行新建（分配
               map 内下一个 display_id），树中未出现的节点保留不动
  - replace —— 保留根节点，删除其余全部，按 outline 顺序重排 display_id 为 1..n
- 所有 mutation 成功后：map.version += 1，并 publish_change 广播。
"""
import re
from datetime import datetime, timezone

from sqlalchemy import delete
from sqlmodel import select

from src.db import async_session
from src.models import Map, MapRevision, Node, NodeRevision
from src.service.mindmap.events import drain_pending, publish_change

_LINE_RE = re.compile(r"^-\s*(?:\[id:(\d+)\]\s*)?(.*)$")
INDENT_UNIT = 2


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_norm(value: datetime | str | None) -> str | None:
    """updated_at 归一序列化：aware 转 UTC naive，统一 '...Z' 后缀。

    同一时刻两种来源必须得到同一字符串——内存对象是 aware（isoformat 出
    '+00:00'），SQLite 读回是 naive（剥 tzinfo）。diff 按字符串相等判变更，
    形态漂移会让未触碰节点每个版本重复落行（v3 写 '+00:00'、v4 读回判 'Z'）。
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo:
            value = value.astimezone(timezone.utc).replace(tzinfo=None)
        return value.isoformat() + "Z"
    s = str(value)
    return s.replace("+00:00", "").removesuffix("Z") + "Z"


# ── helpers ───────────────────────────────────────────────────────────


def _esc_outline(s: str) -> str:
    """outline 是行协议（一行一节点）：内容里的换行与反斜杠转义为 \\n / \\\\，
    保证 get_tree 输出可直接喂回 apply_outline（多行内容往返不破协议）。"""
    return s.replace("\\", "\\\\").replace("\n", "\\n")


def _unesc_outline(s: str) -> str:
    """_esc_outline 的逆：\\n → 换行，\\\\ → 反斜杠；其余 \\x 原样保留（宽容解析）。"""
    return re.sub(r"\\(.)", lambda m: "\n" if m.group(1) == "n" else m.group(1), s)


def _render_outline(nodes: list[Node]) -> str:
    """把节点集合渲染为缩进 outline 文本（[id:N] 为 display_id）。"""
    by_parent: dict[int | None, list[Node]] = {}
    for n in sorted(nodes, key=lambda x: (x.position, x.id)):
        by_parent.setdefault(n.parent_id, []).append(n)

    lines: list[str] = []

    def walk(node: Node, depth: int) -> None:
        lines.append("  " * depth + f"- [id:{node.display_id}] {_esc_outline(node.content)}")
        for child in by_parent.get(node.id, []):
            walk(child, depth + 1)

    for root in by_parent.get(None, []):
        walk(root, 0)
    return "\n".join(lines)


def _parse_outline(outline: str) -> list[tuple[int, int | None, str]]:
    """解析 outline 文本为 (level, display_id|None, content) 列表。

    校验：首行必须 level 0；每行 level 至多比上一行深 1。
    """
    entries: list[tuple[int, int | None, str]] = []
    prev_level = -1
    for raw in outline.expandtabs(INDENT_UNIT).splitlines():
        if not raw.strip():
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        level, rem = divmod(indent, INDENT_UNIT)
        if rem != 0:
            raise ValueError(f"缩进必须是 {INDENT_UNIT} 的倍数: {raw!r}")
        if prev_level >= 0 and level > prev_level + 1:
            raise ValueError(f"缩进跳级（比上一行深超过 1 层）: {raw!r}")
        m = _LINE_RE.match(raw.strip())
        if not m or not m.group(2).strip():
            raise ValueError(f"无法解析的行: {raw!r}（每行必须形如 '- 内容' 或 '- [id:N] 内容'）")
        display_id = int(m.group(1)) if m.group(1) else None
        entries.append((level, display_id, _unesc_outline(m.group(2).strip())))
        prev_level = level
    if not entries:
        raise ValueError("outline 为空")
    if entries[0][0] != 0:
        raise ValueError("outline 第一行必须是根节点（无缩进）")
    if sum(1 for lvl, _, _ in entries if lvl == 0) > 1:
        raise ValueError("outline 只能有一个根节点（level 0 的行只能有一行）")
    return entries


async def _get_map(session, map_id: int) -> Map:
    """单图查询的唯一入口：软删图（deleted_at 非空）对外等同不存在。"""
    m = await session.get(Map, map_id)
    if m is None or m.deleted_at is not None:
        raise ValueError(f"map {map_id} not found")
    return m


async def _get_node(session, map_id: int, display_id: int) -> Node:
    """按 (map_id, display_id) 定位节点 —— 对外 ID 语义的唯一入口。"""
    result = await session.exec(
        select(Node).where(Node.map_id == map_id, Node.display_id == display_id)
    )
    node = result.first()
    if node is None:
        raise ValueError(f"map {map_id} 中不存在节点 #{display_id}")
    return node


async def _next_display_id(session, map_id: int) -> int:
    """分配 map 内下一个 display_id（max + 1，从 1 起）。"""
    result = await session.exec(
        select(Node.display_id).where(Node.map_id == map_id).order_by(Node.display_id.desc())
    )
    current = result.first()
    return (current + 1) if current is not None else 1


async def _descendant_ids(session, node: Node) -> set[int]:
    """BFS 收集 node 的全部后代全局 id（不含 node 自身；内部用全局 id）。"""
    ids: set[int] = set()
    frontier = [node.id]
    while frontier:
        rows = (
            await session.exec(select(Node.id).where(Node.parent_id.in_(frontier)))
        ).all()
        new = [r for r in rows if r not in ids]
        ids.update(new)
        frontier = new
    return ids


# ── 版本历史（undo log：行存 before，读取为逆向回溯） ──────────────────

_DIFF_FIELDS = ("parent", "content", "note", "position", "collapsed", "updated_by", "updated_at")


def _fields_of(node: Node, display_of: dict[int, int]) -> dict:
    """Node 对象 → 七字段 dict（parent 转 display_id；updated_at 归一 ISO）。

    parent 的转换必须在快照时刻完成——delete_node 连父带子删除，落行时
    再查映射会得到 None，墓碑行的复活值就错了。
    """
    return {
        "parent": None if node.parent_id is None else display_of.get(node.parent_id),
        "content": node.content, "note": node.note, "position": node.position,
        "collapsed": node.collapsed, "updated_by": node.updated_by,
        "updated_at": _iso_norm(node.updated_at),
    }


async def _display_index(session, map_id: int) -> dict[int, int]:
    """{全局主键 id: display_id}——before 快照时把 parent_id 转成 display_id 用。

    必须在快照时刻调用（变更应用前）：delete_node 连父带子删除，事后映射就缺键了。
    """
    rows = (
        await session.exec(
            select(Node.id, Node.display_id).where(Node.map_id == map_id)
        )
    ).all()
    return {gid: did for gid, did in rows}


async def _current_tree(session, map_id: int) -> tuple[dict[int, dict], dict[int, int]]:
    """node 表当前态 → ({display_id: fields}, {全局id: display_id})。

    SELECT 会 autoflush 下发挂起变更 → 读到的一定是 post-mutation 最终态
    （与全量快照时代的 _build_snapshot 同机制）。折叠是视图态不落行，
    node.collapsed 可能领先最新版本——undo 物化接受此污染（collapsed 无
    产品意义，原型验证已确认只影响该字段）。
    """
    nodes = (
        await session.exec(
            select(Node).where(Node.map_id == map_id).order_by(Node.display_id)
        )
    ).all()
    display_of = {n.id: n.display_id for n in nodes}
    return {n.display_id: _fields_of(n, display_of) for n in nodes}, display_of


async def _undo_to(session, map_id: int, target: int) -> dict[int, dict]:
    """逆向回溯：从 node 表当前态出发，撤销 version > target 的全部行。

    undo 规则：before IS NULL（新增行）→ 删除节点；否则设 dict（修改行回退、
    删除行复活，同构）。before 是 JSON 列（sa.JSON 自动反序列化为 dict），
    物化循环与字段集正交——Node 字段演进只动 _DIFF_FIELDS，此处零改动。
    同版本内行不重叠节点（PK 保证），无顺序歧义。实测亚毫秒级。
    """
    tree, _ = await _current_tree(session, map_id)
    rows = (
        await session.exec(
            select(NodeRevision)
            .where(NodeRevision.map_id == map_id, NodeRevision.version > target)
            .order_by(NodeRevision.version.desc(), NodeRevision.display_id)
        )
    ).all()
    for r in rows:  # 降序：最新变更先撤，逐层剥回到 target
        if r.before is None:
            tree.pop(r.display_id, None)
        else:
            tree[r.display_id] = dict(r.before)
    return tree


async def materialize_tree(session, map_id: int, version: int) -> dict | None:
    """物化某版本的整树（原 snapshot JSON 形状：{title, nodes:[...]}）。

    get_revision / restore 的树内容来源 = undo 回溯。title 取 map_revision
    同版本行；版本不存在返回 None（调用方报错）。
    """
    rev = (
        await session.exec(
            select(MapRevision).where(
                MapRevision.map_id == map_id, MapRevision.version == version
            )
        )
    ).first()
    if rev is None:
        return None
    nodes = await _undo_to(session, map_id, version)
    return {
        "title": rev.title,
        "nodes": [{"display_id": did, **fields} for did, fields in nodes.items()],
    }


async def _write_node_rows(session, m: Map, new_version: int, before: dict) -> None:
    """变更集落为 before 行：行只按 before 的 keys 生成，值 = 变更前状态 dict。

    - before 由调用方在变更应用前显式快照（{display_id: fields | None}，
      None = 新增、缺失 = 未触碰）——诚实契约：漏报一个触碰节点不会破坏
      最新态（node 表仍对），只是历史里缺一步 undo
    - "当前树"的 SELECT 触发 autoflush → diff 两侧都在手；行只落 before 侧
      值（after = 同节点下一行 before / 最新态，可推导不落盘）
    - 同号重用（同版本 delete 旧 + insert 新，如 restore/replace）在 before
      dict 里 keyed 合并为一条修改行（before 取删除侧旧值），PK 不冲突
    - 行只按 before 的 keys 生成；"本次新增但调用方没记 None"的节点（如
      restore 复活的）由调用方显式补——不做 cur-before 差集：部分快照的
      mutation（delete_node 只快照被删子树）差集全是未触碰节点，会被误记
      成新增
    """
    cur, _ = await _current_tree(session, m.id)
    for did, prev_fields in before.items():
        if prev_fields is None:
            session.add(NodeRevision(map_id=m.id, version=new_version, display_id=did))
            continue  # 新增行：before=NULL（undo 它 = 从树中删除）
        if cur.get(did) == prev_fields:
            continue  # 未实际变化（调用方保守快照了）：不落行
        session.add(NodeRevision(
            map_id=m.id, version=new_version, display_id=did,
            deleted=did not in cur, before=prev_fields,  # 删除行的 before 即复活值
        ))


async def _commit_with_revision(
    session,
    m: Map,
    *,
    before: dict,
    action: str,
    actor: str,
    detail: str | None = None,
    version: int | None = None,
) -> None:
    """mutation 统一收口：version 前进 → before 行 + 版本元数据行 → 提交 → 广播。

    - before 必传（keyword-only）：编译期强制每个调用点想清楚触碰集，
      见 _write_node_rows 的诚实契约
    - 节点行 + MapRevision 元数据行与树变更共用本 session 一个事务一次
      commit——外部观察者只见"全部可见"或"全部不可见"
    - publish_change 在 commit 之后调用（订阅者重拉必见已提交状态）
    - version 传值则直接赋值（仅 create_map 传 1），否则 +1
    - 任何一步抛异常 → 不 commit → 树变更一并回滚（行不会成为半吊子）
    """
    new_version = version if version is not None else m.version + 1
    await _write_node_rows(session, m, new_version, before)
    m.version = new_version
    session.add(
        MapRevision(
            map_id=m.id, version=new_version, action=action,
            actor=actor, detail=detail, title=m.title,
        )
    )
    session.add(m)
    await session.commit()
    publish_change(m.id, m.version, action, actor, detail=detail)


async def _commit_view_state(
    session,
    m: Map,
    *,
    action: str,
    actor: str,
    client_request_id: str | None = None,
    payload: dict[str, object] | None = None,
) -> None:
    """收放类视图态提交：不递增 version、不落快照、不入 Agent 通知缓冲，仅 WS 广播。

    折叠不改变任何内容信息（README：视图状态），高频且不可回滚价值——进版本
    历史只会灌水（实测约 3/4 的快照是收放产生的）。广播仍发：其他浏览器
    页签需要直接应用视图态增量。不传 detail：视图态不值得注入页内 Agent
    的上下文（与 expand_all 既有语义一致）。
    """
    session.add(m)
    await session.commit()
    publish_change(
        m.id,
        m.version,
        action,
        actor,
        client_request_id=client_request_id,
        payload=payload,
    )


# ── queries ───────────────────────────────────────────────────────────


async def list_maps() -> list[Map]:
    """列出所有脑图（软删图不出现）。"""
    async with async_session() as session:
        result = await session.exec(
            select(Map).where(Map.deleted_at.is_(None)).order_by(Map.id)
        )
        return list(result.all())


async def get_map(map_id: int) -> Map:
    """获取 Map 实体（不含关系数据——nodes 由 Resolver DataLoader 按需批量加载）。"""
    async with async_session() as session:
        return await _get_map(session, map_id)


async def get_tree(map_id: int) -> str:
    """整树读取，返回带 [id:N] 标记的缩进 outline 文本（Agent 核心读法，N 为 map 内编号）。"""
    async with async_session() as session:
        await _get_map(session, map_id)
        nodes = (
            await session.exec(select(Node).where(Node.map_id == map_id))
        ).all()
        return _render_outline(list(nodes))


async def get_node(map_id: int, node_id: int) -> Node:
    """读单个节点全文（含 note markdown）。node_id 为 map 内 display_id。

    outline 行协议不含 note——这是 Agent 写 note 后的读回入口。
    """
    async with async_session() as session:
        await _get_map(session, map_id)
        return await _get_node(session, map_id, node_id)


# ── mutations ─────────────────────────────────────────────────────────


async def create_map(title: str, actor: str = "agent") -> Map:
    """创建新脑图，自动创建根节点（content 复用 title，display_id = 1）。"""
    async with async_session() as session:
        m = Map(title=title)
        session.add(m)
        await session.flush()
        session.add(
            Node(
                map_id=m.id,
                display_id=1,
                parent_id=None,
                content=title,
                position=0,
                updated_by=actor,
            )
        )
        await _commit_with_revision(
            session, m, before={}, version=1, action="map_created", actor=actor
        )  # before={}：全新图，根节点也不落行（v1 态 = node 表撤销全部后续行，天然成立）
        await session.refresh(m)
        return m


async def add_node(
    map_id: int,
    parent_id: int,
    content: str,
    position: int | None = None,
    note: str | None = None,
    actor: str = "agent",
) -> Node:
    """在 parent 下新增子节点（可携带初始 note，空串归一为 NULL）。

    parent_id 语义为 map 内 display_id；新节点分配 map 内下一个 display_id。
    position=None 追加到同级末尾。
    """
    async with async_session() as session:
        m = await _get_map(session, map_id)
        parent = await _get_node(session, map_id, parent_id)
        if position is None:
            siblings = (
                await session.exec(
                    select(Node.position).where(Node.parent_id == parent.id)
                )
            ).all()
            position = max(siblings, default=-1) + 1
        node = Node(
            map_id=map_id,
            display_id=await _next_display_id(session, map_id),
            parent_id=parent.id,
            content=content,
            position=position,
            note=note or None,
            updated_by=actor,
        )
        session.add(node)
        await _commit_with_revision(
            session, m,
            before={node.display_id: None},  # 新增节点：before = 不存在
            action="node_added", actor=actor,
            detail=f"add_node #{node.display_id}「{content}」（父 #{parent_id}）",
        )
        await session.refresh(node)
        return node


async def update_node(
    map_id: int,
    node_id: int,
    content: str | None = None,
    collapsed: bool | None = None,
    note: str | None = None,
    actor: str = "agent",
) -> Node:
    """部分更新节点（content / collapsed / note）。

    node_id 语义为 map 内 display_id。
    - content/note 变更：内容修改——刷新 updated_by/updated_at，进版本历史（快照）。
      note 语义：None=不动；空串 ""=清空（DB 归一存 NULL，"有/无备注"两态）
    - 仅 collapsed：视图状态——不递增 version、不落快照、不入 Agent 通知缓冲，
      也不刷新 updated_by/updated_at（与 expand_all / set_fold_level 语义一致；
      之前此处会刷新，导致"Agent 修改高亮"误亮，与 README 声明不符）
    - 内容+折叠都传：按内容变更处理（一次快照反映最终态），折叠随快照落盘
    - 空操作（collapsed 与当前一致且未传 content/note）：version 不动、不广播
    """
    async with async_session() as session:
        node = await _get_node(session, map_id, node_id)
        m = await _get_map(session, map_id)
        content_changed = content is not None or note is not None
        fold_changed = collapsed is not None and collapsed != node.collapsed
        if not content_changed and not fold_changed:
            return node  # 空操作：version/广播/快照全不动
        # before 快照在改属性前取（单节点：parent 的 display_id 即 node_id 的语义父）
        before = {node_id: _fields_of(node, await _display_index(session, map_id))}
        if content is not None:
            node.content = content
        if note is not None:
            node.note = note or None  # "" 归一 NULL：DB 只有"有备注/无备注"两态
        if collapsed is not None:
            node.collapsed = collapsed
        if content_changed:
            node.updated_by = actor
            node.updated_at = _now()
            changes: list[str] = []
            if content is not None:
                changes.append(f"内容→「{content}」")
            if note is not None:
                # 长文不灌时间线：只进截断摘要，全文在节点上
                if note:
                    changes.append(f"备注→「{note[:16]}{'…' if len(note) > 16 else ''}」")
                else:
                    changes.append("备注清空")
            if collapsed is not None:
                changes.append("折叠" if collapsed else "展开")
            await _commit_with_revision(
                session, m, before=before, action="node_updated", actor=actor,
                detail=f"update_node #{node_id} {'，'.join(changes)}",
            )
        else:
            await _commit_view_state(
                session,
                m,
                action="node_collapsed",
                actor=actor,
                payload={"node_id": node_id, "collapsed": collapsed},
            )
        await session.refresh(node)
        return node


async def set_node_collapsed(
    map_id: int,
    node_id: int,
    collapsed: bool,
    actor: str = "agent",
    client_request_id: str | None = None,
) -> bool:
    """设置单节点折叠状态，只返回是否发生变化。

    这是高频视图态专用入口：不刷新节点、不构造 DTO；REST 出口使用 204。
    client_request_id 仅用于浏览器识别自己的 WS 事件并跳过重复整树读取。
    """
    async with async_session() as session:
        node = await _get_node(session, map_id, node_id)
        m = await _get_map(session, map_id)
        if node.collapsed == collapsed:
            return False
        node.collapsed = collapsed
        session.add(node)
        await _commit_view_state(
            session,
            m,
            action="node_collapsed",
            actor=actor,
            client_request_id=client_request_id,
            payload={"node_id": node_id, "collapsed": collapsed},
        )
        return True


async def move_node(
    map_id: int,
    node_id: int,
    new_parent_id: int,
    position: int | None = None,
    actor: str = "agent",
) -> Node:
    """移动节点（换父 / 同级重排）。禁止移到自己或自己的子树下（防环）。

    node_id / new_parent_id 语义均为 map 内 display_id。
    """
    async with async_session() as session:
        node = await _get_node(session, map_id, node_id)
        m = await _get_map(session, map_id)
        if node.parent_id is None:
            raise ValueError("根节点不可移动")
        new_parent = await _get_node(session, map_id, new_parent_id)
        if new_parent.id == node.id or new_parent.id in await _descendant_ids(session, node):
            raise ValueError("不能把节点移动到自己或它的子树下（会成环）")
        # before 快照在改属性前取（防环校验之后：校验失败不落行）
        before = {node_id: _fields_of(node, await _display_index(session, map_id))}
        node.parent_id = new_parent.id
        if position is None:
            siblings = (
                await session.exec(
                    select(Node.position).where(
                        Node.parent_id == new_parent.id, Node.id != node.id
                    )
                )
            ).all()
            position = max(siblings, default=-1) + 1
        node.position = position
        node.updated_by = actor
        node.updated_at = _now()
        await _commit_with_revision(
            session, m, before=before, action="node_moved", actor=actor,
            detail=f"move_node #{node_id} → 父 #{new_parent_id}",
        )
        await session.refresh(node)
        return node


async def delete_node(map_id: int, node_id: int, actor: str = "agent") -> bool:
    """删除节点及其整棵子树。根节点不可删除（每棵图必须有根）。

    node_id 语义为 map 内 display_id；被删除的 display_id 不复用（保持编号稳定）。
    """
    async with async_session() as session:
        node = await _get_node(session, map_id, node_id)
        if node.parent_id is None:
            raise ValueError("根节点不可删除（删除整张图请走后续的 map 级接口）")
        m = await _get_map(session, map_id)
        ids = {node.id} | await _descendant_ids(session, node)
        # before 快照：被删子树全体（含父链转换——删除后映射就缺键了）
        display_of = await _display_index(session, map_id)
        before = {}
        for nid in ids:
            n = await session.get(Node, nid)
            if n is not None:
                before[n.display_id] = _fields_of(n, display_of)
        for nid in ids:
            n = await session.get(Node, nid)
            if n is not None:
                await session.delete(n)
        await _commit_with_revision(
            session, m, before=before, action="node_deleted", actor=actor,
            detail=f"delete_node #{node_id}（含 {len(ids) - 1} 个后代）",
        )
        return True


async def delete_map(map_id: int, actor: str = "agent") -> bool:
    """软删除整张脑图：打 deleted_at 标记，行/节点/快照保留（可恢复，暂无入口）。

    对外表现与硬删一致：list_maps 不出现、_get_map not found；WS 客户端收到
    map_deleted 广播（前端自动退回列表），外部改动待通知缓冲清空。
    聊天会话/归档不清理——软删哲学是数据保留，且 rowid 不复用（软删行占住
    max id），新建图永远不会拿到旧 id，残留文件不会被误读。
    """
    async with async_session() as session:
        m = await _get_map(session, map_id)
        next_version = m.version + 1  # 图即将不可见，version 仅用于事件单调
        m.deleted_at = datetime.now(timezone.utc)
        await session.commit()
    # 先 commit 再广播：订阅者收到事件后重拉 get_map 应当看到 404
    publish_change(map_id, next_version, "map_deleted", actor)
    drain_pending(map_id)
    return True


async def expand_all(
    map_id: int,
    actor: str = "agent",
    client_request_id: str | None = None,
) -> Map:
    """展开全部节点（collapsed=False），单事务批量更新。

    语义注意：折叠是视图状态而非内容修改 —— 不刷新 updated_by/updated_at
    （否则 Agent 修改角标会误亮），也不递增 version、不落快照（收放不进
    版本历史，实测约 3/4 快照是收放灌的水），仅 WS 广播驱动多端增量同步。
    全图已展开时是空操作：version 不动、不广播。get_tree 不感知
    collapsed，因此不向 Agent 通知。
    """
    async with async_session() as session:
        m = await _get_map(session, map_id)
        folded = (
            await session.exec(
                select(Node).where(Node.map_id == map_id, Node.collapsed == True)  # noqa: E712
            )
        ).all()
        if not folded:
            return m  # 空操作：version 不动、不落快照、不广播、不入 Agent 通知缓冲
        for n in folded:
            n.collapsed = False
            session.add(n)
        await _commit_view_state(
            session,
            m,
            action="expanded_all",
            actor=actor,
            client_request_id=client_request_id,
            payload={},
        )
        return m


async def set_fold_level(
    map_id: int,
    level: int,
    actor: str = "agent",
    client_request_id: str | None = None,
) -> Map:
    """按层级批量收放：保留前 level 层可见（根 = 第 1 层），更深的子树收起。

    声明式语义 —— 每个节点按深度直接取目标态，而非增量操作：
    - 有孩子且深度 ≥ level → collapsed=True（其子树隐藏）
    - 有孩子且深度 < level → collapsed=False（展开）
    - 叶子节点恒 False：collapsed 对叶子无意义，置 True 会留下幽灵状态，
      且破坏 expand_all 的 no-op 短路（它会捞到 collapsed==True 的叶子）
    level ≥ 树深时全部节点目标态为 False，等价于 expand_all。

    视图状态语义与 expand_all 一致：不刷新 updated_by/updated_at
    （否则 Agent 修改角标会误亮），也不递增 version、不落快照（收放不进
    版本历史），仅 WS 广播驱动多端增量同步。
    无任何节点需要变化时是空操作：version 不动、不广播。get_tree 不感知
    collapsed，因此不向 Agent 通知（不传 detail）。
    """
    if level < 2:
        raise ValueError(
            f"level 必须 ≥ 2（level=1 会连根一起折叠，整图只剩标题；"
            f"想收起根的孩子请用 level=2）"
        )
    async with async_session() as session:
        m = await _get_map(session, map_id)
        nodes = (
            await session.exec(select(Node).where(Node.map_id == map_id))
        ).all()

        # 按 parent_id（全局 id）组 children 映射，从根 DFS 标深度（根 = 第 1 层）
        by_parent: dict[int | None, list[Node]] = {}
        for n in nodes:
            by_parent.setdefault(n.parent_id, []).append(n)
        if not by_parent.get(None):
            raise ValueError(f"map {map_id} 缺少根节点，数据异常")

        parent_ids = {n.parent_id for n in nodes if n.parent_id is not None}  # 有孩子的全局 id
        depth_of: dict[int, int] = {}  # 全局 id → 深度（根 = 1）
        stack = [(r, 1) for r in by_parent[None]]
        while stack:
            node, d = stack.pop()
            depth_of[node.id] = d
            for child in by_parent.get(node.id, []):
                stack.append((child, d + 1))

        changed = False
        for n in nodes:
            d = depth_of.get(n.id)
            if d is None:
                continue  # 孤儿节点（数据异常，正常流程不该出现）：不动它的视图状态
            want = n.id in parent_ids and d >= level
            if n.collapsed != want:
                n.collapsed = want
                session.add(n)
                changed = True
        if not changed:
            return m  # 空操作：version 不动、不落快照、不广播、不入 Agent 通知缓冲
        await _commit_view_state(
            session,
            m,
            action="folded_to_level",
            actor=actor,
            client_request_id=client_request_id,
            payload={"level": level},
        )
        return m


async def apply_outline(
    map_id: int,
    outline: str,
    mode: str = "merge",
    actor: str = "agent",
) -> Map:
    """整树写入：按缩进 outline 文本 merge 或 replace 脑图。

    ⚠ 全量结构写入而非局部补丁：缩进即父子关系——锚定 [id:N] 行的层级
    必须照抄节点在树中的真实深度，写浅/写深都会把节点**移动**到新父之下
    （Agent 误用本方法改单个子节点时，最常见的事故就是子节点被挂到根下）。
    单点改动请用 update_node / move_node。

    [id:N] 中的 N 是 map 内 display_id。
    merge   —— 有 [id:N] 的行更新 content 并按缩进调整父子/顺序（锚定节点保留
               原 display_id）；无 id 的行新建（分配 map 内下一个号）；树中
               未出现的节点保留（不误删）。
    replace —— 保留根节点（content 更新为 outline 首行），其余全删重建，
               display_id 按 outline 顺序重排为 1..n。

    outline 行协议不含 note：merge 锚定节点原样保留；replace 下锚定 [id:N]
    的行按旧号带回原 note（未锚定的新建行 note 为空）——结构重建不丢内容资产。
    """
    if mode not in ("merge", "replace"):
        raise ValueError(f"mode 必须是 'merge' 或 'replace'，收到 {mode!r}")
    entries = _parse_outline(outline)

    async with async_session() as session:
        m = await _get_map(session, map_id)
        existing = {
            n.display_id: n
            for n in (
                await session.exec(select(Node).where(Node.map_id == map_id))
            ).all()
        }

        # 新节点 display_id 分配器：merge 从 map 内当前最大号 +1 起
        next_display = max(existing.keys(), default=0) + 1
        # 锚定号合法域（跨图锚定检查用）与旧号→note 映射（replace 重建时带回）
        old_ids = set(existing.keys())
        old_notes = {n.display_id: n.note for n in existing.values() if n.note is not None}
        # before 快照：全树（在 replace 删节点/根改号/新节点塞回 existing 之前）。
        # 锚定改属性的对象也在 existing 里——现在快照的正是变更前值
        _disp = await _display_index(session, map_id)
        before = {did: _fields_of(n, _disp) for did, n in existing.items()}

        if mode == "replace":
            roots = [n for n in existing.values() if n.parent_id is None]
            root = roots[0] if roots else None
            if root is None:
                raise ValueError(f"map {map_id} 缺少根节点，数据异常")
            # 删除根以外的全部节点
            for n in existing.values():
                if n.id != root.id:
                    await session.delete(n)
            await session.flush()
            # replace 重排：根 = 1，其余按 outline 顺序 2..n
            root.display_id = 1
            session.add(root)
            lvl0, _oid0, content0 = entries[0]
            entries[0] = (lvl0, 1, content0)
            next_display = 2
            # 锚定表收缩为根：非根对象已 delete+flush，留在表里会被下方
            # "命中 existing" 分支 mutate 已删对象（脏路径，且与 docstring
            # "重排为 1..n" 矛盾）——非根锚定一律走重建，note 按锚定号带回
            existing = {1: root}

        # 逐行处理：维护每层最后出现的节点全局 id 作为下一层的默认父节点
        last_at_level: dict[int, int] = {}
        resolved_nodes: list[Node] = []  # 按出现顺序收集实际节点（新建的 id 在 flush 后才有）
        for level, display_id, content in entries:
            if level == 0:
                parent_gid: int | None = None
            else:
                pgid = last_at_level.get(level - 1)
                if pgid is None:
                    raise ValueError(f"第 {level} 层找不到父节点（缩进跳级）: {content!r}")
                parent_gid = pgid

            if display_id is not None and display_id in existing:
                node = existing[display_id]
                node.content = content
                node.parent_id = parent_gid
                node.updated_by = actor
                node.updated_at = _now()
                session.add(node)
            else:
                # replace 收缩 existing 后非根锚定行也走此分支：锚定号必须属于
                # 旧树（old_ids），否则是跨图锚定；note 按锚定号从旧树带回
                if display_id is not None and display_id not in old_ids:
                    raise ValueError(
                        f"[id:{display_id}] 不是 map {map_id} 的节点编号（不能跨图锚定）"
                    )
                node = Node(
                    map_id=map_id,
                    display_id=next_display,
                    parent_id=parent_gid,
                    content=content,
                    note=old_notes.get(display_id) if display_id is not None else None,
                    position=0,
                    updated_by=actor,
                )
                next_display += 1
                session.add(node)
                # 真新增才记 insert 行；replace 锚定重建（同号）保留旧树快照的
                # before——那是对的"修改行"（锚定号≠新号时旧号自动落删除行，
                # 新号落 insert 行，同一条 cur 判定覆盖）
                if node.display_id not in before:
                    before[node.display_id] = None
                await session.flush()
                existing[node.display_id] = node

            last_at_level[level] = node.id
            resolved_nodes.append(node)

        # 同级顺序：按本次 entries 的出现次序把涉及节点重排为 0..n；
        # 未涉及的兄弟节点保持原 position（可能与新值重叠，展示排序兜底 (position, id)）
        pos_counter: dict[int | None, int] = {}
        for node in resolved_nodes:
            base = pos_counter.get(node.parent_id, 0)
            node.position = base
            pos_counter[node.parent_id] = base + 1
            session.add(node)

        await _commit_with_revision(
            session, m, before=before, action="outline_applied", actor=actor,
            detail=f"apply_outline（mode={mode}，涉及 {len(entries)} 行）",
        )
        await session.refresh(m)
        return m


# ── 版本快照：查询与回滚 ───────────────────────────────────────────────


async def list_revisions(map_id: int) -> list[MapRevision]:
    """版本时间线：该图全部快照，version 降序（最新在前）。"""
    async with async_session() as session:
        await _get_map(session, map_id)
        rows = (
            await session.exec(
                select(MapRevision)
                .where(MapRevision.map_id == map_id)
                .order_by(MapRevision.version.desc())
            )
        ).all()
        return list(rows)


async def get_revision(map_id: int, version: int) -> tuple[MapRevision, dict]:
    """取某版本：元数据行 + 物化整树（原 snapshot JSON 形状）。

    MVCC 化后树内容按需物化（窗口函数亚毫秒），不再有整树快照列。
    """
    async with async_session() as session:
        await _get_map(session, map_id)
        rev = (
            await session.exec(
                select(MapRevision).where(
                    MapRevision.map_id == map_id, MapRevision.version == version
                )
            )
        ).first()
        if rev is None:
            raise ValueError(f"map {map_id} 没有版本 v{version} 的快照")
        snap = await materialize_tree(session, map_id, version)
        assert snap is not None  # 元数据行存在则节点行必在（同事务写入）
        return rev, snap


async def get_revision_changes(map_id: int, version: int) -> dict:
    """该版本相对上一版本的节点级变更（git log 风格：这个版本当时改了什么）。

    before 行 + undo 推导：after(v) = undo 回溯到 v 时刻的全树（该版本的
    行还没被撤销，正是 v 末态）；before(v) = 行内值本身。判型：deleted 行
    → removed（content=被删前内容）；值列全 NULL → added；否则按
    content > note > parent 比 before/after 判 changed/note/moved。
    **没有 folded 判型**——node 表折叠视图态可能领先版本，after 侧的
    collapsed 不可靠（会伪造徽章）。title_change 对比 map_revision 相邻行。
    """
    async with async_session() as session:
        await _get_map(session, map_id)
        rev = (
            await session.exec(
                select(MapRevision).where(
                    MapRevision.map_id == map_id, MapRevision.version == version
                )
            )
        ).first()
        if rev is None:
            raise ValueError(f"map {map_id} 没有版本 v{version} 的快照")
        prev_rev = (
            await session.exec(
                select(MapRevision)
                .where(MapRevision.map_id == map_id, MapRevision.version < version)
                .order_by(MapRevision.version.desc())  # type: ignore[attr-defined]
            )
        ).first()
        after = await _undo_to(session, map_id, version)  # v 末态全树
        vrows = (
            await session.exec(
                select(NodeRevision)
                .where(NodeRevision.map_id == map_id, NodeRevision.version == version)
                .order_by(NodeRevision.display_id)
            )
        ).all()

        rows: list[dict] = []
        for r in vrows:
            did = r.display_id
            if r.deleted:
                rows.append({"display_id": did, "kind": "removed",
                             "content": r.before["content"], "old_content": None})
                continue
            if r.before is None:
                rows.append({"display_id": did, "kind": "added",
                             "content": after[did]["content"], "old_content": None})
                continue
            a = after.get(did)
            if a is None:  # 行表示"变为不存在"？before 行语义下不应出现（防御）
                rows.append({"display_id": did, "kind": "removed",
                             "content": r.before["content"], "old_content": None})
            elif a["content"] != r.before["content"]:
                rows.append({"display_id": did, "kind": "changed", "content": a["content"],
                             "old_content": r.before["content"]})
            elif a["note"] != r.before["note"]:
                rows.append({"display_id": did, "kind": "note", "content": a["content"],
                             "old_content": None})
            elif a["parent"] != r.before["parent"]:
                rows.append({"display_id": did, "kind": "moved", "content": a["content"],
                             "old_content": None})
        return {
            "title_change": bool(prev_rev and rev.title != prev_rev.title),
            "old_title": prev_rev.title if prev_rev else None,
            "rows": rows,
        }


def _validate_snapshot(map_id: int, version: int, snap: dict) -> list[dict]:
    """快照结构校验：nodes 非空、display_id 唯一、恰一个根、父引用存在、无环/无孤岛。

    快照由 _build_snapshot 产生时天然满足；校验是防手改 DB / 未来格式演化的
    廉价护栏（坏数据宁可 400 也不静默建出一棵畸形树）。
    """
    nodes = snap.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        raise ValueError(f"map {map_id} v{version} 快照数据异常：nodes 为空")
    ids = [n["display_id"] for n in nodes]
    if len(set(ids)) != len(ids):
        raise ValueError(f"map {map_id} v{version} 快照数据异常：display_id 重复")
    by = {n["display_id"]: n for n in nodes}
    roots = [n for n in nodes if n["parent"] is None]
    if len(roots) != 1:
        raise ValueError(f"map {map_id} v{version} 快照数据异常：根节点数 ≠ 1")
    children: dict[int, list[int]] = {}
    for n in nodes:
        if n["parent"] is None:
            continue
        if n["parent"] not in by:
            raise ValueError(
                f"map {map_id} v{version} 快照数据异常：#{n['display_id']} 的父 #{n['parent']} 不存在"
            )
        children.setdefault(n["parent"], []).append(n["display_id"])
    seen: set[int] = set()
    stack = [roots[0]["display_id"]]  # 自根可达必须覆盖全部（防环/孤岛）
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        stack.extend(children.get(cur, ()))
    if len(seen) != len(nodes):
        raise ValueError(f"map {map_id} v{version} 快照数据异常：存在环或游离节点")
    return nodes


async def restore_revision(map_id: int, version: int, actor: str = "agent") -> Map:
    """回滚到指定版本的快照：整树重建为该版本状态（节点编号 display_id 保留）。

    语义：回滚本身是一次新 mutation —— version 继续前进、追加一个
    action='revision_restored' 的新快照，历史快照全部保留（因此可以再
    "回滚"到更晚的版本 = 前滚；撤销回滚 = 回到回滚前的版本即可）。
    title 随快照恢复；节点 updated_by/updated_at 记为本次回滚的 actor 与
    当前时间（快照里的历史值仅作展示——写入时间戳必须反映真实写入时刻，
    且不回写可使前端 diff 忽略这两字段后"回滚后 == vN"严格成立）。
    """
    async with async_session() as session:
        m = await _get_map(session, map_id)
        rev = (
            await session.exec(
                select(MapRevision).where(
                    MapRevision.map_id == map_id, MapRevision.version == version
                )
            )
        ).first()
        if rev is None:
            raise ValueError(f"map {map_id} 没有版本 v{version} 的快照")
        snap = await materialize_tree(session, map_id, version)
        assert snap is not None  # 元数据行存在则节点行必在
        snap_nodes = _validate_snapshot(map_id, version, snap)

        # before 快照：回滚前的当前树（此刻无挂起变更，node 表 = 回滚前事实）。
        # bulk delete 不进 session.deleted（core 路径），显式快照是唯一手段。
        # 回滚会【复活】的节点（目标树有、当前树无）必须补 None（insert 行），
        # 否则 undo 本版本时它们无法消失（物化回滚前版本会多出它们）
        before, _ = await _current_tree(session, map_id)
        for sn in snap_nodes:
            if sn["display_id"] not in before:
                before[sn["display_id"]] = None

        # 清空现有节点（core 批量，与 delete_map 同款）。同事务内先删后建：
        # INSERT 执行时旧行已在本事务删除，UNIQUE(map_id, display_id) 无冲突。
        await session.execute(delete(Node).where(Node.map_id == map_id))

        # 两遍重建（免拓扑排序）：先全部落库（parent_id=None）flush 拿新全局
        # id，再按 display_id→全局 id 映射接父子。
        by_display: dict[int, Node] = {}
        for sn in sorted(snap_nodes, key=lambda x: x["display_id"]):
            node = Node(
                map_id=map_id,
                display_id=sn["display_id"],
                parent_id=None,
                content=sn["content"],
                note=sn.get("note"),  # .get：旧快照无此 key（加字段前的历史版本）
                position=sn["position"],
                collapsed=sn["collapsed"],
                updated_by=actor,
            )
            session.add(node)
            by_display[sn["display_id"]] = node
        await session.flush()  # 分配新全局 id
        for sn in snap_nodes:
            if sn["parent"] is not None:
                node = by_display[sn["display_id"]]
                node.parent_id = by_display[sn["parent"]].id
                session.add(node)

        if snap.get("title"):
            m.title = snap["title"]
        await _commit_with_revision(
            session, m, before=before, action="revision_restored", actor=actor,
            detail=f"回滚到 v{version}（{rev.action}）",
        )
        await session.refresh(m)
        return m
