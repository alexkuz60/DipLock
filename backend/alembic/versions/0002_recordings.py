"""Записи просмотра в БД: таблица ``recordings`` (4.4, шаг ①; кирпич B1).

Строка отражает запись из реестра (сайдкар ``recording.json``): паспорт в
минимальном виде для связей и истории, ``patient_alias`` — анонимизированный
псевдоним вместо PHI заголовка EDF, ``accessed_at`` — метрика TTL («записи —
не 24 ч», §8.4.3 ``docs/data-blocks.md``). Дочерние строки ``sessions``/
``analyses``/``report_*`` прикрепятся FK в ревизиях 0003/0004 и удаляются
каскадно вместе с записью.

Определения **заморожены**: модели ``app/models/db.py`` — источник истины для
нового кода, расхождение ловит страж
``tests/test_migrations.py::test_migration_schema_matches_models``.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-01

"""
import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None


def upgrade() -> None:
    """Создаёт ``recordings`` с уникальным индексом дедупа (идемпотентно)."""
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("recordings"):
        op.create_table(
            "recordings",
            sa.Column("recording_id", sa.String(), primary_key=True),
            sa.Column("filename", sa.String(), nullable=True),
            sa.Column("digest", sa.String(), nullable=True),
            sa.Column("patient_alias", sa.String(), nullable=True),
            sa.Column("n_channels", sa.Integer(), nullable=True),
            sa.Column("sfreq", sa.Float(), nullable=True),
            sa.Column("duration_sec", sa.Float(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("accessed_at", sa.DateTime(), nullable=True),
        )
    op.create_index(
        "ix_recordings_digest", "recordings", ["digest"], unique=True,
        if_not_exists=True,
    )


def downgrade() -> None:
    """Удаляет ``recordings`` (**все данные**; только dev/CI)."""
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("recordings"):
        op.drop_index("ix_recordings_digest", table_name="recordings")
        op.drop_table("recordings")
