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

import sqlalchemy as sa
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
        description="树版本号，每次内容变更递增（收放等视图态不递增）；客户端重连时对比版本决定是否全量重拉",
    )
    created_at: datetime = Field(
        default_factory=_utcnow,
        description="创建时间（UTC）",
    )
    deleted_at: Optional[datetime] = Field(
        default=None,
        description="软删除时间（UTC），null = 活跃。已删图对所有查询不可见但行保留——"
        "rowid 不被复用，新建图永不拿到旧 id（防残留会话/归档被新图读到）；"
        "数据可恢复（暂无恢复入口，DB 层手工恢复）",
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


class MapRevision(BaseEntity, table=True):
    """一棵脑图在某次 mutation 提交后的整树快照（方案 A：快照表，不做重放）。

    每次 mutation 与树变更同事务写入一行，(map_id, version) 唯一——
    「每个 version 都有恰好一个快照」是版本时间线面板的依赖不变式。
    snapshot 为整树 JSON（display_id 语义，parent 用 display_id 引用，
    见 methods._build_snapshot）。不设 Relationship、不进 Map/Node 的
    关系图：只按 map_id 直查的附属记录表。
    存量图（migration 前已存在 / seed 直写）不回填历史——
    从下一个 mutation 起开始有快照。
    """

    # SQLModel 自动表名是类名小写（maprevision）非蛇形——与 migration 的
    # map_revision 对不上，显式指定（Map/Node 无驼峰不受影响）
    __tablename__ = "map_revision"

    id: Optional[int] = Field(default=None, primary_key=True, description="快照行主键")
    map_id: int = Field(foreign_key="map.id", description="所属脑图 ID")
    version: int = Field(description="该快照对应的树版本号（mutation 提交后的 version）")
    action: str = Field(
        description="产生该版本的动作：'map_created' / 'node_added' / … / 'revision_restored'"
    )
    actor: str = Field(default="agent", description="动作来源：'human'（浏览器）或 'agent'（CLI/MCP/REST）")
    detail: Optional[str] = Field(
        default=None, description="人类可读改动摘要（时间线展示用，与 publish_change 的 detail 同文）"
    )
    snapshot: dict = Field(
        sa_column=sa.Column(sa.JSON, nullable=False),
        description=(
            "整树快照 JSON：{title, nodes:[{display_id,parent,content,position,"
            "collapsed,updated_by,updated_at}]}（parent 为父节点 display_id，根为 null；"
            "updated_at 为 ISO 字符串）"
        ),
    )
    created_at: datetime = Field(default_factory=_utcnow, description="快照产生时间（UTC）")

    __table_args__ = (
        sa.UniqueConstraint("map_id", "version", name="uq_map_revision_map_version"),
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
        delete_map,
        delete_node,
        expand_all,
        get_revision,
        get_tree,
        list_maps,
        list_revisions,
        move_node,
        restore_revision,
        set_node_collapsed,
        set_fold_level,
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
    _mount(Map, set_node_collapsed, mutation)
    _mount(Map, move_node, mutation)
    _mount(Map, delete_node, mutation)
    _mount(Map, delete_map, mutation)
    _mount(Map, expand_all, mutation)
    _mount(Map, set_fold_level, mutation)
    _mount(Map, apply_outline, mutation)
    _mount(Map, list_revisions, query)
    _mount(Map, get_revision, query)
    _mount(Map, restore_revision, mutation)


# ── ErManager + Resolver ──────────────────────────────────────────────
from nexusx import ErManager  # noqa: E402

er = ErManager(
    entities=[Map, Node, MapRevision],
    session_factory=async_session,
)
Resolver = er.create_resolver()
