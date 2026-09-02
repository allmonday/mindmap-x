"""mindmap 域 UseCaseService —— REST / CLI / MCP / Compose GraphQL 的统一入口。

复用 methods.py 的业务逻辑，service 层只做 DTO 转换（不直接操作数据库）：
  list   → [Dto.model_validate(m) for m in models] → Resolver().resolve(dtos)
  单条   → Dto.model_validate(entity)              → Resolver().resolve(dto)
"""
from typing import Annotated

from nexusx import UseCaseService, mutation, query
from nexusx.use_case import FromContext
from src.models import Resolver
from src.service.mindmap import methods
from src.service.mindmap.dtos import (
    MapDetail,
    MapSummary,
    NodeDTO,
    RevisionChangeRowDTO,
    RevisionChangesDTO,
    RevisionDetail,
    RevisionNodeDTO,
    RevisionSnapshotDTO,
    RevisionSummary,
)

# 页内 Agent 自调 MCP 时携带的来源标记（chat.py 的 MCPClient headers），
# 由 main.py 的 context_extractor 从请求头提取注入。
PAGE_AGENT_SOURCE = "page-agent"


def _resolve_actor(actor: str, source: str | None) -> str:
    """FromContext 来源标记 → actor 值映射。

    页内 Agent 的 MCP 调用带 X-Mindmap-Source: page-agent（chat.py 配置），
    映射为专属 actor 'page_agent'——events 层据此把它排除在 External
    Changes 待通知缓冲外（自己的改动 toolResult 已自知，注入回去是回声）。
    其余调用方（外部 MCP/CLI/REST agent、浏览器 human）不带标记，source
    为 None，actor 原样返回。
    """
    return "page_agent" if source == PAGE_AGENT_SOURCE else actor


