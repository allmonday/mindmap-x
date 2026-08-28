"""mindmap domain — 独立业务方法。

方法为普通 async 函数（不含 cls），由 models.mount_method() 桥接挂载到 Map 实体。

接口约定：
- **节点 ID 语义 = display_id（map 内编号，每图从 1 起）**。全局主键 node.id
  仅作内部 FK/环检测使用，不对外暴露。所有单节点操作以 (map_id, display_id) 定位。
- ``actor`` 参数标识修改来源（'human' / 'agent'），写入 node.updated_by，
  前端据此高亮 Agent 修改的节点。Agent 端（CLI/MCP/REST）默认 'agent'，
  浏览器前端调用时显式传 'human'。
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
from src.models import Map, Node
from src.service.mindmap.events import drain_pending, publish_change

_LINE_RE = re.compile(r"^-\s*(?:\[id:(\d+)\]\s*)?(.*)$")
INDENT_UNIT = 2


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── helpers ───────────────────────────────────────────────────────────


def _render_outline(nodes: list[Node]) -> str:
    """把节点集合渲染为缩进 outline 文本（[id:N] 为 display_id）。"""
    by_parent: dict[int | None, list[Node]] = {}
    for n in sorted(nodes, key=lambda x: (x.position, x.id)):
        by_parent.setdefault(n.parent_id, []).append(n)

    lines: list[str] = []

    def walk(node: Node, depth: int) -> None:
        lines.append("  " * depth + f"- [id:{node.display_id}] {node.content}")
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
        entries.append((level, display_id, m.group(2).strip()))
        prev_level = level
    if not entries:
        raise ValueError("outline 为空")
    if entries[0][0] != 0:
        raise ValueError("outline 第一行必须是根节点（无缩进）")
    if sum(1 for lvl, _, _ in entries if lvl == 0) > 1:
        raise ValueError("outline 只能有一个根节点（level 0 的行只能有一行）")
    return entries


async def _get_map(session, map_id: int) -> Map:
    m = await session.get(Map, map_id)
    if m is None:
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


# ── queries ───────────────────────────────────────────────────────────


async def list_maps() -> list[Map]:
    """列出所有脑图。"""
    async with async_session() as session:
        result = await session.exec(select(Map).order_by(Map.id))
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
        m.version = 1
        await session.commit()
        await session.refresh(m)
        publish_change(m.id, m.version, "map_created", actor)
        return m


async def add_node(
    map_id: int,
    parent_id: int,
    content: str,
    position: int | None = None,
    actor: str = "agent",
) -> Node:
    """在 parent 下新增子节点。

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
            updated_by=actor,
        )
        session.add(node)
        m.version += 1
        session.add(m)
        await session.commit()
        await session.refresh(node)
        publish_change(
            map_id, m.version, "node_added", actor,
            detail=f"add_node #{node.display_id}「{content}」（父 #{parent_id}）",
        )
        return node


async def update_node(
    map_id: int,
    node_id: int,
    content: str | None = None,
    collapsed: bool | None = None,
    actor: str = "agent",
) -> Node:
    """部分更新节点（content / collapsed），刷新 updated_by 与 updated_at。

    node_id 语义为 map 内 display_id。
    """
    async with async_session() as session:
        node = await _get_node(session, map_id, node_id)
        m = await _get_map(session, map_id)
        if content is not None:
            node.content = content
        if collapsed is not None:
            node.collapsed = collapsed
        node.updated_by = actor
        node.updated_at = _now()
        m.version += 1
        session.add(node)
        session.add(m)
        await session.commit()
        await session.refresh(node)
        changes: list[str] = []
        if content is not None:
            changes.append(f"内容→「{content}」")
        if collapsed is not None:
            changes.append("折叠" if collapsed else "展开")
        publish_change(
            m.id, m.version, "node_updated", actor,
            detail=f"update_node #{node_id} {'，'.join(changes)}",
        )
        return node


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
        m.version += 1
        session.add(node)
        session.add(m)
        await session.commit()
        await session.refresh(node)
        publish_change(
            m.id, m.version, "node_moved", actor,
            detail=f"move_node #{node_id} → 父 #{new_parent_id}",
        )
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
        for nid in ids:
            n = await session.get(Node, nid)
            if n is not None:
                await session.delete(n)
        m.version += 1
        session.add(m)
        await session.commit()
        publish_change(
            m.id, m.version, "node_deleted", actor,
            detail=f"delete_node #{node_id}（含 {len(ids) - 1} 个后代）",
        )
        return True


