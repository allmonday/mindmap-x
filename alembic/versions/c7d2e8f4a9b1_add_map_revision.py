"""add map_revision (version snapshots)

Revision ID: c7d2e8f4a9b1
Revises: b3f1a2c4d5e6
Create Date: 2026-08-29

新表：每次 mutation 的整树 JSON 快照（方案 A：快照表 + 时间线 + 回滚）。
不回填存量图的历史快照（无历史可回）——它们从下一个 mutation 起开始有快照；
UNIQUE(map_id, version) 同时充当 map_id 查询索引（SQLite 最左前缀），不另建 index。
"""
from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel  # noqa: F401  AutoString
from alembic import op

revision: str = 'c7d2e8f4a9b1'
down_revision: Union[str, Sequence[str], None] = 'b3f1a2c4d5e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('map_revision',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('map_id', sa.Integer(), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('action', sqlmodel.sql.sqltypes.AutoString(), nullable=False),
    sa.Column('actor', sqlmodel.sql.sqltypes.AutoString(), nullable=False),
    sa.Column('detail', sqlmodel.sql.sqltypes.AutoString(), nullable=True),
    sa.Column('snapshot', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['map_id'], ['map.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('map_id', 'version', name='uq_map_revision_map_version'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('map_revision')
