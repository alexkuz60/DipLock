"""Разметка Jev Консилиума (§5.3): advisory-метки решающего классификатора.

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-14 10:00:00.000000

"""
import sqlalchemy as sa

from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None


def upgrade() -> None:
    """Создаёт строки разметки; определения заморожены после autogenerate."""
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("consilium_jev_marks"):
        op.create_table(
            "consilium_jev_marks",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("case_id", sa.String(), nullable=False),
            sa.Column("kind", sa.String(), nullable=False),
            sa.Column("subject_type", sa.String(), nullable=False),
            sa.Column("subject_id", sa.String(), nullable=False),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("model", sa.String(), nullable=True),
            sa.Column("questions_version", sa.String(), nullable=False),
            sa.Column("probs", sa.JSON(), nullable=False),
            sa.Column("present", sa.JSON(), nullable=False),
            sa.Column("choice", sa.String(), nullable=True),
            sa.Column("choice_confidence", sa.Float(), nullable=True),
            sa.Column("answers", sa.JSON(), nullable=False),
            sa.Column("warnings", sa.JSON(), nullable=False),
            sa.Column("error", sa.String(), nullable=True),
            sa.Column("latency_ms", sa.Float(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["case_id"], ["consilium_cases.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_consilium_jev_marks_case_id", "consilium_jev_marks", ["case_id"])
        op.create_index("ix_consilium_jev_marks_subject_id", "consilium_jev_marks", ["subject_id"])


def downgrade() -> None:
    """Удаляет чувствительные метки разметки (только dev/CI)."""
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("consilium_jev_marks"):
        op.drop_table("consilium_jev_marks")