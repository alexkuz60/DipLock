"""Контракт группового анализа (остаток 4.7, Фаза 5): агрегаты «BA × сессии».

Единица выборки — **запись**: участники приходят списком ``recording_ids``
(те же кандидаты, что у сравнения пары — уникальные ``recording_id`` строк
``GET /sessions``). Источник точек — **пакет диполей автоотчёта**
(``dipole_points`` последнего прогона ``analyses`` каждой записи): только он
несёт полный счёт имён и стабильную адресацию ``band_key`` (§8.4.4
``docs/data-blocks.md``). Записи без пакетного прогона не ошибка, а честное
предупреждение в ``warnings``.

Все агрегаты считаются **внутри одной полосы** ``band_key`` — принцип 3
``docs/rules/dipoles.md`` «GOF между полосами не сравним» распространяется и
на групповой срез: и GOF, и амплитуда момента берутся только в пределах
своей полосы.
"""
from datetime import datetime

from pydantic import BaseModel, Field


class GroupAggregateIn(BaseModel):
    """Вход ``POST /group/aggregate``: выборка записей + групповые фильтры §3.5."""

    recording_ids: list[str] = Field(
        description="Записи-участники (колонки тепловой карты); дедупликация сохраняет порядок выбора",
    )
    band_key: str = Field(description="Полоса пакета (freq_bands/functional_bands) — агрегаты считаются в ней")
    gof_min: float | None = Field(
        default=None, ge=0.0, le=1.0,
        description="Отбор точек: GOF ≥ X (внутри полосы); None — все точки",
    )
    epoch_length_ms: float | None = Field(
        default=None, gt=0.0,
        description="Отбор прогонов по длине эпохи, мс (с допуском 0.01); None — любая",
    )
    date_from: datetime | None = Field(
        default=None, description="Отбор прогонов: создан не раньше (UTC); None — без нижней границы",
    )
    date_to: datetime | None = Field(
        default=None, description="Отбор прогонов: создан не позже (UTC); None — без верхней границы",
    )
    names: list[str] | None = Field(
        default=None,
        description="Показывать только эти строки структур/полей Бродмана; None — все (знаменатель share не меняется)",
    )
    top_n: int = Field(
        default=12, ge=1, le=100,
        description="Максимум строк в каждом словаре (топ по числу точек, как TOP_ROI отчёта)",
    )


class GroupFiltersOut(BaseModel):
    """Эхо применённых фильтров — подпись «что именно считалось» под результатом."""

    band_key: str
    band_hz: list[float] = Field(description="Границы полосы, Гц [lo, hi] — из каталога /meta")
    gof_min: float | None = Field(default=None, description="Отбор точек по GOF; None — без отбора")
    epoch_length_ms: float | None = Field(default=None, description="Отбор прогонов по длине эпохи, мс")
    date_from: datetime | None = None
    date_to: datetime | None = None
    names: list[str] | None = Field(
        default=None, description="Фильтр строк результата (знаменатель share — все точки полосы)",
    )
    top_n: int


class GroupParticipantOut(BaseModel):
    """Колонка тепловой карты: одна запись и её последний подходящий прогон."""

    recording_id: str
    filename: str | None = Field(
        default=None, description="Имя файла из строки recordings; None — строка записи уже удалена",
    )
    analysis_id: int | None = Field(
        default=None,
        description="Взятый прогон диполей; None — подходящих прогонов нет (предупреждение в warnings)",
    )
    analysis_kind: str | None = Field(default=None, description="fast_grid | bem_fit | refine")
    analysis_created_at: datetime | None = Field(
        default=None, description="Когда прогон был выполнен (история не UPSERT, §8.4.2)",
    )
    n_points: int = Field(description="Точек записи в полосе после фильтров (0 — предупреждение в warnings)")


class GroupCellOut(BaseModel):
    """Ячейка «строка × запись»: сколько точек записи попало в строку."""

    recording_id: str
    count: int = Field(description="Точек этой записи в строке")
    share: float = Field(
        description="Доля точек **своей записи** (в полосе), попавших в строку, 0..1 — между записями сравнима",
    )


