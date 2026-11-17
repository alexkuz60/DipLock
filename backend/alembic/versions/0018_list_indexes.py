"""Составные индексы под filter+order списков (аудит производительности 17.11.2026).

Списки готовности/сессий/прогонов фильтруют по записи (или делу/нити) и
сортируют «новые сверху» (``created_at, id``): одиночные индексы покрывали
только фильтр — сортировка шла по всей таблице. Идемпотентно
(``if_not_exists``/``if_exists``), как ревизии 0002–0005.

Revision ID: 0018
Revises: 0017
Create Date: 2026-11-17

"""
from alembic import op

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | list[str] | None = None
depends_on: str | list[str] | None = None

# (имя, таблица, колонки): фильтр + сортировка соответствующего списка.
_INDEXES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("ix_sessions_recording_created", "sessions", ("recording_id", "created_at", "id")),
    ("ix_analyses_recording_created", "analyses", ("recording_id", "created_at", "id")),
    ("ix_recordings_created", "recordings", ("created_at", "recording_id")),
    ("ix_consilium_rounds_case_created", "consilium_rounds", ("case_id", "created_at", "id")),
    (
        "ix_consilium_chat_messages_chat_created",
        "consilium_chat_messages",
        ("chat_id", "created_at", "id"),
    ),
)


def upgrade() -> None:
    """Создаёт составные индексы (идемпотентно)."""
    for name, table, columns in _INDEXES:
        op.create_index(name, table, list(columns), if_not_exists=True)


def downgrade() -> None:
    """Убирает составные индексы (только dev/CI)."""
    for name, table, _columns in reversed(_INDEXES):
        op.drop_index(name, table_name=table, if_exists=True)