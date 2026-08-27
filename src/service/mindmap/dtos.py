"""mindmap 域响应 DTO。

注意：不使用 `from __future__ import annotations`（会使注解变字符串，
SubsetMeta 无法检测 Annotated 元数据）；DTO 关系字段必须用 DTO 类型。

ID 语义：对外只暴露 display_id（map 内编号，每图从 1 起）。
parent_id 是全局内部键——前端仅用于组装树结构，不作为 API 参数传递；
操作父节点（如加兄弟节点）用 parent.display_id。
"""
from typing import List, Optional

from nexusx import DefineSubset, SubsetConfig

from src.models import Map, Node


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
