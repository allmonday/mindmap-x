"""mvcc: node_revision 表替代整树快照（纯 schema，无数据迁移）

Revision ID: f5b8d2a4c7e6
Revises: e4a9c1f6b8d2
Create Date: 2026-09-01

版本存储从"每版本整树快照 JSON"改为节点级 MVCC 行（等价性/存储/性能
见 scripts/mvcc_prototype.py 与 specs/007-mvcc-revisions）。

早期项目约定（2026-09-02 用户确认）：**不做数据迁移，旧快照列直接废弃**。
本迁移只做三件事：建 node_revision、map_revision 加 title、drop snapshot 列。
存量快照数据不搬运——历史从迁移时刻起由节点行重新记录。

注：开发库曾应用过本迁移的"含数据搬运"版本（存量 225 快照已灌成 994 行
并保留），后按上述约定简化为纯 DDL，开发库已手工对齐（drop snapshot 列）。
对全新环境，重放本链时 map_revision 本就无数据，行为与含搬运版一致。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'f5b8d2a4c7e6'
down_revision: Union[str, Sequence[str], None] = 'e4a9c1f6b8d2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "node_revision",
        sa.Column("map_id", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("display_id", sa.Integer(), nullable=False),
        sa.Column("deleted", sa.Boolean(), nullable=False),
        sa.Column("parent", sa.Integer(), nullable=True),
        sa.Column("content", sa.Text(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("position", sa.Integer(), nullable=True),
        sa.Column("collapsed", sa.Boolean(), nullable=True),
        sa.Column("updated_by", sa.String(), nullable=True),
        sa.Column("updated_at", sa.String(), nullable=True),
        sa.PrimaryKeyConstraint("map_id", "version", "display_id"),
        sqlite_with_rowid=False,
    )
    with op.batch_alter_table("map_revision") as batch_op:
        batch_op.add_column(sa.Column("title", sa.String(), nullable=True))
        batch_op.drop_column("snapshot")


def downgrade() -> None:
    """Downgrade schema（快照数据已废弃，本方向只还原结构）。"""
    op.drop_table("node_revision")
    with op.batch_alter_table("map_revision") as batch_op:
        batch_op.add_column(sa.Column("snapshot", sa.JSON(), nullable=True))
        batch_op.drop_column("title")
