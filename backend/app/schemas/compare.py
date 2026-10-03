"""Контракт дифференциального анализа двух записей (B9, задача «Сравнение»).

Пара записей одного испытуемого (например, покой с закрытыми глазами vs
умственная деятельность) обрабатывается **одними и теми же параметрами** спектра —
иначе дельты не определены. Отсюда структура ответа: паспорт пары + сводка
«что совпало / что разошлось» (обязательное поле B9) + дельты по полосам +
статистика различий (кластерный пермутационный тест MNE + FDR) + каветы
интерпретации. Числа PSD — те же единицы, что у ``SpectrumResult`` (мкВ²/Гц,
мкВ², дБ).
"""
from pydantic import BaseModel, Field

from app.schemas.analysis import SpectrumPeakOut


class CompareSideOut(BaseModel):
    """Паспорт одной стороны пары (одна запись + её условие)."""

    recording_id: str
    filename: str
    label: str = Field(description="Ярлык условия от пользователя («покой», «деятельность»)")
    n_epochs: int = Field(description="Сколько эпох записи попало в расчёт")
    n_channels: int = Field(description="Каналов в расчёте (общий набор пары)")


class CompareMatchOut(BaseModel):
    """«Совпадение параметров» пары (B9): что сравнивается и что разошлось."""

    sfreq: float = Field(description="Частота дискретизации, Гц — одинаковая у обеих записей (шлюз 400)")
    filter_band_hz: list[float] | None = Field(
        default=None, description="Полоса фильтра расчёта, Гц; None — без фильтра"
    )
    notch_hz: float | None = Field(default=None, description="Notch, Гц")
    epoch_length_ms: float = Field(description="Длина эпохи, мс")
    psd_method: str = Field(description="Метод PSD: welch | multitaper")
    reference: str = Field(description="Референс: average | custom")
    channels: list[str] = Field(description="Общий набор каналов — по нему считается всё")
    channels_only_a: list[str] = Field(
        default_factory=list, description="Каналы только в записи A — исключены из сравнения"
    )
    channels_only_b: list[str] = Field(
        default_factory=list, description="Каналы только в записи B — исключены из сравнения"
    )


class CompareBandOut(BaseModel):
    """Дельта одного диапазона ``freq_bands`` между записями B и A."""

    name: str = Field(description="Ключ диапазона (delta…gamma)")
    fmin: float
    fmax: float
    power_a_uv2: float | None = Field(description="Мощность в A, мкВ²; None — частоты вне полосы фильтра")
    power_b_uv2: float | None = Field(description="Мощность в B, мкВ²")
    delta_uv2: float | None = Field(description="B − A, мкВ²")
    delta_db: float | None = Field(description="10·log10(B/A), дБ — знак = направление изменения")
    relative_power_a: float | None = Field(description="Доля диапазона в спектре A, 0..1")
    relative_power_b: float | None = Field(description="Доля диапазона в спектре B, 0..1")
    median_a_uv2: float | None = Field(description="Медиана мощности по эпохам A, мкВ²")
    median_b_uv2: float | None = Field(description="Медиана мощности по эпохам B, мкВ²")
    ci95_delta_db: list[float] | None = Field(
        default=None,
        description="95% bootstrap-ИИ дельты дБ [низ, верх]; 0 внутри — различие не подтверждено",
    )
    effect: float | None = Field(
        default=None,
        description="Робастный эффект (медианная разность / pooled MAD); None — масштаб нулевой",
    )
    p_value: float | None = Field(description="Welch t-тест по эпоховым мощностям, p")
    q_value: float | None = Field(description="p после поправки FDR внутри полосы (по каналам)")
    fdr_significant_channels: list[str] = Field(
        default_factory=list,
        description="Каналы со значимой дельтой после FDR (q < alpha) — по ним карта разности",
    )
    topomap_delta_url: str | None = Field(
        default=None, description="URL карты разности B−A (PNG, ETag); None — мало каналов с позицией"
    )


