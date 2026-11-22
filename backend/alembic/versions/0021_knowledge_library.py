"""Библиотека знаний Консилиума: папки, документы, фрагменты, теги, граф.

Revision ID: 0021
Revises: 0020
Create Date: 2026-11-22

"""
import sqlalchemy as sa

from alembic import op

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None

_TABLES = (
    "knowledge_folders",
    "knowledge_documents",
    "knowledge_chunks",
    "knowledge_tags",
    "knowledge_doc_tags",
    "knowledge_annotations",
    "knowledge_links",
    "agent_thread_attachments",
)


def upgrade() -> None:
    """Создаёт таблицы библиотеки знаний и вложений нити (идемпотентно)."""
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    if "knowledge_folders" not in existing:
        op.create_table(
            "knowledge_folders",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column(
                "parent_id", sa.String(), sa.ForeignKey("knowledge_folders.id"), nullable=True,
            ),
            sa.Column("created_at", sa.DateTime(), nullable=False),
        )
        op.create_index("ix_knowledge_folders_parent_id", "knowledge_folders", ["parent_id"])
    if "knowledge_documents" not in existing:
        op.create_table(
            "knowledge_documents",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column(
                "folder_id", sa.String(), sa.ForeignKey("knowledge_folders.id"), nullable=True,
            ),
            sa.Column("title", sa.String(), nullable=False),
            sa.Column("filename", sa.String(), nullable=False),
            sa.Column("kind", sa.String(), nullable=False),
            sa.Column("source_url", sa.String(), nullable=True),
            sa.Column("sha256", sa.String(), nullable=False),
            sa.Column("size_bytes", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("pages", sa.Integer(), nullable=True),
            sa.Column("text_chars", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("status", sa.String(), nullable=False, server_default="ok"),
            sa.Column("error", sa.String(), nullable=True),
            sa.Column("meta", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("indexed_at", sa.DateTime(), nullable=True),
        )
        op.create_index("ix_knowledge_documents_folder_id", "knowledge_documents", ["folder_id"])
        op.create_index("ix_knowledge_documents_sha256", "knowledge_documents", ["sha256"])
        op.create_index(
            "ix_knowledge_documents_folder_created", "knowledge_documents",
            ["folder_id", "created_at", "id"],
        )
    if "knowledge_chunks" not in existing:
        op.create_table(
            "knowledge_chunks",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column(
                "document_id", sa.String(), sa.ForeignKey("knowledge_documents.id"),
                nullable=False,
            ),
            sa.Column("ordinal", sa.Integer(), nullable=False),
            sa.Column("heading", sa.String(), nullable=True),
            sa.Column("page_from", sa.Integer(), nullable=True),
            sa.Column("page_to", sa.Integer(), nullable=True),
            sa.Column("text", sa.Text(), nullable=False),
            sa.Column("tokens", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("embedding", sa.JSON(), nullable=True),
        )
        op.create_index("ix_knowledge_chunks_document_id", "knowledge_chunks", ["document_id"])
        op.create_index(
            "ix_knowledge_chunks_document_ordinal", "knowledge_chunks",
            ["document_id", "ordinal"],
        )
    if "knowledge_tags" not in existing:
        op.create_table(
            "knowledge_tags",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("name", sa.String(), nullable=False, unique=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
        )
    if "knowledge_doc_tags" not in existing:
        op.create_table(
            "knowledge_doc_tags",
            sa.Column(
                "document_id", sa.String(), sa.ForeignKey("knowledge_documents.id"),
                primary_key=True,
            ),
            sa.Column(
                "tag_id", sa.String(), sa.ForeignKey("knowledge_tags.id"), primary_key=True,
            ),
        )
        op.create_index("ix_knowledge_doc_tags_tag_id", "knowledge_doc_tags", ["tag_id"])
    if "knowledge_annotations" not in existing:
        op.create_table(
            "knowledge_annotations",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column(
                "document_id", sa.String(), sa.ForeignKey("knowledge_documents.id"),
                nullable=False,
            ),
            sa.Column(
                "chunk_id", sa.String(), sa.ForeignKey("knowledge_chunks.id"), nullable=True,
            ),
            sa.Column("heading", sa.String(), nullable=True),
            sa.Column("note", sa.Text(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
        )
        op.create_index(
            "ix_knowledge_annotations_document_id", "knowledge_annotations", ["document_id"],
        )
        op.create_index(
            "ix_knowledge_annotations_document_created", "knowledge_annotations",
            ["document_id", "created_at", "id"],
        )
    if "knowledge_links" not in existing:
        op.create_table(
            "knowledge_links",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("from_kind", sa.String(), nullable=False),
            sa.Column("from_id", sa.String(), nullable=False),
            sa.Column("to_kind", sa.String(), nullable=False),
            sa.Column("to_id", sa.String(), nullable=False),
            sa.Column("relation", sa.String(), nullable=False),
            sa.Column("confirmed", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("created_at", sa.DateTime(), nullable=False),
        )
        op.create_index("ix_knowledge_links_from", "knowledge_links", ["from_kind", "from_id"])
        op.create_index("ix_knowledge_links_to", "knowledge_links", ["to_kind", "to_id"])
    if "agent_thread_attachments" not in existing:
        op.create_table(
            "agent_thread_attachments",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column(
                "thread_id", sa.String(), sa.ForeignKey("agent_threads.id"), nullable=False,
            ),
            sa.Column("kind", sa.String(), nullable=False),
            sa.Column("ref_id", sa.String(), nullable=False),
            sa.Column("label", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
        )
        op.create_index(
            "ix_agent_thread_attachments_thread_id", "agent_thread_attachments", ["thread_id"],
        )
        op.create_index(
            "ix_agent_thread_attachments_thread", "agent_thread_attachments",
            ["thread_id", "created_at", "id"],
        )


def downgrade() -> None:
    """Убирает таблицы библиотеки знаний (только dev/CI)."""
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    for table in reversed(_TABLES):
        if table in existing:
            op.drop_table(table)
