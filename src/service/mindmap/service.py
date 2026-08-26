"""mindmap 域 UseCaseService —— REST / CLI / MCP / Compose GraphQL 的统一入口。

复用 methods.py 的业务逻辑，service 层只做 DTO 转换（不直接操作数据库）：
  list   → [Dto.model_validate(m) for m in models] → Resolver().resolve(dtos)
  单条   → Dto.model_validate(entity)              → Resolver().resolve(dto)
"""
from nexusx import UseCaseService, mutation, query
from src.models import Resolver
from src.service.mindmap import methods
from src.service.mindmap.dtos import MapDetail, MapSummary, NodeDTO


class MindmapService(UseCaseService):
    """人 + Agent 协同脑图：同一棵树的读写与整树重构。

    actor 参数约定：Agent 端（CLI/MCP/REST 默认值）= 'agent'；
    浏览器前端调用时显式传 'human'——写入 node.updated_by 供前端高亮。
    """

    # ── queries ───────────────────────────────────────────────────────

    @query
    async def list_maps(cls) -> list[MapSummary]:
        """列出所有脑图（轻量摘要，不含节点）。"""
        maps = await methods.list_maps()
        dtos = [MapSummary.model_validate(m) for m in maps]
        return await Resolver().resolve(dtos)

    @query
    async def get_map(cls, map_id: int) -> MapDetail:
        """获取整棵脑图的结构化数据（前端渲染用）。"""
        m = await methods.get_map(map_id)
        dto = MapDetail.model_validate(m)
        return await Resolver().resolve(dto)

    @query
    async def get_tree(cls, map_id: int) -> str:
        """Agent 读法：整树缩进 outline 文本，节点带 [id:N] 锚点。"""
        return await methods.get_tree(map_id)

    # ── mutations ─────────────────────────────────────────────────────

    @mutation
    async def create_map(cls, title: str, actor: str = "agent") -> MapDetail:
        """创建脑图（自动建根节点），返回含根节点的整树。"""
        m = await methods.create_map(title, actor=actor)
        dto = MapDetail.model_validate(m)
        return await Resolver().resolve(dto)

    @mutation
    async def add_node(
        cls,
        map_id: int,
        parent_id: int,
        content: str,
        position: int | None = None,
        actor: str = "agent",
    ) -> NodeDTO:
        """在 parent 下新增子节点（position=None 追加到末尾）。"""
        node = await methods.add_node(map_id, parent_id, content, position=position, actor=actor)
        dto = NodeDTO.model_validate(node)
        return await Resolver().resolve(dto)

    @mutation
    async def update_node(
        cls,
        node_id: int,
        content: str | None = None,
        collapsed: bool | None = None,
        actor: str = "agent",
    ) -> NodeDTO:
        """部分更新节点（content / collapsed）。"""
        node = await methods.update_node(node_id, content=content, collapsed=collapsed, actor=actor)
        dto = NodeDTO.model_validate(node)
        return await Resolver().resolve(dto)

    @mutation
    async def move_node(
        cls,
        node_id: int,
        new_parent_id: int,
        position: int | None = None,
        actor: str = "agent",
    ) -> NodeDTO:
        """移动节点（换父 / 同级重排）；禁止移到自己子树下（防环）。"""
        node = await methods.move_node(node_id, new_parent_id, position=position, actor=actor)
        dto = NodeDTO.model_validate(node)
        return await Resolver().resolve(dto)

    @mutation
    async def delete_node(cls, node_id: int, actor: str = "agent") -> bool:
        """删除节点及其子树（根节点不可删除）。"""
        return await methods.delete_node(node_id, actor=actor)

    @mutation
    async def apply_outline(
        cls,
        map_id: int,
        outline: str,
        mode: str = "merge",
        actor: str = "agent",
    ) -> MapDetail:
        """Agent 批量写法：按缩进 outline 整树写入。

        merge：[id:N] 锚定更新 + 无 id 新建 + 未提及保留（不误删）；
        replace：保留根节点，其余全删重建。
        """
        m = await methods.apply_outline(map_id, outline, mode=mode, actor=actor)
        dto = MapDetail.model_validate(m)
        return await Resolver().resolve(dto)