class CompareClusterOut(BaseModel):
    """Значимый кластер «частота × канал» из пермутационного теста."""

    p_value: float = Field(description="Уровень значимости кластера (пермутации)")
    significant: bool = Field(description="p < alpha — кластер показывается как различие")
    channels: list[str] = Field(description="Каналы, попавшие в кластер")
    freq_min_hz: float = Field(description="Нижняя частота кластера, Гц")
    freq_max_hz: float = Field(description="Верхняя частота кластера, Гц")
    n_points: int = Field(description="Число точек «канал × частота» в кластере")
    mean_delta_db: float = Field(description="Средняя дельта дБ внутри кластера (знак = направление)")
    direction: str = Field(description="«A>B» или «B>A» — где мощность больше")


class CompareStatsOut(BaseModel):
    """Статистика различий: кластерный тест MNE по «канал × частота»."""

    method: str = Field(description="Идентификатор метода: permutation_cluster_test")
    n_permutations: int = Field(description="Число пермутаций")
    alpha: float = Field(description="Уровень значимости кластеров")
    n_clusters: int = Field(description="Всего найдено кластеров")
    n_significant: int = Field(description="Значимых (p < alpha)")
    clusters: list[CompareClusterOut] = Field(
        default_factory=list,
        description="Кластеры по возрастанию p; вклад UI показывает значимые (significant=true)",
    )


class CompareIndicesOut(BaseModel):
    """Скалярные индексы обеих сторон и их дельты (IAF и отношения ритмов)."""

    iaf_a_hz: float | None = None
    iaf_b_hz: float | None = None
    delta_iaf_hz: float | None = Field(
        default=None, description="B − A, Гц; None — IAF не измерен на одной из сторон"
    )
    theta_beta_a: float | None = None
    theta_beta_b: float | None = None
    delta_theta_beta: float | None = None
    theta_alpha_beta_a: float | None = None
    theta_alpha_beta_b: float | None = None
    delta_theta_alpha_beta: float | None = None


class CompareSpecparamOut(BaseModel):
    """1/f-разложение (specparam) каждой стороны и дельты наклона/сдвига."""

    exponent_a: float | None = None
    exponent_b: float | None = None
    delta_exponent: float | None = None
    offset_a: float | None = None
    offset_b: float | None = None
    delta_offset: float | None = None
    fit_r_squared_a: float | None = None
    fit_r_squared_b: float | None = None
    peaks_a: list[SpectrumPeakOut] = Field(default_factory=list)
    peaks_b: list[SpectrumPeakOut] = Field(default_factory=list)


class CompareResult(BaseModel):
    """Результат задачи сравнения двух записей (``kind=compare``).

    Дельты всегда **B − A**: направление («деятельность минус покой») задаёт
    пользователь порядком выбора записей и ярлыками условий. Каветы
    интерпретации (``notes``) — обязательные подписи UI: кластерный тест не
    локализует эффект внутри кластера, а эпохи внутри записи автокоррелированы.
    """

    signature: str = Field(description="Отпечаток пары и параметров (ключ кэша карт разности)")
    side_a: CompareSideOut
    side_b: CompareSideOut
    match: CompareMatchOut
    freqs: list[float] = Field(description="Частотная сетка PSD, Гц (общая для обеих сторон)")
    psd_mean_a_uv2: list[float] = Field(description="PSD A, усреднённый по каналам и эпохам, мкВ²/Гц")
    psd_mean_b_uv2: list[float] = Field(description="PSD B, усреднённый по каналам и эпохам, мкВ²/Гц")
    psd_delta_db: list[float] = Field(description="10·log10(B/A) по частотам, дБ")
    bands: list[CompareBandOut] = Field(description="Дельты по диапазонам freq_bands")
    indices: CompareIndicesOut
    specparam: CompareSpecparamOut
    stats: CompareStatsOut
    topomap_version: str = Field(description="Версия карт разности (в URL — против «залипания» кэша)")
    notes: list[str] = Field(
        default_factory=list,
        description="Каветы интерпретации — показываются в UI под результатом без пересчёта",
    )
    warnings: list[str] = Field(default_factory=list)
    duration_sec_calc: float = 0.0


