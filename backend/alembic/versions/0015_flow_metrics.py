"""Магистраль потока и упорядоченность в агрегате полосы (срез 3).

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-29 14:00:00.000000

Определения метрик — `services/flow_metrics.py` (R векторов смещения
траектории позиций + топ переходов «структура → структура»). Колонки
nullable: отчёт, собранный до среза 3, честно остаётся без чисел.
"""
import sqlalchemy as sa

from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None

_COLUMNS = (
    ("flow_orderliness", sa.Float()),
    ("flow_steps", sa.Integer()),
    ("flow_basis", sa.String()),
    ("flow_top_transitions", sa.JSON()),
)


def _existing_columns() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    return {c["name"] for c in inspector.get_columns("report_band_summaries")}


def upgrade() -> None:
    """Добавляет колонки потока (идемпотентно)."""
    existing = _existing_columns()
    for name, column_type in _COLUMNS:
        if name not in existing:
            op.add_column(
                "report_band_summaries",
                sa.Column(name, column_type, nullable=True),
            )


def downgrade() -> None:
    """Убирает колонки потока (только dev/CI)."""
    existing = _existing_columns()
    with op.batch_alter_table("report_band_summaries") as batch:
        for name, _column_type in _COLUMNS:
            if name in existing:
                batch.drop_column(name)