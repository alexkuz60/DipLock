"""Контракт слоя правил-гипотез (срез 4): «N из M» по выборке проб.

Гипотеза — проверяемое суждение («научный критерий = данные + правило»,
`concept.md` §2): условие — строка «признак оператор значение» над признаками
пробы (``probe_context.PROBE_FEATURES``); проверка — всегда **одной полосой**
(принцип 3 «GOF между полосами не сравним» распространяется и на гипотезы).
Статусы ответа: ``confirmed``/``rejected`` (по ``min_share``), ``descriptive``
(без порога), ``insufficient`` (оценить не удалось).
"""
from datetime import datetime

from pydantic import BaseModel, Field


class HypothesisConditionIn(BaseModel):
    """Условие правила: признак пробы, оператор и порог."""

    feature: str = Field(description="Имя признака пробы (PROBE_FEATURES)")
    op: str = Field(description="Оператор: >= | <= | > | < | == | !=")
    value: float = Field(description="Порог условия")


class HypothesisCheckIn(BaseModel):
    """Вход ``POST /hypotheses/check``: правило + выборка проб."""

    label: str | None = Field(
        default=None, description="Имя/текст гипотезы — эхо в ответе (не влияет на проверку)",
    )
    band_key: str = Field(
        description="Полоса правила (freq_bands/functional_bands); между полосами не сравниваем",
    )
    conditions: list[HypothesisConditionIn] = Field(
        min_length=1, description="Условия правила (И-логика); минимум одно",
    )
    min_share: float | None = Field(
        default=None, ge=0.0, le=1.0,
        description="Порог подтверждения: N/M ≥ min_share → confirmed; None — только описание",
    )
    recording_ids: list[str] = Field(
        description="Записи-участники выборки (дедупликация сохраняет порядок)",
    )


class HypothesisConditionOut(BaseModel):
    """Эхо условия правила в ответе."""

    feature: str
    op: str
    value: float


class HypothesisRecordOut(BaseModel):
    """Итог проверки одной пробы: вердикт, провалы и её признаки."""

    recording_id: str
    filename: str | None = None
    passed: bool | None = Field(
        description=(
            "True — правило выполнилось; False — контрпример; "
            "None — не оценено (есть неизмеренные признаки)"
        ),
    )
    failed_conditions: list[str] = Field(
        default_factory=list, description="Подписи невыполненных условий",
    )
    unmeasured_features: list[str] = Field(
        default_factory=list, description="Подписи условий с неизмеренным признаком",
    )
    features: dict[str, float | int | None] = Field(
        default_factory=dict, description="Признаки пробы этой полосы (None — не измерено)",
    )


class HypothesisCheckOut(BaseModel):
    """Ответ проверки гипотезы: N из M, статус и построчные итоги."""

    label: str | None = None
    band_key: str
    band_hz: list[float] = Field(description="Границы полосы, Гц [lo, hi]")
    conditions: list[HypothesisConditionOut]
    min_share: float | None = None
    n: int = Field(description="Записей, где правило выполнилось")
    m: int = Field(description="Оценено записей (вошли в знаменатель доли)")
    share: float | None = Field(description="N / M; None — M = 0")
    status: str = Field(
        description="confirmed | rejected | descriptive | insufficient",
    )
    records: list[HypothesisRecordOut]
    warnings: list[str] = Field(default_factory=list)


class ProbeContextIn(BaseModel):
    """Вход ``POST /hypotheses/probe-context``: выборка + полоса."""

    recording_ids: list[str] = Field(
        description="Записи-участники выборки (дедупликация сохраняет порядок)",
    )
    band_key: str = Field(description="Полоса контекста (одна — принцип 3)")


class ProbeRecordOut(BaseModel):
    """Контекст одной пробы: признаки полосы из последнего прогона автоотчёта."""

    recording_id: str
    filename: str | None = None
    report_run_id: int | None = Field(
        default=None, description="Взятый прогон автоотчёта; None — прогонов нет",
    )
    report_created_at: datetime | None = Field(
        default=None, description="Когда прогон был выполнен (история, не UPSERT)",
    )
    features: dict[str, float | int | None] = Field(
        default_factory=dict, description="Признаки пробы (None — не измерено)",
    )
    measured: bool = Field(
        description="Есть ли полоса в прогоне; False — признаки не измерены",
    )


class ProbeContextOut(BaseModel):
    """Ответ контекста проб: строки по записям + честные предупреждения."""

    band_key: str
    band_hz: list[float]
    records: list[ProbeRecordOut]
    warnings: list[str] = Field(default_factory=list)