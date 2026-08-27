"""Phase 1→2: SQLModel entity definitions.

Phase 1: Pure entity fields + Relationship declarations (no methods).
Phase 2: Method mounting from service/mindmap/methods.py via mount_method().

Entity graph:
    Map ──1:N──→ Node ──1:N──→ Node (self-referencing tree via parent_id)

注意（模板踩坑 #8）：本文件使用显式 `List["Node"]` / `Optional["Node"]` 写法，
不使用 `from __future__ import annotations`，避免 SQLAlchemy 关系目标解析为
字符串 "list[Node]" 导致 InvalidRequestError。
"""
from datetime import datetime, timezone
from typing import List, Optional

from sqlmodel import Field, Relationship, SQLModel

from src.db import async_session


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class BaseEntity(SQLModel):
    """All entities inherit from this base class for shared metadata discovery."""


class Map(BaseEntity, table=True):
    """一棵脑图（一个独立的树形文档），是本系统唯一的聚合根。

    Human 在浏览器编辑、Agent 经 CLI/MCP/REST 读写的是同一棵 Map 树；
    version 每次被任何一方修改后递增，客户端据此判断断线期间是否错过了变更。
    """

    id: Optional[int] = Field(default=None, primary_key=True, description="脑图唯一标识")
    title: str = Field(description="脑图标题")
    version: int = Field(
        default=1,
        description="树版本号，每次 mutation 递增；客户端重连时对比版本决定是否全量重拉",
    )
    created_at: datetime = Field(
        default_factory=_utcnow,
        description="创建时间（UTC）",
    )

    # ORM relationships (noload: use explicit queries or Resolver DataLoader)
    nodes: List["Node"] = Relationship(
        back_populates="map",
        sa_relationship_kwargs={"lazy": "noload"},
    )


class Node(BaseEntity, table=True):
    """脑图上的一个节点，通过 parent_id 自引用形成树。

    updated_by 标记最后一次修改来自 human 还是 agent —— 协同可见性的关键，
    前端据此给 Agent 修改过的节点做高亮，Human 一眼看到"AI 刚动了哪里"。

    双 ID 架构：id 是全局主键（parent_id 自引用 FK、内部环检测用），
    display_id 是 map 内编号（每图从 1 起，UNIQUE(map_id, display_id)）——
    对外接口（REST/CLI/MCP 参数、outline [id:N]、前端角标）只用 display_id。
    """

    id: Optional[int] = Field(default=None, primary_key=True, description="全局主键（内部使用，不对外暴露）")
    display_id: int = Field(
        description="map 内节点编号，每图从 1 起；对外接口与 outline 协议的唯一 ID 语义",
    )
    map_id: int = Field(foreign_key="map.id", description="所属脑图 ID")
    parent_id: Optional[int] = Field(
        default=None,
        foreign_key="node.id",
        description="父节点全局主键（内部使用）；根节点为 None（每棵 Map 恰有一个根节点）",
    )
    content: str = Field(description="节点文本内容")
    position: int = Field(
        default=0,
        description="同级节点中的排序序号，越小越靠前",
    )
    collapsed: bool = Field(
        default=False,
        description="前端折叠状态：True 时子树在界面上收起",
    )
    updated_by: str = Field(
        default="human",
        description="最后修改者来源：'human'（浏览器编辑）或 'agent'（CLI/MCP/REST 修改）",
    )
    updated_at: datetime = Field(
        default_factory=_utcnow,
        description="最后修改时间（UTC），每次内容变更刷新",
    )

    # ORM relationships (noload)
    map: Optional["Map"] = Relationship(
        back_populates="nodes",
        sa_relationship_kwargs={"lazy": "noload"},
    )
    parent: Optional["Node"] = Relationship(
        back_populates="children",
        sa_relationship_kwargs={"lazy": "noload", "remote_side": "Node.id"},
    )
    children: List["Node"] = Relationship(
        back_populates="parent",
        sa_relationship_kwargs={"lazy": "noload", "order_by": "Node.position"},
    )


# ── Method mounting (Phase 2) ─────────────────────────────────────────


def mount_method():
    """挂载 service methods 到 entity classes。需在外部显式调用。"""
    import functools

    from nexusx import mutation, query
    from src.service.mindmap.methods import (
        add_node,
        apply_outline,
        create_map,
        delete_node,
        get_tree,
        list_maps,
        move_node,
        update_node,
    )

    def _mount(entity, fn, decorator):
        @functools.wraps(fn)
        async def wrapper(cls, *args, **kwargs):
            return await fn(*args, **kwargs)

        setattr(entity, fn.__name__, decorator(wrapper))

    _mount(Map, list_maps, query)
    _mount(Map, create_map, mutation)
    _mount(Map, get_tree, query)
    _mount(Map, add_node, mutation)
    _mount(Map, update_node, mutation)
    _mount(Map, move_node, mutation)
    _mount(Map, delete_node, mutation)
    _mount(Map, apply_outline, mutation)


# ── ErManager + Resolver ──────────────────────────────────────────────
from nexusx import ErManager  # noqa: E402

er = ErManager(
    entities=[Map, Node],
    session_factory=async_session,
)
Resolver = er.create_resolver()
