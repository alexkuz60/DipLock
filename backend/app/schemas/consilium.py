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


# --- Раунды советников (Т3): ответы моделей живут отдельно от ручной истории ---

AdvisorRole = Literal["psychological", "neurophysiological", "methodological", "summary"]
RoundKind = Literal["initial", "remarks", "summary"]
RoundStatus = Literal["running", "done", "partial", "failed", "cancelled", "interrupted"]
AnswerStatus = Literal["running", "ok", "failed"]


class ConsiliumAnswerOut(ConsiliumContract):
    """Сохранённый ответ советника; текст есть только при статусе ok."""

    id: str
    case_id: str
    round_id: str
    role: AdvisorRole
    status: AnswerStatus
    text: str | None = None
    error: str | None = None
    model: str | None = None
    instruction_version: str
    latency_ms: float | None = None
    created_at: datetime


class ConsiliumRoundOut(ConsiliumContract):
    """Раунд советников: состояние прерванной операции — в этой строке (§8)."""

    id: str
    case_id: str
    kind: RoundKind
    snapshot_id: str
    source_round_id: str | None = None
    status: RoundStatus
    model: str | None = None
    instruction_versions: dict[str, str]
    limits: dict[str, JsonValue]
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None
    job_id: str | None = None
    created_at: datetime
    finished_at: datetime | None = None
    answers: list[ConsiliumAnswerOut] = Field(default_factory=list)


class ConsiliumRoundsPage(ConsiliumContract):
    """Страница раундов исследования с честным total."""

    total: int
    items: list[ConsiliumRoundOut]


class ConsiliumRoundAction(ConsiliumContract):
    """Действие раунда (итог, повтор ответа) с ключом повтора и версией дела."""

    request_id: Identifier
    expected_version: int = Field(ge=1)


class ConsiliumRoundCreate(ConsiliumRoundAction):
    """Запуск раунда советников по опубликованному снимку досье.

    Пустой ``roles`` означает все три роли; итог ролёй не считается.
    """

    snapshot_id: Identifier
    kind: Literal["initial", "remarks"] = "initial"
    source_round_id: Identifier | None = None
    roles: list[AdvisorRole] = Field(default_factory=list, max_length=3)

    @model_validator(mode="after")
    def validate_round(self) -> "ConsiliumRoundCreate":
        """Замечания адресуются исходному раунду; роли уникальны и без итога."""
        if self.kind == "remarks" and self.source_round_id is None:
            raise ValueError("Раунд замечаний требует исходного раунда")
        if self.kind == "initial" and self.source_round_id is not None:
            raise ValueError("Исходный раунд указывается только для замечаний")
        if "summary" in self.roles:
            raise ValueError("Итог запускается отдельным действием")
        if len(set(self.roles)) != len(self.roles):
            raise ValueError("Роли советников не должны повторяться")
        return self


class ConsiliumAnswerRetry(ConsiliumRoundAction):
    """Повтор одного неудавшегося ответа; успешные ответы не переспрашиваются."""

    role: AdvisorRole


class ConsiliumDeletionPreview(ConsiliumContract):
    """Что будет удалено; ЭЭГ-записи и соседи не затрагиваются."""

    case_id: str
    version: int
    context_revisions: int
    message_revisions: int
    evidence_items: int = 0
    snapshots: int = 0
    rounds: int = 0
    answers: int = 0
    triage: int = 0
    jev_marks: int = 0
    brainstorms: int = 0
    brainstorm_ideas: int = 0
    proposals: int = 0
    decisions: int = 0
    executions: int = 0
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
    rounds: int = 0
    answers: int = 0
    triage: int = 0
    jev_marks: int = 0
    warnings: list[str]


class ConsiliumRecording(ConsiliumContract):
    """Паспорт доступной строки EDF для явного связывания исследования."""

    id: str
    filename: str | None
    sfreq: float | None
    duration_sec: float | None


# --- Триаж готовности досье (Jev): быстрые типизированные решения до раунда ---

TriageStatus = Literal["ok", "failed"]
TriageDeficit = Literal[
    "no_measurements",
    "no_volunteer_report",
    "no_observations",
    "incompatible_parameters",
    "no_deficit",
]


class ConsiliumTriageCreate(ConsiliumContract):
    """Запуск триажа досье решающим классификатором (только явной кнопкой)."""

    request_id: Identifier
    expected_version: int = Field(ge=1)
    snapshot_id: Identifier


