"""Доля вращения момента в агрегате полосы (срез 2): CW/CCW по тройкам.

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-29 12:00:00.000000

Определение метрики — `services/moment_rotation.py` (знак тройного
произведения моментов, взгляд снаружи сферы). Колонки nullable: отчёт,
собранный до среза 2, честно остаётся без чисел.
"""
import sqlalchemy as sa

from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None

_COLUMNS = (
    ("rotation_cw_share", sa.Float()),
    ("rotation_ccw_share", sa.Float()),
    ("rotation_triples", sa.Integer()),
)


def _existing_columns() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    return {c["name"] for c in inspector.get_columns("report_band_summaries")}


def upgrade() -> None:
    """Добавляет колонки доли вращения (идемпотентно)."""
    existing = _existing_columns()
    for name, column_type in _COLUMNS:
        if name not in existing:
            op.add_column(
                "report_band_summaries",
                sa.Column(name, column_type, nullable=True),
            )


def downgrade() -> None:
    """Убирает колонки доли вращения (только dev/CI)."""
    existing = _existing_columns()
    with op.batch_alter_table("report_band_summaries") as batch:
        for name, _column_type in _COLUMNS:
            if name in existing:
                batch.drop_column(name)