"""node_revision: 列式镜像 → before JSON 单列

Revision ID: c8e6a2f4b1d9
Revises: b7d5f3a9c2e4
Create Date: 2026-09-02

七个镜像字段列（parent/content/note/position/collapsed/updated_by/updated_at）
替换为一个 before JSON 列。动机：Node 字段演进零 DDL——新字段只需进
methods._DIFF_FIELDS 语义清单，node_revision 表结构不再随 Node 动。

b7d5f3a9c2e4 刚清空过历史（表为空），本迁移是纯 schema 重建，无数据搬运。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'c8e6a2f4b1d9'
down_revision: Union[str, Sequence[str], None] = 'b7d5f3a9c2e4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema: 重建为 before JSON 形态（表为空，drop+create）。"""
    op.drop_table("node_revision")
    op.create_table(
        "node_revision",
        sa.Column("map_id", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("display_id", sa.Integer(), nullable=False),
        sa.Column("deleted", sa.Boolean(), nullable=False),
        sa.Column("before", sa.JSON(), nullable=True),
        sa.PrimaryKeyConstraint("map_id", "version", "display_id"),
        sqlite_with_rowid=False,
    )


def downgrade() -> None:
    """Downgrade schema: 重建为列式镜像形态。"""
    op.drop_table("node_revision")
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
