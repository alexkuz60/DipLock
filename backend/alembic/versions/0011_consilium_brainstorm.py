"""Мозговой штурм Консилиума (B14, срез 0012): запуски, резюме и идеи.

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-14 12:00:00.000000

"""
import sqlalchemy as sa

from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None


def upgrade() -> None:
    """Создаёт запуски штурма и идеи; определения заморожены после autogenerate."""
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("consilium_brainstorms"):
        op.create_table(
            "consilium_brainstorms",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("case_id", sa.String(), nullable=False),
            sa.Column("snapshot_id", sa.String(), nullable=False),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("model", sa.String(), nullable=True),
            sa.Column("instruction_version", sa.String(), nullable=False),
            sa.Column("summary", sa.String(), nullable=True),
            sa.Column("draft", sa.String(), nullable=True),
            sa.Column("warnings", sa.JSON(), nullable=False),
            sa.Column("error", sa.String(), nullable=True),
            sa.Column("job_id", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("finished_at", sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(["case_id"], ["consilium_cases.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_consilium_brainstorms_case_id", "consilium_brainstorms", ["case_id"])
    if not inspector.has_table("consilium_brainstorm_ideas"):
        op.create_table(
            "consilium_brainstorm_ideas",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("case_id", sa.String(), nullable=False),
            sa.Column("brainstorm_id", sa.String(), nullable=False),
            sa.Column("ordinal", sa.Integer(), nullable=False),
            sa.Column("kind", sa.String(), nullable=False),
            sa.Column("title", sa.String(), nullable=False),
            sa.Column("hypothesis", sa.String(), nullable=True),
            sa.Column("rationale", sa.String(), nullable=True),
            sa.Column("risks", sa.String(), nullable=True),
            sa.Column("check_method", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["case_id"], ["consilium_cases.id"]),
            sa.ForeignKeyConstraint(["brainstorm_id"], ["consilium_brainstorms.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(
            "ix_consilium_brainstorm_ideas_case_id", "consilium_brainstorm_ideas", ["case_id"],
        )
        op.create_index(
            "ix_consilium_brainstorm_ideas_brainstorm_id",
            "consilium_brainstorm_ideas", ["brainstorm_id"],
        )


def downgrade() -> None:
    """Удаляет чувствительные идеи штурма (только dev/CI)."""
    inspector = sa.inspect(op.get_bind())
    for name in ("consilium_brainstorm_ideas", "consilium_brainstorms"):
        if inspector.has_table(name):
            op.drop_table(name)