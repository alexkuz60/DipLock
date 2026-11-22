"""Контракт API библиотеки знаний Консилиума (OpenAPI → TS-типы UI)."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

DocumentKind = Literal["pdf", "docx", "xlsx", "image", "web", "text"]
DocumentStatus = Literal["ok", "empty", "failed"]
LinkKind = Literal["document", "tag", "concept"]
AttachmentKind = Literal["document", "web", "report", "analysis"]


class KnowledgeFolderCreate(BaseModel):
    """Новая папка библиотеки: имя и (необязательно) родитель."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    parent_id: str | None = Field(default=None, max_length=64)

    @field_validator("name")
    @classmethod
    def name_must_not_be_blank(cls, value: str) -> str:
        """Обрезает пробелы и запрещает пустое имя папки."""
        value = value.strip()
        if not value:
            raise ValueError("Имя папки не должно быть пустым")
        return value


class KnowledgeFolderOut(BaseModel):
    """Папка библиотеки с числом документов внутри."""

    id: str
    name: str
    parent_id: str | None
    documents: int
    created_at: datetime


class KnowledgeFoldersOut(BaseModel):
    """Все папки библиотеки (дерево строится на клиенте по ``parent_id``)."""

    items: list[KnowledgeFolderOut]


class KnowledgeDocumentOut(BaseModel):
    """Документ библиотеки: метаданные, теги и число фрагментов."""

    id: str
    folder_id: str | None
    title: str
    filename: str
    kind: DocumentKind
    source_url: str | None
    size_bytes: int
    pages: int | None
    text_chars: int
    status: DocumentStatus
    error: str | None
    tags: list[str]
    chunks: int
    created_at: datetime
    indexed_at: datetime | None


class KnowledgeDocumentsPage(BaseModel):
    """Документы библиотеки, новые сверху."""

    items: list[KnowledgeDocumentOut]
    total: int


class KnowledgeChunkOut(BaseModel):
    """Фрагмент документа: заголовок, страницы и текст."""

    id: str
    ordinal: int
    heading: str | None
    page_from: int | None
    page_to: int | None
    text: str
    tokens: int


class KnowledgeAnnotationCreate(BaseModel):
    """Аннотация раздела: заметка к документу или фрагменту."""

    model_config = ConfigDict(extra="forbid")

    note: str = Field(min_length=1, max_length=4000)
    chunk_id: str | None = Field(default=None, max_length=64)
    heading: str | None = Field(default=None, max_length=200)

    @field_validator("note")
    @classmethod
    def note_must_not_be_blank(cls, value: str) -> str:
        """Обрезает пробелы и запрещает пустую заметку."""
        value = value.strip()
        if not value:
            raise ValueError("Аннотация не должна быть пустой")
        return value


class KnowledgeAnnotationOut(BaseModel):
    """Аннотация с привязкой к фрагменту и заголовку."""

    id: str
    document_id: str
    chunk_id: str | None
    heading: str | None
    note: str
    created_at: datetime


class KnowledgeDocumentDetail(BaseModel):
    """Документ с оглавлением, аннотациями и тегами."""

    document: KnowledgeDocumentOut
    chunks: list[KnowledgeChunkOut]
    annotations: list[KnowledgeAnnotationOut]


class KnowledgeTagCreate(BaseModel):
    """Новый тег Базы знаний."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=60)

    @field_validator("name")
    @classmethod
    def name_must_not_be_blank(cls, value: str) -> str:
        """Обрезает пробелы и запрещает пустой тег."""
        value = value.strip()
        if not value:
            raise ValueError("Тег не должен быть пустым")
        return value


class KnowledgeTagOut(BaseModel):
    """Тег и число документов с ним."""

    id: str
    name: str
    documents: int


class KnowledgeTagsOut(BaseModel):
    """Все теги библиотеки."""

    items: list[KnowledgeTagOut]


class KnowledgeDocTagsUpdate(BaseModel):
    """Полный набор тегов документа (замена, не добавление)."""

    model_config = ConfigDict(extra="forbid")

    tags: list[str] = Field(default_factory=list, max_length=40)


class KnowledgeLinkCreate(BaseModel):
    """Ребро графа знаний: связь двух узлов."""

    model_config = ConfigDict(extra="forbid")

    from_kind: LinkKind
    from_id: str = Field(min_length=1, max_length=64)
    to_kind: LinkKind
    to_id: str = Field(min_length=1, max_length=64)
    relation: Literal["cites", "related", "defines", "mentions"] = "related"
    confirmed: bool = True


class KnowledgeLinkOut(BaseModel):
    """Ребро графа с признаком подтверждения."""

    id: str
    from_kind: LinkKind
    from_id: str
    to_kind: LinkKind
    to_id: str
    relation: str
    confirmed: bool
    created_at: datetime


class KnowledgeGraphNode(BaseModel):
    """Узел графа: документ, тег или понятие с подписью."""

    kind: LinkKind
    id: str
    label: str
    documents: int = 0


class KnowledgeGraphOut(BaseModel):
    """Граф знаний: узлы и подтверждённые рёбра."""

    nodes: list[KnowledgeGraphNode]
    edges: list[KnowledgeLinkOut]


class KnowledgeSearchHitOut(BaseModel):
    """Найденный фрагмент с документом и оценкой."""

    chunk_id: str
    document_id: str
    document_title: str
    ordinal: int
    heading: str | None
    page_from: int | None
    text: str
    score: float


class KnowledgeSearchOut(BaseModel):
    """Результат поиска и честный режим: ``hybrid`` или ``tfidf``."""

    query: str
    mode: Literal["hybrid", "tfidf"]
    hits: list[KnowledgeSearchHitOut]


class KnowledgeWebAdd(BaseModel):
    """Добавление веб-страницы в библиотеку по ссылке."""

    model_config = ConfigDict(extra="forbid")

    url: str = Field(min_length=8, max_length=2000)
    folder_id: str | None = Field(default=None, max_length=64)
    title: str | None = Field(default=None, max_length=300)

    @field_validator("url")
    @classmethod
    def url_must_be_http(cls, value: str) -> str:
        """Разрешает только http(s): файловые схемы не тянутся."""
        value = value.strip()
        if not value.startswith(("http://", "https://")):
            raise ValueError("Ссылка должна начинаться с http:// или https://")
        return value


class AgentAttachmentCreate(BaseModel):
    """Вложение нити чата: документ, веб-ссылка, отчёт или анализ ЭЭГ."""

    model_config = ConfigDict(extra="forbid")

    kind: AttachmentKind
    ref_id: str = Field(min_length=1, max_length=120)
    label: str = Field(min_length=1, max_length=300)


class AgentAttachmentOut(BaseModel):
    """Прикреплённое к нити вложение."""

    id: str
    thread_id: str
    kind: AttachmentKind
    ref_id: str
    label: str
    created_at: datetime


class AgentAttachmentsOut(BaseModel):
    """Вложения нити, новые сверху."""

    items: list[AgentAttachmentOut]
