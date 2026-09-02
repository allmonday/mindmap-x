"""add node.note (markdown long-form note)

Revision ID: e4a9c1f6b8d2
Revises: d8e3f5a7b2c4
Create Date: 2026-09-01

节点备注：content 保持画布短标题，note 承载 markdown 长文
（Agent 生成内容的主要落点，右侧备注面板渲染）。
存量行全为 NULL，无需回填。batch_alter_table 沿用 node 表
加列先例（b3f1a2c4d5e6）：SQLite 约束变更需 batch，纯可空
add_column 虽可直写，batch 写法更稳且一致。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'e4a9c1f6b8d2'
down_revision: Union[str, Sequence[str], None] = 'd8e3f5a7b2c4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table('node') as batch_op:
        batch_op.add_column(sa.Column('note', sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('node') as batch_op:
        batch_op.drop_column('note')