class ConsiliumTriageOut(ConsiliumContract):
    """Результат триажа: уверенность калибрована, но не гарантирует правильность.

    ``sufficient_prob`` — калиброванная вероятность ответа «достаточно»;
    ``sufficient`` — вердикт по явному порогу настроек. Ошибка вызова даёт
    ``status='failed'`` без достроенных решений.
    """

    id: str
    case_id: str
    snapshot_id: str
    status: TriageStatus
    model: str | None = None
    questions_version: str
    sufficient: bool | None = None
    sufficient_prob: float | None = Field(default=None, ge=0, le=1)
    deficit: TriageDeficit | None = None
    deficit_confidence: float | None = Field(default=None, ge=0, le=1)
    completeness_score: float | None = Field(
        default=None,
        ge=0,
        description="Позиция на шкале полноты (0 — пусто … 3 — полно), может быть дробной",
    )
    answers: dict[str, JsonValue] = Field(
        default_factory=dict,
        description="Типизированные ответы классификатора (choice/score/noul) как есть",
    )
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None
    latency_ms: float | None = None
    created_at: datetime


class ConsiliumTriagePage(ConsiliumContract):
    """Страница попыток триажа: append-only история, честный total."""

    total: int
    items: list[ConsiliumTriageOut]


# --- Разметка Jev (§5.3): advisory-метки решающего классификатора по текстам ---

JevMarkKind = Literal["round_plan", "proposal", "source_marks"]
JevMarkSubject = Literal["snapshot", "answer"]


class ConsiliumJevMarkCreate(ConsiliumContract):
    """Запуск разметки решающим классификатором (только явной кнопкой)."""

    request_id: Identifier
    expected_version: int = Field(ge=1)


class ConsiliumJevMarkRoundPlanCreate(ConsiliumJevMarkCreate):
    """Подбор состава ролей и глубины раунда по снимку досье («быстрый раунд»)."""

    snapshot_id: Identifier


class ConsiliumJevMarkAnswerCreate(ConsiliumJevMarkCreate):
    """Разметка текста ответа советника (карточка предложения / источники)."""

    answer_id: Identifier


class ConsiliumJevMarkOut(ConsiliumContract):
    """Метка Jev: advisory-подсказки с явным порогом, не вердикты (§5.3).

    ``probs`` — калиброванные вероятности ответов ``noul`` по вопросам карты;
    ``present`` — метки, достигшие порога ``consilium_jev_verdict_min``;
    ``choice`` — ключ ``choice``-вопроса (глубина раунда / вид шага §7).
    Ошибка вызова даёт ``status='failed'`` без достроенных меток.
    """

    id: str
    case_id: str
    kind: JevMarkKind
    subject_type: JevMarkSubject
    subject_id: str
    status: TriageStatus
    model: str | None = None
    questions_version: str
    probs: dict[str, float] = Field(
        default_factory=dict,
        description="Калиброванные вероятности noul по вопросам карты (0…1)",
    )
    present: list[str] = Field(
        default_factory=list,
        description="Метки, достигшие порога; подсказка, не вердикт",
    )
    choice: str | None = Field(
        default=None,
        description="Ключ choice-вопроса (глубина раунда или вид шага)",
    )
    choice_confidence: float | None = Field(default=None, ge=0, le=1)
    answers: dict[str, JsonValue] = Field(
        default_factory=dict,
        description="Типизированные ответы классификатора (choice/noul) как есть",
    )
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None
    latency_ms: float | None = None
    created_at: datetime


class ConsiliumJevMarksPage(ConsiliumContract):
    """Страница попыток разметки: append-only история, честный total."""

    total: int
    items: list[ConsiliumJevMarkOut]


StreamEventType = Literal["role_started", "delta", "role_done", "round_done", "error", "ping"]
StreamRoleStatus = Literal["waiting", "streaming", "done", "failed"]


class ConsiliumStreamEvent(BaseModel):
    """Событие SSE-стрима раунда (срез 0011): один фрейм `event:` + JSON.

    Обычный ``BaseModel`` (без ``str_strip_whitespace``): ``delta`` — кусочек
    текста как есть, обрезка краёв исказила бы склейку потока. Поля заполняются
    по типу события: ``delta`` — только у ``delta``, ``status`` — у смены
    состояния роли (``role_started``/``role_done``); ``error`` перед ``round_done``
    завершает поток, поздних дельт после него нет.
    """

    type: StreamEventType
    role: str | None = None
    delta: str | None = None
    model: str | None = None
    status: StreamRoleStatus | None = None
    error: str | None = None


# --- Мозговой штурм (срез 0012): идеи и резюме по снимку досье ---

