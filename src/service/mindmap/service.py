"""mindmap 域 UseCaseService —— REST / CLI / MCP / Compose GraphQL 的统一入口。

复用 methods.py 的业务逻辑，service 层只做 DTO 转换（不直接操作数据库）：
  list   → [Dto.model_validate(m) for m in models] → Resolver().resolve(dtos)
  单条   → Dto.model_validate(entity)              → Resolver().resolve(dto)
"""
from nexusx import UseCaseService, mutation, query
from src.models import Resolver
from src.service.mindmap import methods
from src.service.mindmap.dtos import (
    MapDetail,
    MapSummary,
    NodeDTO,
    RevisionDetail,
    RevisionSummary,
)


class MindmapService(UseCaseService):
    """人 + Agent 协同脑图：同一棵树的读写与整树重构。

    compose_query 调用约束（当前 nexusx 限制，详见 KLR-Pattern/nexusx#140）：
    一次调用只发一个 mutation 字段。GraphQL 别名多字段（a1: m(...) a2: m(...)）
    会被服务端静默折叠——只有最后一个字段执行，其余丢弃且不报错。
    批量写节点用 apply_outline 一次完成，不要别名循环 add_node。

    客户端建议（支持子代理的调用方）：建图、整树重构等多往返 MCP 批量任务
    建议委托 sub agent 执行——中间的树读取与逐次返回不占主 agent 上下文，
    只回摘要；单次 apply_outline 直接调用即可，无需委托。

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
        """Agent 读法：整树缩进 outline 文本，节点带 [id:N] 锚点。

        变更感知约定（按机制判断，不看身份）：若你的上下文没有
        <external_changes> 自动注入（外部 MCP/CLI/REST 调用方即是——服务端
        不推送变更，无法主动触达模型上下文），人机并行编辑时应在每轮写入前
        先读本接口核对最新全量树，避免基于过期认知覆盖用户修改；享有注入的
        页内 Agent 无需重复读取。
        """
        return await methods.get_tree(map_id)

    @query
    async def list_revisions(cls, map_id: int) -> list[RevisionSummary]:
        """版本时间线：某图全部快照，version 降序（最新在前）。
        v{N} 角标点开的面板数据源；不含快照体（列表轻量）。
        Agent 可用它审计"自己/用户上几轮各改了什么"。"""
        revs = await methods.list_revisions(map_id)
        return [RevisionSummary.model_validate(r) for r in revs]

    @query
    async def get_revision(cls, map_id: int, version: int) -> RevisionDetail:
        """取某版本的整树快照（title + nodes 列表，节点带
        display_id/parent/content/position/collapsed）。version 不存在时报错。"""
        rev = await methods.get_revision(map_id, version)
        return RevisionDetail.model_validate(rev)

    # ── mutations ─────────────────────────────────────────────────────

    @mutation
    async def create_map(cls, title: str, actor: str = "agent") -> MapDetail:
        """创建脑图（自动建根节点），返回含根节点的整树。若无 <external_changes> 注入（外部调用方即是），写前先 get_tree 核对最新树。"""
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
        """在 parent 下新增子节点（position=None 追加到末尾）。parent_id 为 map 内 display_id。若无 <external_changes> 注入（外部调用方即是），写前先 get_tree 核对最新树。
        禁止用别名在一次 mutation 里调多个 add_node（会被静默折叠，只执行最后一个）；批量新增请用 apply_outline。"""
        node = await methods.add_node(map_id, parent_id, content, position=position, actor=actor)
        dto = NodeDTO.model_validate(node)
        return await Resolver().resolve(dto)

    @mutation
    async def update_node(
        cls,
        map_id: int,
        node_id: int,
        content: str | None = None,
        collapsed: bool | None = None,
        actor: str = "agent",
    ) -> NodeDTO:
        """部分更新节点（content / collapsed）。node_id 为 map 内 display_id。若无 <external_changes> 注入（外部调用方即是），写前先 get_tree 核对最新树。"""
        node = await methods.update_node(map_id, node_id, content=content, collapsed=collapsed, actor=actor)
        dto = NodeDTO.model_validate(node)
        return await Resolver().resolve(dto)

    @mutation
    async def move_node(
        cls,
        map_id: int,
        node_id: int,
        new_parent_id: int,
        position: int | None = None,
        actor: str = "agent",
    ) -> NodeDTO:
        """移动节点（换父 / 同级重排）；禁止移到自己子树下（防环）。

        node_id / new_parent_id 均为 map 内 display_id。
        若无 <external_changes> 注入（外部调用方即是），写前先 get_tree 核对最新树。
        """
        node = await methods.move_node(map_id, node_id, new_parent_id, position=position, actor=actor)
        dto = NodeDTO.model_validate(node)
        return await Resolver().resolve(dto)

    @mutation
    async def delete_node(cls, map_id: int, node_id: int, actor: str = "agent") -> bool:
        """删除节点及其子树（根节点不可删除）。node_id 为 map 内 display_id。若无 <external_changes> 注入（外部调用方即是），写前先 get_tree 核对最新树。"""
        return await methods.delete_node(map_id, node_id, actor=actor)

    @mutation
    async def delete_map(cls, map_id: int, actor: str = "agent") -> bool:
        """删除整张脑图（map + 全部节点 + 版本快照），不可恢复。

        删除后向仍打开该图的客户端广播 map_deleted（浏览器自动退回列表）。
        若无 <external_changes> 注入（外部调用方即是），写前先 get_tree 核对最新树。
        """
        return await methods.delete_map(map_id, actor=actor)

    @mutation
    async def restore_revision(cls, map_id: int, version: int, actor: str = "agent") -> MapDetail:
        """回滚整树到指定版本的快照（节点编号 display_id 保留，title 一并恢复）。

        回滚本身是一次新 mutation：version 继续前进、历史快照全部保留——
        之后仍可回滚到更晚版本（前滚）。version 不存在时报错。
        Agent 可用它撤销自己上一轮的误操作。
        若无 <external_changes> 注入（外部调用方即是），写前先 get_tree 核对最新树。
        """
        m = await methods.restore_revision(map_id, version, actor=actor)
        dto = MapDetail.model_validate(m)
        return await Resolver().resolve(dto)

    @mutation
    async def expand_all(cls, map_id: int, actor: str = "agent") -> MapDetail:
        """展开全部节点（视图状态，不改变修改标记/时间戳）。若无 <external_changes> 注入（外部调用方即是），写前先 get_tree 核对最新树。"""
        m = await methods.expand_all(map_id, actor=actor)
        dto = MapDetail.model_validate(m)
        return await Resolver().resolve(dto)

    @mutation
    async def set_fold_level(cls, map_id: int, level: int, actor: str = "agent") -> MapDetail:
        """按层级批量收放视图：保留前 level 层可见，更深的子树收起（根 = 第 1 层）。

        level = 可见层数（off-by-one 注意）：第 level 层节点本身可见但被置为
        折叠，它的孩子（第 level+1 层起）隐藏；第 1..level-1 层全部展开。
        例（4 层树）：level=3 → 前三层可见、第 3 层节点收起、第 4 层隐藏；
        level=2 → 只看根和直接子节点（即"二级以下全部折叠"）。
        level ≥ 树深 = 全展开（等价 expand_all）；叶子节点不会被折叠。
        无实际变化时是空操作（version 不递增、不广播）。level 必须 ≥ 2。
        批量按层折叠/展开请用它，不要逐节点 update_node(collapsed=...)。
        若无 <external_changes> 注入（外部调用方即是），写前先 get_tree 核对最新树。
        """
        m = await methods.set_fold_level(map_id, level, actor=actor)
        dto = MapDetail.model_validate(m)
        return await Resolver().resolve(dto)

    @mutation
    async def apply_outline(
        cls,
        map_id: int,
        outline: str,
        mode: str = "merge",
        actor: str = "agent",
    ) -> MapDetail:
        """Agent 批量写法：按缩进 outline 整树写入。

        outline 格式（与 get_tree 输出同构，行级语法必须遵守）：
        - 每行以 "- " 开头：`- 内容` 或 `- [id:N] 内容`（N=display_id；
          有 id 锚定已有节点，无 id 新建）
        - 缩进每 2 个空格深一级，不能跳级；首行必须是无缩进的根，且只能一行

        示例：
          - [id:1] 根
            - [id:2] 已有子节点
            - 全新子节点
              - 孙节点（4 空格缩进 = 第二层）

        merge：[id:N] 锚定更新 + 无 id 新建 + 未提及保留（不误删）；
        replace：保留根节点，其余全删重建。
        若无 <external_changes> 注入（外部调用方即是），写前先 get_tree 核对最新树（本方法整树重写，过期认知的破坏面最大）。
        """
        m = await methods.apply_outline(map_id, outline, mode=mode, actor=actor)
        dto = MapDetail.model_validate(m)
        return await Resolver().resolve(dto)
