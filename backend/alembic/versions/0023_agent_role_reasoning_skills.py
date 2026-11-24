"""Роли чата консилиума: уровень размышления и навыки специалиста.

Revision ID: 0023
Revises: 0022
Create Date: 2026-11-24

Панель «Опции» раздела «Консилиум» вернулась после удаления «Исследования»
(24.11.2026): у роли появились ``reasoning`` (low/medium/high, директива в
инструкции) и ``skills`` (навыки специалиста через запятую). Оба поля
необязательные — существующие роли остаются как были.
"""
import sqlalchemy as sa

from alembic import op

revision: str = "0023"
down_revision: str | None = "0022"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None


def upgrade() -> None:
    """Добавляет колонки роли идемпотентно (повторный запуск — no-op)."""
    existing = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("agent_roles")}
    if "reasoning" not in existing:
        op.add_column("agent_roles", sa.Column("reasoning", sa.String(), nullable=True))
    if "skills" not in existing:
        op.add_column("agent_roles", sa.Column("skills", sa.String(), nullable=True))


def downgrade() -> None:
    """Убирает колонки роли."""
    existing = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("agent_roles")}
    if "skills" in existing:
        op.drop_column("agent_roles", "skills")
    if "reasoning" in existing:
        op.drop_column("agent_roles", "reasoning")