class MindmapService(UseCaseService):
    """人 + Agent 协同脑图：同一棵树的读写与整树重构。

    compose_query 调用约束（当前 nexusx 限制，详见 KLR-Pattern/nexusx#140）：
    一次调用只发一个 mutation 字段。GraphQL 别名多字段（a1: m(...) a2: m(...)）
    会被服务端静默折叠——只有最后一个字段执行，其余丢弃且不报错。
    批量写节点用 apply_outline 一次完成，不要别名循环 add_node。

    客户端建议（支持子代理的调用方）：建图、整树重构等多往返 MCP 批量任务
    建议委托 sub agent 执行——中间的树读取与逐次返回不占主 agent 上下文，
    只回摘要；单次 apply_outline 直接调用即可，无需委托。

    actor 参数约定：浏览器前端显式传 'human'（写入 node.updated_by 供前端
    高亮）；CLI/MCP/REST 默认 'agent'。页内 Agent 的 MCP 调用经
    X-Mindmap-Source header 自动识别为 'page_agent'（source FromContext
    参数映射，调用方不感知）——events 层据此豁免 External Changes 记录；
    其余外部 agent 的写入会进页内 Agent 的 <external_changes> 注入。
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
        页内 Agent 无需重复读取（你经 MCP 的写入也会进它的注入清单）。
        """
        return await methods.get_tree(map_id)

    @query
    async def get_node(cls, map_id: int, node_id: int) -> NodeDTO:
        """读单个节点全文（content + note markdown）。node_id 为 map 内 display_id。

        Agent 写 note 后的读回入口——get_tree/outline 行协议不含 note。
        """
        node = await methods.get_node(map_id, node_id)
        dto = NodeDTO.model_validate(node)
        return await Resolver().resolve(dto)

    @query
    async def list_revisions(cls, map_id: int) -> list[RevisionSummary]:
        """版本时间线：某图全部快照，version 降序（最新在前）。
        v{N} 角标点开的面板数据源；不含快照体（列表轻量）。
        Agent 可用它审计"自己/用户上几轮各改了什么"。"""
        revs = await methods.list_revisions(map_id)
        return [RevisionSummary.model_validate(r) for r in revs]

    @query
    async def get_revision(cls, map_id: int, version: int) -> RevisionDetail:
        """取某版本（title + nodes 列表，节点带
        display_id/parent/content/note/position/collapsed）。version 不存在时报错。

        树内容由 node_revision 行物化（MVCC；对外 shape 与整树快照时代一致）。"""
        rev, snap = await methods.get_revision(map_id, version)
        return RevisionDetail(
            id=rev.id, map_id=rev.map_id, version=rev.version, action=rev.action,
            actor=rev.actor, detail=rev.detail, created_at=rev.created_at,
            snapshot=RevisionSnapshotDTO(
                title=snap["title"],
                nodes=[RevisionNodeDTO(**n) for n in snap["nodes"]],
            ),
        )

    @query
    async def get_revision_changes(cls, map_id: int, version: int) -> RevisionChangesDTO:
        """该版本相对上一版本的节点级变更（git log 风格）。

        注意语义：这是"这个版本当时改了什么"，不是回滚影响预览（与旧前端的
        快照 vs 当前树比较相反）。首版本（无更早版本）全部按 added。
        kind：added / removed / changed(old_content=改前) / note / moved / folded。
        """
        changes = await methods.get_revision_changes(map_id, version)
        return RevisionChangesDTO(
            title_change=changes["title_change"],
            old_title=changes.get("old_title"),
            rows=[RevisionChangeRowDTO(**r) for r in changes["rows"]],
        )

    # ── mutations ─────────────────────────────────────────────────────

    @mutation
    async def create_map(
        cls,
        title: str,
        actor: str = "agent",
        source: Annotated[str | None, FromContext()] = None,
    ) -> MapDetail:
        """创建脑图（自动建根节点），返回含根节点的整树。若无 <external_changes> 注入（外部调用方即是），写前先 get_tree 核对最新树。"""
        m = await methods.create_map(title, actor=_resolve_actor(actor, source))
        dto = MapDetail.model_validate(m)
        return await Resolver().resolve(dto)

    @mutation
    async def add_node(
        cls,
        map_id: int,
        parent_id: int,
        content: str,
        position: int | None = None,
        note: str | None = None,
        actor: str = "agent",
        source: Annotated[str | None, FromContext()] = None,
    ) -> NodeDTO:
        """在 parent 下新增子节点（position=None 追加到末尾；可带初始 note，空串归一为无备注）。parent_id 为 map 内 display_id。若无 <external_changes> 注入（外部调用方即是），写前先 get_tree 核对最新树。
        禁止用别名在一次 mutation 里调多个 add_node（会被静默折叠，只执行最后一个）；批量新增请用 apply_outline。"""
        node = await methods.add_node(
            map_id, parent_id, content, position=position, note=note, actor=_resolve_actor(actor, source)
        )
        dto = NodeDTO.model_validate(node)
        return await Resolver().resolve(dto)

    @mutation
    async def update_node(
        cls,
        map_id: int,
        node_id: int,
        content: str | None = None,
        collapsed: bool | None = None,
        note: str | None = None,
        actor: str = "agent",
        source: Annotated[str | None, FromContext()] = None,
    ) -> NodeDTO:
        """部分更新节点（content / collapsed / note）。node_id 为 map 内 display_id。

        note 语义：None=不动；空串 ""=清空（存 null）。长内容写 note 而非撑长 content。
        若无 <external_changes> 注入（外部调用方即是），写前先 get_tree 核对最新树。
        """
        node = await methods.update_node(
            map_id, node_id, content=content, collapsed=collapsed, note=note, actor=_resolve_actor(actor, source)
        )
        dto = NodeDTO.model_validate(node)
        return await Resolver().resolve(dto)

    @mutation
    async def set_node_collapsed(
        cls,
        map_id: int,
        node_id: int,
        collapsed: bool,
        actor: str = "agent",
        client_request_id: str | None = None,
        source: Annotated[str | None, FromContext()] = None,
    ) -> bool:
        """设置单节点折叠状态。REST 返回 204；GraphQL/MCP 仅返回是否发生变化。"""
        return await methods.set_node_collapsed(
            map_id,
            node_id,
            collapsed,
            actor=_resolve_actor(actor, source),
            client_request_id=client_request_id,
        )

    @mutation
    async def move_node(
        cls,
        map_id: int,
        node_id: int,
        new_parent_id: int,
        position: int | None = None,
        actor: str = "agent",
        source: Annotated[str | None, FromContext()] = None,
    ) -> NodeDTO:
        """移动节点（换父 / 同级重排）；禁止移到自己子树下（防环）。

        node_id / new_parent_id 均为 map 内 display_id。
        若无 <external_changes> 注入（外部调用方即是），写前先 get_tree 核对最新树。
        """
        node = await methods.move_node(
            map_id, node_id, new_parent_id, position=position, actor=_resolve_actor(actor, source)
        )
        dto = NodeDTO.model_validate(node)
        return await Resolver().resolve(dto)

    @mutation
    async def delete_node(
        cls,
        map_id: int,
        node_id: int,
        actor: str = "agent",
        source: Annotated[str | None, FromContext()] = None,
    ) -> bool:
        """删除节点及其子树（根节点不可删除）。node_id 为 map 内 display_id。若无 <external_changes> 注入（外部调用方即是），写前先 get_tree 核对最新树。"""
        return await methods.delete_node(map_id, node_id, actor=_resolve_actor(actor, source))

    @mutation
    async def delete_map(
        cls,
        map_id: int,
        actor: str = "agent",
        source: Annotated[str | None, FromContext()] = None,
    ) -> bool:
        """删除脑图（软删除）：对外立即不可见（列表不出现、读取 not found），
        行/节点/快照/聊天会话保留——rowid 不复用，新建图永不拿到旧 id。
        暂无恢复入口（DB 层可手工恢复：清空 deleted_at 即回）。

        删除后向仍打开该图的客户端广播 map_deleted（浏览器自动退回列表）。
        若无 <external_changes> 注入（外部调用方即是），写前先 get_tree 核对最新树。
        """
        return await methods.delete_map(map_id, actor=_resolve_actor(actor, source))

    @mutation
    async def restore_revision(
        cls,
        map_id: int,
        version: int,
        actor: str = "agent",
        source: Annotated[str | None, FromContext()] = None,
    ) -> MapDetail:
        """回滚整树到指定版本的快照（节点编号 display_id 保留，title 一并恢复）。

        回滚本身是一次新 mutation：version 继续前进、历史快照全部保留——
        之后仍可回滚到更晚版本（前滚）。version 不存在时报错。
        Agent 可用它撤销自己上一轮的误操作。
        若无 <external_changes> 注入（外部调用方即是），写前先 get_tree 核对最新树。
        """
        m = await methods.restore_revision(map_id, version, actor=_resolve_actor(actor, source))
        dto = MapDetail.model_validate(m)
        return await Resolver().resolve(dto)

    @mutation
    async def expand_all(
        cls,
        map_id: int,
        actor: str = "agent",
        client_request_id: str | None = None,
        source: Annotated[str | None, FromContext()] = None,
    ) -> bool:
        """展开全部节点。REST 返回 204；GraphQL/MCP 仅返回是否完成。"""
        await methods.expand_all(
            map_id,
            actor=_resolve_actor(actor, source),
            client_request_id=client_request_id,
        )
        return True

    @mutation
    async def set_fold_level(
        cls,
        map_id: int,
        level: int,
        actor: str = "agent",
        client_request_id: str | None = None,
        source: Annotated[str | None, FromContext()] = None,
    ) -> bool:
        """按层级批量收放视图：保留前 level 层可见，更深的子树收起（根 = 第 1 层）。

        level = 可见层数（off-by-one 注意）：第 level 层节点本身可见但被置为
        折叠，它的孩子（第 level+1 层起）隐藏；第 1..level-1 层全部展开。
        例（4 层树）：level=3 → 前三层可见、第 3 层节点收起、第 4 层隐藏；
        level=2 → 只看根和直接子节点（即"二级以下全部折叠"）。
        level ≥ 树深 = 全展开（等价 expand_all）；叶子节点不会被折叠。
        无实际变化时是空操作（version 不递增、不广播）。level 必须 ≥ 2。
        批量按层折叠/展开请用它，不要逐节点 update_node(collapsed=...)。
        若无 <external_changes> 注入（外部调用方即是），写前先 get_tree 核对最新树。
        REST 返回 204；GraphQL/MCP 仅返回是否完成。
        """
        await methods.set_fold_level(
            map_id,
            level,
            actor=_resolve_actor(actor, source),
            client_request_id=client_request_id,
        )
        return True

    @mutation
    async def apply_outline(
        cls,
        map_id: int,
        outline: str,
        mode: str = "merge",
        actor: str = "agent",
        source: Annotated[str | None, FromContext()] = None,
    ) -> MapDetail:
        """Agent 批量写法：按缩进 outline 整树写入。

        ⚠ 这是**全量结构写入**，不是局部补丁：outline 描述的是写入后整棵子树
        应有的样子。两条最常见的误用：
        - 只改一个节点的内容/备注 → 用 update_node，不要用本方法
        - **缩进即父子关系**：锚定 [id:N] 行的层级必须精确还原该节点在树中的
          真实深度（照抄 get_tree 输出的缩进）——写浅了节点会被**移动**到新父
          之下（如写在根下第二层 = 挂到根节点下方），写深了同理

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
        replace：保留根节点，其余全删重建。outline 行不含 note——锚定 [id:N]
        节点的 note 自动保留（replace 下按旧号带回），不会因此丢失。
        若无 <external_changes> 注入（外部调用方即是），写前先 get_tree 核对最新树（本方法整树重写，过期认知的破坏面最大）。
        """
        m = await methods.apply_outline(map_id, outline, mode=mode, actor=_resolve_actor(actor, source))
        dto = MapDetail.model_validate(m)
        return await Resolver().resolve(dto)
