"""add node display_id (per-map numbering)

Revision ID: b3f1a2c4d5e6
Revises: a284330e3cb6
Create Date: 2026-08-27

节点 ID 从全局累计改为 map 内编号（display_id，每图从 1 起）：
  1. batch 加列（先 nullable，SQLite 加约束需重建表）
  2. 回填：每 map 按全局 id 升序重编 1..n（窗口函数）
  3. batch 加 UNIQUE(map_id, display_id) 并改 NOT NULL（再次重建表）
全局 id 与 parent_id FK 不动，无引用破坏。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'b3f1a2c4d5e6'
down_revision: Union[str, Sequence[str], None] = 'a284330e3cb6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # 1. 加列（nullable，batch 重建表）
    with op.batch_alter_table('node') as batch_op:
        batch_op.add_column(sa.Column('display_id', sa.Integer(), nullable=True))

    # 2. 回填：每 map 按 id 升序重编 1..n（display_id 是新概念，无历史包袱，直接重编）
    op.execute(
        """
        UPDATE node SET display_id = t.rn
        FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY map_id ORDER BY id) AS rn FROM node) AS t
        WHERE node.id = t.id
        """
    )

    # 3. 唯一约束 + NOT NULL（batch 再次重建表）
    with op.batch_alter_table('node') as batch_op:
        batch_op.alter_column('display_id', existing_type=sa.Integer(), nullable=False)
        batch_op.create_unique_constraint('uq_node_map_display_id', ['map_id', 'display_id'])


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('node') as batch_op:
        batch_op.drop_constraint('uq_node_map_display_id', type_='unique')
        batch_op.drop_column('display_id')
