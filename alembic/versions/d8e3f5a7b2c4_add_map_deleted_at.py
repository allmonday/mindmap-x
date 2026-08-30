"""add map.deleted_at (soft delete)

Revision ID: d8e3f5a7b2c4
Revises: c7d2e8f4a9b1
Create Date: 2026-08-30

软删除：delete_map 改为打 deleted_at 标记（行保留，所有查询过滤）。
动机：SQLite rowid 复用 max(id)——硬删后新建图会拿到旧 id，残留的
聊天会话/归档被新图读到。软删行占住 rowid，id 永不复用。
存量行全为活跃，无需回填。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'd8e3f5a7b2c4'
down_revision: Union[str, Sequence[str], None] = 'c7d2e8f4a9b1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('map', sa.Column('deleted_at', sa.DateTime(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('map', 'deleted_at')
