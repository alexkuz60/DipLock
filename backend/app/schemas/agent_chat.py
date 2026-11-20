"""Контракт общего чата консилиума с ролевыми ИИ-агентами."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

AgentAuthor = Literal["researcher", "agent"]
AgentMessageStatus = Literal["ok", "running", "failed", "interrupted"]


class AgentRoleOut(BaseModel):
    """Роль агента: инструкция и выбранная модель."""

    id: str
    label: str
    instruction: str
    provider_id: str | None
    model: str | None
    enabled: bool
    builtin: bool
    sort: int


class AgentRolesPage(BaseModel):
    """Все роли чата (включая выключенные — для настройки)."""

    items: list[AgentRoleOut]


class AgentRoleCreate(BaseModel):
    """Новая пользовательская роль."""

    model_config = ConfigDict(extra="forbid")

    label: str = Field(min_length=1, max_length=60)
    instruction: str = Field(min_length=1, max_length=8000)
    provider_id: str | None = Field(default=None, max_length=100)
    model: str | None = Field(default=None, max_length=200)

    @field_validator("label", "instruction")
    @classmethod
    def required_text_must_not_be_blank(cls, value: str) -> str:
        """Обрезает пробелы и запрещает пустые поля роли."""
        value = value.strip()
        if not value:
            raise ValueError("Поле не должно быть пустым")
        return value


class AgentRoleUpdate(BaseModel):
    """Правка роли: не заданные поля не меняются; пустая строка модели — маршрут chat."""

    model_config = ConfigDict(extra="forbid")

    label: str | None = Field(default=None, min_length=1, max_length=60)
    instruction: str | None = Field(default=None, min_length=1, max_length=8000)
    provider_id: str | None = Field(default=None, max_length=100)
    model: str | None = Field(default=None, max_length=200)
    enabled: bool | None = None

    @field_validator("label", "instruction")
    @classmethod
    def optional_text_must_not_be_blank(cls, value: str | None) -> str | None:
        """Не допускает правку на пустое название или инструкцию."""
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("Поле не должно быть пустым")
        return value


class AgentThreadCreate(BaseModel):
    """Новая нить чата."""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(default="Новое обсуждение", min_length=1, max_length=120)

    @field_validator("title")
    @classmethod
    def title_must_not_be_blank(cls, value: str) -> str:
        """Обрезает пробелы в заголовке и запрещает пустое название нити."""
        value = value.strip()
        if not value:
            raise ValueError("Название нити не должно быть пустым")
        return value


class AgentThreadOut(BaseModel):
    """Нить с числом реплик."""

    id: str
    title: str
    messages: int
    created_at: datetime


class AgentThreadsPage(BaseModel):
    """Нити чата, новые сверху."""

    items: list[AgentThreadOut]


class AgentMessageOut(BaseModel):
    """Реплика исследователя или агента."""

    id: str
    thread_id: str
    author: AgentAuthor
    role_id: str | None
    addressees: list[str]
    status: AgentMessageStatus
    text: str | None
    model: str | None
    error: str | None
    warnings: list[str]
    latency_ms: float | None
    created_at: datetime
    finished_at: datetime | None


class AgentMessagesPage(BaseModel):
    """Переписка нити в порядке времени."""

    items: list[AgentMessageOut]


class AgentMessageCreate(BaseModel):
    """Сообщение исследователя: адресаты — из ``@упоминаний`` и/или явного списка."""

    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=20000)
    role_ids: list[str] = Field(default_factory=list, max_length=12)

    @field_validator("text")
    @classmethod
    def text_must_not_be_blank(cls, value: str) -> str:
        """Не допускает пустую после trim реплику исследователя."""
        value = value.strip()
        if not value:
            raise ValueError("Сообщение не должно быть пустым")
        return value


class AgentSendOut(BaseModel):
    """Реплика исследователя и ожидающие ответы адресатов (задачи запущены)."""

    message: AgentMessageOut
    replies: list[AgentMessageOut]
