"""Раунды советников Консилиума (B14, Т3).

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-12 10:00:00.000000

"""
import sqlalchemy as sa

from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None


def upgrade() -> None:
    """Создаёт раунды и ответы советников; определения заморожены после autogenerate."""
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("consilium_rounds"):
        op.create_table(
            "consilium_rounds",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("case_id", sa.String(), nullable=False),
            sa.Column("kind", sa.String(), nullable=False),
            sa.Column("snapshot_id", sa.String(), nullable=False),
            sa.Column("source_round_id", sa.String(), nullable=True),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("model", sa.String(), nullable=True),
            sa.Column("instruction_versions", sa.JSON(), nullable=False),
            sa.Column("limits", sa.JSON(), nullable=False),
            sa.Column("warnings", sa.JSON(), nullable=False),
            sa.Column("error", sa.String(), nullable=True),
            sa.Column("job_id", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("finished_at", sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(["case_id"], ["consilium_cases.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_consilium_rounds_case_id", "consilium_rounds", ["case_id"])
    if not inspector.has_table("consilium_answers"):
        op.create_table(
            "consilium_answers",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("case_id", sa.String(), nullable=False),
            sa.Column("round_id", sa.String(), nullable=False),
            sa.Column("role", sa.String(), nullable=False),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("text", sa.String(), nullable=True),
            sa.Column("error", sa.String(), nullable=True),
            sa.Column("model", sa.String(), nullable=True),
            sa.Column("instruction_version", sa.String(), nullable=False),
            sa.Column("latency_ms", sa.Float(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["case_id"], ["consilium_cases.id"]),
            sa.ForeignKeyConstraint(["round_id"], ["consilium_rounds.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_consilium_answers_case_id", "consilium_answers", ["case_id"])
        op.create_index("ix_consilium_answers_round_id", "consilium_answers", ["round_id"])


def downgrade() -> None:
    """Удаляет чувствительные ответы советников (только dev/CI)."""
    inspector = sa.inspect(op.get_bind())
    for name in ("consilium_answers", "consilium_rounds"):
        if inspector.has_table(name):
            op.drop_table(name)