async def delete_map(map_id: int, actor: str = "agent") -> bool:
    """删除整张脑图（map 行 + 全部节点，单事务，不可恢复）。

    附带清理：commit 后向仍打开该图的 WS 客户端广播 map_deleted（前端收到后
    自动退回列表），并清空该图的外部改动待通知缓冲。聊天归档不级联——它按
    map_id 查询，图不存在即不可达，留作历史记录。
    """
    async with async_session() as session:
        m = await _get_map(session, map_id)
        next_version = m.version + 1  # 图即将不存在，version 仅用于事件单调
        await session.execute(delete(Node).where(Node.map_id == map_id))
        await session.delete(m)
        await session.commit()
    # 先 commit 再广播：订阅者收到事件后重拉 get_map 应当看到 404
    publish_change(map_id, next_version, "map_deleted", actor)
    drain_pending(map_id)
    return True


async def expand_all(map_id: int, actor: str = "agent") -> Map:
    """展开全部节点（collapsed=False），单事务批量更新。

    语义注意：折叠是视图状态而非内容修改 —— 不刷新 updated_by/updated_at
    （否则 Agent 修改角标会误亮），但 version 递增以驱动客户端刷新。
    全图已展开时是空操作：不递增 version（version 是变更信号，无变更不 bump，
    否则标题 v{N} 白跳）。get_tree 不感知 collapsed，因此不向 Agent 通知。
    """
    async with async_session() as session:
        m = await _get_map(session, map_id)
        folded = (
            await session.exec(
                select(Node).where(Node.map_id == map_id, Node.collapsed == True)  # noqa: E712
            )
        ).all()
        if not folded:
            return m  # 空操作：version 不动、不广播、不入 Agent 通知缓冲
        for n in folded:
            n.collapsed = False
            session.add(n)
        m.version += 1
        session.add(m)
        await session.commit()
        publish_change(
            map_id, m.version, "expanded_all", actor,
        )
        return m


async def set_fold_level(map_id: int, level: int, actor: str = "agent") -> Map:
    """按层级批量收放：保留前 level 层可见（根 = 第 1 层），更深的子树收起。

    声明式语义 —— 每个节点按深度直接取目标态，而非增量操作：
    - 有孩子且深度 ≥ level → collapsed=True（其子树隐藏）
    - 有孩子且深度 < level → collapsed=False（展开）
    - 叶子节点恒 False：collapsed 对叶子无意义，置 True 会留下幽灵状态，
      且破坏 expand_all 的 no-op 短路（它会捞到 collapsed==True 的叶子）
    level ≥ 树深时全部节点目标态为 False，等价于 expand_all。

    视图状态语义与 expand_all 一致：不刷新 updated_by/updated_at
    （否则 Agent 修改角标会误亮），但 version 递增以驱动客户端刷新。
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
            return m  # 空操作：version 不动、不广播、不入 Agent 通知缓冲
        m.version += 1
        session.add(m)
        await session.commit()
        publish_change(map_id, m.version, "folded_to_level", actor)
        return m


async def apply_outline(
    map_id: int,
    outline: str,
    mode: str = "merge",
    actor: str = "agent",
) -> Map:
    """整树写入：按缩进 outline 文本 merge 或 replace 脑图。

    [id:N] 中的 N 是 map 内 display_id。
    merge   —— 有 [id:N] 的行更新 content 并按缩进调整父子/顺序（锚定节点保留
               原 display_id）；无 id 的行新建（分配 map 内下一个号）；树中
               未出现的节点保留（不误删）。
    replace —— 保留根节点（content 更新为 outline 首行），其余全删重建，
               display_id 按 outline 顺序重排为 1..n。
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
                if display_id is not None:
                    raise ValueError(
                        f"[id:{display_id}] 不是 map {map_id} 的节点编号（不能跨图锚定）"
                    )
                node = Node(
                    map_id=map_id,
                    display_id=next_display,
                    parent_id=parent_gid,
                    content=content,
                    position=0,
                    updated_by=actor,
                )
                next_display += 1
                session.add(node)
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

        m.version += 1
        session.add(m)
        await session.commit()
        await session.refresh(m)
        publish_change(
            map_id, m.version, "outline_applied", actor,
            detail=f"apply_outline（mode={mode}，涉及 {len(entries)} 行）",
        )
        return m
