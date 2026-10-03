"""group_analysis: прогоны группового анализа (остаток 4.7, Фаза 5).

Две таблицы: ``group_analyses`` — снимок определения (фильтры + отпечаток;
числа не замораживаются — агрегат пересчитывается по живой БД при чтении),
``group_analysis_members`` — состав группы в порядке выбора. Каскад:
состав убывает вместе с записью (явный DELETE в ``recording_store`` —
§8.4.3), сам прогон — история и переживает записи (§8.4.2).

Создание идемпотентно (``has_table``), как в 0002/0004: тест догонки
старого файла имитирует БД без ``alembic_version`` и проходит по всем
ревизиям повторно.

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-03

"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None


def upgrade() -> None:
    """Создаёт таблицы прогона и состава (идемпотентно)."""
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("group_analyses"):
        op.create_table(
            "group_analyses",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("name", sa.String(), nullable=True),
            sa.Column("band_key", sa.String(), nullable=True),
            sa.Column("filters", sa.JSON(), nullable=True),
            sa.Column("params_sig", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("n_sessions_requested", sa.Integer(), nullable=True),
            sa.PrimaryKeyConstraint("id"),
        )
    if not inspector.has_table("group_analysis_members"):
        op.create_table(
            "group_analysis_members",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("group_analysis_id", sa.Integer(), nullable=True),
            sa.Column("recording_id", sa.String(), nullable=True),
            sa.Column("position", sa.Integer(), nullable=True),
            sa.ForeignKeyConstraint(
                ["group_analysis_id"], ["group_analyses.id"], ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            "ix_group_analysis_members_group_analysis_id",
            "group_analysis_members", ["group_analysis_id"],
        )
        op.create_index(
            "ix_group_analysis_members_recording_id",
            "group_analysis_members", ["recording_id"],
        )
        op.create_index(
            "ux_group_members_pair",
            "group_analysis_members", ["group_analysis_id", "recording_id"],
            unique=True,
        )


def downgrade() -> None:
    """Удаляет таблицы прогона и состава (только dev/CI)."""
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("group_analysis_members"):
        op.drop_index(
            "ux_group_members_pair", table_name="group_analysis_members",
        )
        op.drop_index(
            "ix_group_analysis_members_recording_id",
            table_name="group_analysis_members",
        )
        op.drop_index(
            "ix_group_analysis_members_group_analysis_id",
            table_name="group_analysis_members",
        )
        op.drop_table("group_analysis_members")
    if inspector.has_table("group_analyses"):
        op.drop_table("group_analyses")
