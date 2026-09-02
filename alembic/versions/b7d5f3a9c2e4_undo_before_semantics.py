"""undo log: node_revision 行语义翻转（after → before），历史清空重记

Revision ID: b7d5f3a9c2e4
Revises: f5b8d2a4c7e6
Create Date: 2026-09-02

行语义从「该版本时刻的状态（after）」翻转为「该节点本次变更前的状态
（before，最小充分集——after = 同节点下一行的 before / 最新态可推导）」，
读取改为逆向 undo 回溯（锚 = node 表当前态，详见 specs/007 与
scripts/undo_prototype.py 原型验证）。

旧 after 行在新语义下是毒数据（会被误当 before 撤销），按「不做数据迁移」
约定（见 f5b8d2a4c7e6 docstring）直接清空：历史从本迁移时刻起按新语义
重新记录。map_revision 元数据行一并清（时间线归零，避免半残状态）。
与代码必须同一提交部署。downgrade no-op（数据不可恢复，迁移前请备份）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'b7d5f3a9c2e4'
down_revision: Union[str, Sequence[str], None] = 'f5b8d2a4c7e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade: 清空 after 语义的历史行。"""
    op.get_bind().execute(sa.text("DELETE FROM node_revision"))
    op.get_bind().execute(sa.text("DELETE FROM map_revision"))


def downgrade() -> None:
    """Downgrade: no-op（清空的数据不可恢复，见 docstring）。"""