BrainstormKind = Literal["ask_volunteer", "clarify_observation", "run_probe", "run_calculation"]
BrainstormStatus = Literal["running", "done", "failed", "cancelled", "interrupted"]


class ConsiliumBrainstormCreate(ConsiliumContract):
    """Запуск мозгового штурма по снимку досье (только явной кнопкой)."""

    request_id: Identifier
    expected_version: int = Field(ge=1)
    snapshot_id: Identifier


class ConsiliumBrainstormIdeaOut(ConsiliumContract):
    """Идея штурма: карточка шага §7 с основанием, рисками и способом проверки."""

    id: str
    brainstorm_id: str
    ordinal: int
    kind: BrainstormKind
    title: str
    hypothesis: str | None = None
    rationale: str | None = None
    risks: str | None = None
    check_method: str | None = None


class ConsiliumBrainstormOut(ConsiliumContract):
    """Запуск штурма: резюме, идеи и сырой текст как честное основание разбора.

    ``draft`` — ответ модели как есть: при сбое разбора ничего не теряется;
    ``summary`` и ``ideas`` заполняются только разобранными частями, без
    достраивания за модель. Ошибка вызова даёт ``status='failed'`` без идей.
    """

    id: str
    case_id: str
    snapshot_id: str
    status: BrainstormStatus
    model: str | None = None
    instruction_version: str
    summary: str | None = None
    draft: str | None = None
    ideas: list[ConsiliumBrainstormIdeaOut] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None
    job_id: str | None = None
    created_at: datetime
    finished_at: datetime | None = None


class ConsiliumBrainstormsPage(ConsiliumContract):
    """Страница запусков штурма: append-only история, честный total."""

    total: int
    items: list[ConsiliumBrainstormOut]


# --- Библиотека исследования (Т5, срез 0013): предложения и решения ---

ProposalSource = Literal["brainstorm", "advisor", "manual"]
ProposalDecision = Literal["accepted", "rejected"]


class ConsiliumProposalFields(ConsiliumContract):
    """Карточка предложения: вид шага §7, основание и способ проверки."""

    kind: BrainstormKind
    title: Annotated[str, Field(min_length=1, max_length=300)]
    hypothesis: str | None = Field(default=None, max_length=2000)
    rationale: str | None = Field(default=None, max_length=2000)
    risks: str | None = Field(default=None, max_length=2000)
    check_method: str | None = Field(default=None, max_length=2000)


class ConsiliumProposalCreate(ConsiliumProposalFields):
    """Новое предложение: вручную или из идеи штурма/ответа советника."""

    request_id: Identifier
    expected_version: int = Field(ge=1)
    source: ProposalSource = "manual"
    source_id: Identifier | None = None


class ConsiliumProposalUpdate(ConsiliumProposalFields):
    """Правка карточки: содержимое меняется, история решений остаётся."""

    request_id: Identifier
    expected_version: int = Field(ge=1)


class ConsiliumDecisionOut(ConsiliumContract):
    """Решение человека: принято/отклонено с адресом версии карточки (§7)."""

    id: str
    proposal_id: str
    decision: ProposalDecision
    proposal_version: int
    comment: str | None = None
    created_at: datetime


class ConsiliumExecutionOut(ConsiliumContract):
    """Ручное исполнение предложения и его результат (Т5)."""

    id: str
    proposal_id: str
    note: str
    result: str | None = None
    created_at: datetime


class ConsiliumProposalOut(ConsiliumProposalFields):
    """Предложение библиотеки: версия карточки, решения и исполнения append-only."""

    id: str
    case_id: str
    source: ProposalSource
    source_id: str | None = None
    version: int
    decisions: list[ConsiliumDecisionOut] = Field(default_factory=list)
    executions: list[ConsiliumExecutionOut] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class ConsiliumProposalsPage(ConsiliumContract):
    """Страница библиотеки: append-only история, честный total."""

    total: int
    items: list[ConsiliumProposalOut]


class ConsiliumDecisionCreate(ConsiliumContract):
    """Решение человека (принято/отклонено) с комментарием; история не правится."""

    request_id: Identifier
    expected_version: int = Field(ge=1)
    decision: ProposalDecision
    comment: str | None = Field(default=None, max_length=2000)


class ConsiliumExecutionCreate(ConsiliumContract):
    """Ручное исполнение предложения и результат; каждое — новой строкой."""

    request_id: Identifier
    expected_version: int = Field(ge=1)
    note: Annotated[str, Field(min_length=1, max_length=2000)]
    result: str | None = Field(default=None, max_length=20_000)