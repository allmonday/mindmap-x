"""mindmap 域响应 DTO。

注意：不使用 `from __future__ import annotations`（会使注解变字符串，
SubsetMeta 无法检测 Annotated 元数据）；DTO 关系字段必须用 DTO 类型。
"""
from typing import List

from nexusx import DefineSubset

from src.models import Map, Node


class MapSummary(DefineSubset):
    """图列表页的轻量摘要。"""

    __subset__ = (Map, ("id", "title", "version", "created_at"))


class NodeDTO(DefineSubset):
    """节点视图。

    parent_id / map_id 刻意保留：树结构里父子引用是领域概念（前端组装树、
    Agent 锚定节点都依赖），不属于 DefineSubset 通常要隐藏的内部 FK。
    """

    __subset__ = (
        Node,
        (
            "id",
            "map_id",
            "parent_id",
            "content",
            "position",
            "collapsed",
            "updated_by",
            "updated_at",
        ),
    )


class MapDetail(DefineSubset):
    """整树视图：前端编辑器渲染所需的结构化数据。"""

    __subset__ = (Map, ("id", "title", "version", "created_at"))

    # 字段名匹配 Map.nodes 关系 → Resolver implicit auto-load（DataLoader 批量）
    nodes: List[NodeDTO] = []
