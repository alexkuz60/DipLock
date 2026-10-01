"""Write-API UI-разделов: колонки происхождения в ``sessions``, ``method`` в ``dipoles`` (4.4, шаг ②).

Остаток F21: в БД писалась только legacy-ветка `/analyze`. Теперь задачи
разделов UI (``preprocess``/``dipoles``/``dipole_refine``/``spectrogram``)
оставляют строку ``sessions`` с ``recording_id`` (каскад «TTL строки = TTL
записи», §8.4.3), ``kind``, ``job_id`` и ``params_json`` — полный набор
параметров прогона. ``method`` в ``dipoles`` различает ``fast_grid`` и
``bem_fit``; у legacy-строк колонка остаётся NULL.

``kind`` получает ``server_default='legacy'`` — старые строки /analyze сразу
попадают в категорию. Определения заморожены (см. ревизию 0001).

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-01

"""
import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None


def _existing_columns(table: str) -> set[str]:
    """Имена колонок таблицы (повторный запуск миграции — no-op)."""
    return {column["name"] for column in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    """Добавляет колонки происхождения в ``sessions`` и ``method`` в ``dipoles``."""
    session_columns = _existing_columns("sessions")
    # batch_alter_table: на SQLite FK-колонка добавляется пересозданием таблицы
    # (ALTER TABLE … ADD COLUMN REFERENCES работает только с DEFAULT NULL, а
    # ветка «старый файл» не должна зависеть от PRAGMA foreign_keys).
    with op.batch_alter_table("sessions") as batch:
        if "recording_id" not in session_columns:
            batch.add_column(sa.Column(
                "recording_id", sa.String(),
                # Имя обязательно: batch-alter пересоздаёт таблицу и требует
                # именованные FK («Constraint must have a name»).
                sa.ForeignKey(
                    "recordings.recording_id",
                    name="fk_sessions_recording_id",
                    ondelete="CASCADE",
                ),
                nullable=True,
            ))
        if "kind" not in session_columns:
            batch.add_column(sa.Column(
                "kind", sa.String(), nullable=True, server_default="legacy",
            ))
        if "job_id" not in session_columns:
            batch.add_column(sa.Column("job_id", sa.String(), nullable=True))
        if "params_json" not in session_columns:
            batch.add_column(sa.Column("params_json", sa.JSON(), nullable=True))
    op.create_index(
        "ix_sessions_recording_id", "sessions", ["recording_id"], if_not_exists=True,
    )

    if "method" not in _existing_columns("dipoles"):
        op.add_column("dipoles", sa.Column("method", sa.String(), nullable=True))


def downgrade() -> None:
    """Убирает колонки шага ② (**данные строк теряются**; только dev/CI)."""
    inspector = sa.inspect(op.get_bind())
    existing = {column["name"] for column in inspector.get_columns("dipoles")}
    if "method" in existing:
        op.drop_column("dipoles", "method")

    op.drop_index("ix_sessions_recording_id", table_name="sessions", if_exists=True)
    session_columns = _existing_columns("sessions")
    with op.batch_alter_table("sessions") as batch:
        for name in ("params_json", "job_id", "kind", "recording_id"):
            if name in session_columns:
                batch.drop_column(name)