class GroupRowOut(BaseModel):
    """Строка агрегата (структура или поле Бродмана): итог группы + ячейки записей."""

    name: str
    hemisphere: str = Field(description="Производная от имени: lh | rh | mid (как в ROI-анализе)")
    count: int = Field(description="Точек группы в этой строке (после фильтров)")
    share: float = Field(description="Доля строки от всех точек выборки в полосе, 0..1")
    mean_gof: float | None = Field(default=None, description="Средний GOF группы — только внутри полосы")
    median_gof: float | None = Field(default=None, description="Медиана GOF группы — только внутри полосы")
    std_gof: float | None = Field(
        default=None,
        description="СТОД GOF (популяционное); None — меньше двух значений",
    )
    mean_amplitude_nam: float | None = Field(
        default=None, description="Средний момент диполя, нАм — только внутри полосы",
    )
    std_amplitude_nam: float | None = Field(
        default=None, description="СТОД момента, нАм (популяционное); None — меньше двух значений",
    )
    n_sessions: int = Field(description="В скольких записях группы встречается строка (устойчивость закономерности)")
    cells: list[GroupCellOut] = Field(
        default_factory=list, description="Ячейки по записям — порядок участников (колонки карты)",
    )



class GroupAggregateOut(BaseModel):
    """Результат ``POST /group/aggregate``: агрегаты «BA × сессии» по выборке.

    Два словаря строк (структуры и поля Бродмана) — та же форма, что
    ``RoiAggregateOut``: число точек между строками сравнимо, GOF — только
    внутри полосы (подпись обязательна, `notes` показывает UI без правок).
    """

    filters: GroupFiltersOut
    participants: list[GroupParticipantOut] = Field(
        description="Записи-участники: порядок входного списка (колонки тепловой карты)",
    )
    n_points_total: int = Field(description="Точек выборки в полосе после всех фильтров")
    structures: list[GroupRowOut] = Field(default_factory=list)
    brodmann: list[GroupRowOut] = Field(default_factory=list)
    n_structure_names: int = Field(
        description="Всего названий структур в выборке (показан топ; разница видна из этого числа)",
    )
    n_brodmann_names: int = Field(description="Всего названий полей Бродмана в выборке")
    notes: list[str] = Field(
        default_factory=list,
        description="Правила чтения чисел — показываются в UI под результатом без редактирования",
    )
    warnings: list[str] = Field(
        default_factory=list,
        description="Честные предупреждения: записи без прогонов, пустые полосы, расхождения счётчиков",
    )
    duration_sec_calc: float = 0.0



class GroupAnalysisCreateIn(GroupAggregateIn):
    """Вход ``POST /group/analyses``: тот же снимок + подпись прогона."""

    name: str | None = Field(
        default=None, max_length=128,
        description="Подпись истории («покой vs деятельность, диппы»); пустая — без имени",
    )


class GroupAnalysisSummaryOut(BaseModel):
    """Строка истории ``GET /group/analyses``: определение без пересчёта."""

    id: int
    name: str | None = Field(default=None, description="Подпись пользователя; None — без имени")
    band_key: str | None = None
    created_at: datetime | None = Field(default=None, description="Когда прогон сохранён (UTC)")
    n_sessions_requested: int = Field(
        description="Размер группы при сохранении; сейчас живых участников может быть меньше",
    )
    n_members_alive: int = Field(
        description="Сколько участников ещё в БД (записи удаляются каскадно, §8.4.3)",
    )
    params_sig: str | None = Field(default=None, description="Отпечаток фильтров — ключ истории")


class GroupAnalysisDetailOut(BaseModel):
    """``GET /group/analyses/{id}``: паспорт прогона + свежий пересчёт агрегата.

    Числа **не заморожены**: читаются по живой БД тем же сервисом, что и
    ``POST /group/aggregate`` — история хранит определение, а не устаревающие
    цифры (решение-точка 1 плана G1).
    """

    run: GroupAnalysisSummaryOut
    aggregate: GroupAggregateOut


class GroupAnalysesPage(BaseModel):
    """Страница истории прогонов (``GET /group/analyses``)."""

    total: int = Field(description="Всего прогонов до пагинации")
    items: list[GroupAnalysisSummaryOut] = Field(
        default_factory=list, description="Строки истории — новые сверху",
    )

