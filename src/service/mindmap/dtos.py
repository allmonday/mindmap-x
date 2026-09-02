"""mindmap 域响应 DTO。

注意：不使用 `from __future__ import annotations`（会使注解变字符串，
SubsetMeta 无法检测 Annotated 元数据）；DTO 关系字段必须用 DTO 类型。

ID 语义：对外只暴露 display_id（map 内编号，每图从 1 起）。
parent_id 是全局内部键——前端仅用于组装树结构，不作为 API 参数传递；
操作父节点（如加兄弟节点）用 parent.display_id。
"""
from typing import List, Optional

from nexusx import DefineSubset, SubsetConfig
from pydantic import BaseModel

from src.models import Map, MapRevision, Node


class MapSummary(DefineSubset):
    """图列表页的轻量摘要。"""

    __subset__ = (Map, ("id", "title", "version", "created_at"))


class NodeRef(DefineSubset):
    """父节点引用（只带操作编号，防止 parent 链递归加载）。"""

    __subset__ = SubsetConfig(
        kls=Node,
        omit_fields=[
            "id",  # 全局主键：DataLoader 内部仍用作键，但从输出剔除
            "map_id",
            "parent_id",
            "content",
            "note",  # markdown 长文不随 parent 引用膨胀（全树 N 个节点 × N 个引用）
            "position",
            "collapsed",
            "updated_by",
            "updated_at",
        ],
    )


class NodeDTO(DefineSubset):
    """节点视图。

    display_id 是对外 ID 语义（REST/CLI/MCP 参数、outline [id:N]、前端角标）；
    parent_id 为全局内部键（组树结构用），parent 关系由 DataLoader 批量加载，
    前端取 parent.display_id 作为"父节点操作编号"。全局主键 id 不出现在输出中。
    """

    __subset__ = SubsetConfig(
        kls=Node,
        omit_fields=["id"],
    )

    # 字段名匹配 Node.parent 关系 → Resolver implicit auto-load（DataLoader 批量）
    parent: Optional[NodeRef] = None


class MapDetail(DefineSubset):
    """整树视图：前端编辑器渲染所需的结构化数据。"""

    __subset__ = (Map, ("id", "title", "version", "created_at"))

    # 字段名匹配 Map.nodes 关系 → Resolver implicit auto-load（DataLoader 批量）
    nodes: List[NodeDTO] = []


class RevisionSummary(DefineSubset):
    """版本时间线条目（轻量，不含快照体）。"""

    __subset__ = (
        MapRevision,
        ("id", "map_id", "version", "action", "actor", "detail", "created_at"),
    )


class RevisionNodeDTO(BaseModel):
    """快照内的节点（display_id 语义：parent 是父节点 display_id，根为 None）。"""

    display_id: int
    parent: Optional[int]
    content: str
    note: Optional[str] = None  # 默认值兼容旧快照（无此 key 的历史 JSON）
    position: int
    collapsed: bool
    updated_by: str
    updated_at: str  # ISO 字符串（JSON 无 datetime）


class RevisionSnapshotDTO(BaseModel):
    """整树快照（模型层存 sa.JSON dict，DTO 层转嵌套模型——compose schema
    不支持裸 dict，Pydantic 嵌套模型同时让 GraphQL 面成为结构化类型）。"""

    title: str
    nodes: List[RevisionNodeDTO]


class RevisionChangeRowDTO(BaseModel):
    """版本间变更行：该版本相对上一版本，一个节点的一项变化。

    kind 语义（注意与旧"回滚预览"视角相反——这是该版本当时发生的事）：
    added=本版新增 / removed=本版删除 / changed=标题改（old_content 为改前）
    / note=备注改 / moved=换父 / folded=收放。
    """

    display_id: int
    kind: str
    content: str
    old_content: Optional[str] = None


class RevisionChangesDTO(BaseModel):
    """版本间变更集（get_revision_changes 返回体）。"""

    title_change: bool
    old_title: Optional[str] = None  # 上一版本的标题（title_change 时展示"旧 → 新"）
    rows: List[RevisionChangeRowDTO]


class RevisionDetail(DefineSubset):
    """单个版本快照（含整树，前端 diff 用）。"""

    # snapshot 不进白名单——白名单字段的类型取自模型（dict 会让 compose schema
    # 构建失败）；像 MapDetail.nodes 一样在类体显式声明为嵌套 DTO 类型
    __subset__ = (
        MapRevision,
        ("id", "map_id", "version", "action", "actor", "detail", "created_at"),
    )

    snapshot: RevisionSnapshotDTO
