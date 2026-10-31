"""Библиотека правил-гипотез «N из M» = ``hypotheses`` (Т4, 31.10.2026).

Строка — правило (полоса + условия + порог) и выборка проб; проверка
пересчитывается (``POST /hypotheses/{id}/recheck``). История append, не
UPSERT (§8.4.2). Определения заморожены (см. ревизию 0001).

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-31

"""
from typing import Any

import sqlalchemy as sa

from alembic import op

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None


def _hypotheses_columns() -> list[Any]:
    """Замороженные колонки ``hypotheses`` (правило + выборка)."""
    return [
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("label", sa.String(), nullable=True),
        sa.Column("band_key", sa.String(), nullable=True),
        sa.Column("conditions", sa.JSON(), nullable=True),
        sa.Column("min_share", sa.Float(), nullable=True),
        sa.Column("recording_ids", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    ]


def upgrade() -> None:
    """Создаёт ``hypotheses`` (идемпотентно)."""
    if sa.inspect(op.get_bind()).has_table("hypotheses"):
        return
    op.create_table("hypotheses", *_hypotheses_columns())


def downgrade() -> None:
    """Убирает ``hypotheses`` (только dev/CI)."""
    if sa.inspect(op.get_bind()).has_table("hypotheses"):
        op.drop_table("hypotheses")
