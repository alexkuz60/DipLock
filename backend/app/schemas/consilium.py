"""Контракты основания Консилиума: доброволец, ручной контекст, история и досье."""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

Identifier = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[\w.-]+$")]
Text = Annotated[str, Field(min_length=1, max_length=20_000)]
Direction = Literal["music", "meditation", "creativity", "emotional", "other"]
ContextKind = Literal["volunteer_report", "observation", "conditions", "answer"]
SourceKind = Literal["job", "session", "analysis", "group"]


class ConsiliumContract(BaseModel):
    """Строгий контракт: пробелы убираются, неизвестные параметры запрещены."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, allow_inf_nan=False)


class ConsiliumPermissions(ConsiliumContract):
    """Разрешения контекста: использование ИИ и внешняя передача независимы."""

    use_with_advisers: bool = False
    external_transfer: bool = False

    @model_validator(mode="after")
    def require_adviser_permission(self) -> "ConsiliumPermissions":
        """Запрещает внешнюю передачу без разрешения использовать материал советником."""
        if self.external_transfer and not self.use_with_advisers:
            raise ValueError("Внешняя передача требует разрешения использования советниками")
        return self


class ConsiliumCaseFields(ConsiliumContract):
    """Текущий паспорт исследования, не профиль личности и не диагноз."""

    title: Annotated[str, Field(min_length=1, max_length=200)]
    question: Text
    direction: Direction = "other"
    subject_codes: list[Identifier] = Field(default_factory=list, max_length=100)
    recording_ids: list[Identifier] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def unique_links(self) -> "ConsiliumCaseFields":
        """Не допускает двойного членства участника или записи."""
        if len(set(self.subject_codes)) != len(self.subject_codes):
            raise ValueError("Коды добровольцев не должны повторяться")
        if len(set(self.recording_ids)) != len(self.recording_ids):
            raise ValueError("Записи не должны повторяться")
        return self


class ConsiliumCaseCreate(ConsiliumCaseFields):
    """Создание исследования с ключом повторного запроса."""

    request_id: Identifier


class ConsiliumCaseUpdate(ConsiliumCaseFields):
    """Полный новый паспорт: конфликт версии не затирает изменения коллеги."""

    request_id: Identifier
    expected_version: int = Field(ge=1)
    status: Literal["open", "archived"] = "open"


class ConsiliumCaseOut(ConsiliumCaseFields):
    """Сохранённый паспорт исследования."""

    id: str
    version: int
    status: Literal["open", "archived"]
    created_at: datetime
    updated_at: datetime


class ConsiliumCasesPage(ConsiliumContract):
    """Страница исследований: total до ограничения выдачи."""

    total: int
    items: list[ConsiliumCaseOut]


class ConsiliumContextFields(ConsiliumContract):
    """Источник контекста и отдельная временная адресация."""

    text: Text
    kind: ContextKind = "observation"
    author: Annotated[str, Field(min_length=1, max_length=200)] = "Исследователь"
    subject_code: Identifier | None = None
    recording_id: Identifier | None = None
    start_sec: float | None = Field(default=None, ge=0)
    end_sec: float | None = Field(default=None, ge=0)
    time_basis: Literal["unspecified", "eeg", "approximate"] = "unspecified"
    verified: bool = False
    permissions: ConsiliumPermissions = Field(default_factory=ConsiliumPermissions)

    @model_validator(mode="after")
    def validate_interval(self) -> "ConsiliumContextFields":
        """Проверяет интервал, не выдумывая ноль или синхронизацию с аудио."""
        if self.end_sec is not None and (
            self.start_sec is None or self.end_sec < self.start_sec
        ):
            raise ValueError("Конец интервала требует начала и не может быть раньше него")
        if self.start_sec is not None and (
            self.recording_id is None or self.time_basis == "unspecified"
        ):
            raise ValueError("Для времени укажите запись и точность привязки")
        return self


class ConsiliumContextCreate(ConsiliumContextFields):
    """Новая ручная контекстная запись."""

    request_id: Identifier
    expected_version: int = Field(ge=1, description="Версия исследования")


class ConsiliumContextUpdate(ConsiliumContextCreate):
    """Исправление создаёт новую ревизию, не стирая исходную."""

    expected_revision: int = Field(ge=1)


class ConsiliumContextOut(ConsiliumContextFields):
    """Точная ревизия ручного контекста."""

    id: str
    case_id: str
    revision: int
    created_at: datetime


class ConsiliumContextPage(ConsiliumContract):
    """Страница контекстных ревизий (не только последних)."""

    total: int
    items: list[ConsiliumContextOut]


class ConsiliumMessageCreate(ConsiliumContract):
    """Ручная реплика исследователя: нельзя подделать ответ советника."""

    request_id: Identifier
    expected_version: int = Field(ge=1)
    text: Text


class ConsiliumMessageUpdate(ConsiliumMessageCreate):
    """Новая ревизия ручной реплики."""

    expected_revision: int = Field(ge=1)


class ConsiliumMessageOut(ConsiliumContract):
    """Сохранённая реплика, пока без модельных ответов."""

    id: str
    case_id: str
    revision: int
    created_at: datetime
    author: Literal["researcher"] = "researcher"
    text: Text


class ConsiliumMessagesPage(ConsiliumContract):
    """Страница ручных реплик со всеми ревизиями."""

    total: int
    items: list[ConsiliumMessageOut]


class ConsiliumDeletionPreview(ConsiliumContract):
    """Что будет удалено; ЭЭГ-записи и соседи не затрагиваются."""

    case_id: str
    version: int
    context_revisions: int
    message_revisions: int
    evidence_items: int = 0
    snapshots: int = 0
    recording_ids: list[str]
    warnings: list[str]


class ConsiliumEvidence(ConsiliumContract):
    """Зафиксированный B15: паспорт и исходные числа без defaults прошлого."""

    id: str
    case_id: str = ""
    title: str = ""
    captured_at: datetime | None = None
    revision: int = Field(ge=1)
    source_kind: Literal["job", "session", "analysis", "group", "context", "interview"]
    source_id: str
    recording_ids: list[str]
    payload: dict[str, JsonValue]
    parameters: dict[str, JsonValue] | None = None
    signal_state: str | None = None
    versions: dict[str, str] = Field(default_factory=dict)
    units: dict[str, str] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    missing: list[str] = Field(default_factory=list)
    completeness: Literal["full", "aggregate", "top_n", "fragment", "unavailable"]
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class ConsiliumSnapshot(ConsiliumContract):
    """Неизменяемый снимок B15: источники и контекст зафиксированы по версиям."""

    id: str
    case_id: str
    case_version: int = Field(ge=1)
    created_at: datetime
    question: str
    title: str = ""
    subject_codes: list[str] = Field(default_factory=list)
    recording_ids: list[str] = Field(default_factory=list)
    evidence: list[ConsiliumEvidence]
    context: list[ConsiliumContextOut]
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    warnings: list[str] = Field(default_factory=list)


class ConsiliumSource(ConsiliumContract):
    """Конкретный аналитический источник, не произвольный JSON от клиента."""

    kind: SourceKind
    id: str
    title: str
    recording_ids: list[str]
    created_at: datetime | None = None
    available: bool
    warnings: list[str] = Field(default_factory=list)


class ConsiliumSourcesPage(ConsiliumContract):
    """Каталог до пагинации, со списком отсутствующих записей."""

    total: int
    items: list[ConsiliumSource]
    warnings: list[str] = Field(default_factory=list)


class ConsiliumEvidenceCreate(ConsiliumContract):
    """Сервер читает выбранный источник; клиент не поставляет числа."""

    request_id: Identifier
    expected_version: int = Field(ge=1)
    source_kind: SourceKind
    source_id: Identifier


class ConsiliumEvidencePage(ConsiliumContract):
    """Материалы дела с честным общим числом."""

    total: int
    items: list[ConsiliumEvidence]


class ConsiliumSnapshotCreate(ConsiliumContract):
    """Фиксирует выбранные материалы и последние ревизии ручного контекста."""

    request_id: Identifier
    expected_version: int = Field(ge=1)
    evidence_ids: list[Identifier] = Field(min_length=1, max_length=100)
    context_ids: list[Identifier] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def unique_items(self) -> "ConsiliumSnapshotCreate":
        """Повтор одного материала не увеличивает число доказательств."""
        for ids in (self.evidence_ids, self.context_ids):
            if len(set(ids)) != len(ids):
                raise ValueError("Выбранные материалы не должны повторяться")
        return self


class ConsiliumSnapshotsPage(ConsiliumContract):
    """Страница опубликованных снимков."""

    total: int
    items: list[ConsiliumSnapshot]


class ConsiliumEvidenceDeletion(ConsiliumContract):
    """Удаление копий материала и зависящих снимков, не исходного расчёта."""

    case_id: str
    evidence_id: str
    version: int
    snapshot_ids: list[str]
    warnings: list[str]


class ConsiliumRecording(ConsiliumContract):
    """Паспорт доступной строки EDF для явного связывания исследования."""

    id: str
    filename: str | None
    sfreq: float | None
    duration_sec: float | None