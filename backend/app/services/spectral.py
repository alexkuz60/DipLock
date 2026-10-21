"""Спектр записи по ритмам δ…γ и топокарты диапазонов (срез 3.4, docs/ui.md §3.3).

Зачем отдельный сервис
----------------------
Разделу «Диполи» нужны две вещи, которых нет в пайплайне локализации:

* **спектр по диапазонам** — по каким ритмам вообще считать диполи (Welch PSD
  по эпохам записи, мкВ²/Гц);
* **топокарты** — картинка распределения мощности ритма по скальпу.

Пиксели UI не считает: топокарта приходит готовым PNG (как срез МРТ в 3.2),
а числа PSD — JSON-ом, чтобы гистограмму рисовал браузер. Отсюда разделение
ответов: ``SpectrumResult`` (числа + ссылки на картинки) и
``GET …/spectrum/topomap/{band}.png`` (PNG с ETag/304).

Что считается
-------------
* сигнал читается тем же загрузчиком, что и весь пайплайн (`load_edf`:
  монтаж 10-20, average reference, band-pass, notch), фильтр применяется к
  **continuous raw** до нарезки — как везде в проекте;
* эпохи нарезаются без наложения и проходят reject-порог: эпохи с амплитудой
  выше порога в PSD не попадают, иначе спектр «съедали» бы артефакты;
* PSD — по эпохам, метод **на выбор** (N17): ``welch`` (окно ``n_fft``,
  не длиннее эпохи) или ``multitaper`` (DPSS) — для коротких эпох 250–500 мс
  Welch с ``n_fft ≤ 256`` даёт 1–2 окна на эпоху и разрешение 4 Гц при ширине
  α в 5 Гц, multitaper тех же данных даёт сглаженную оценку низкой дисперсии;
* мощность диапазона — **интеграл PSD по полосе** (trapezoid, мкВ²), усреднённый по
  каналам, в мкВ² (N15): физически сравнимая величина между диапазонами разной
  ширины, в отличие от среднего по бинам; диапазоны — из ``freq_bands``
  (`core/config.py` — единственный источник, DRY). Топокарта рисуется тем же
  интегралом по каналам — шкала картинки и число в таблице совпадают;
* дополнительно (N16): ``relative_power`` (доля диапазона в интеграле всего
  спектра), медиана и квартили мощности по эпохам (разброс = стационарность
  ритма), IAF (индивидуальная пиковая α-частота, параболическое уточнение) и
  индексы θ/β и (θ+α)/β по интегральным мощностям;
* разложение 1/f + пики (specparam/FOOOF, N17-компаньон kimi3): апериодическая
  компонента (offset, exponent) и гауссовые пики над ней считаются по
  среднему спектру и отдаются вместе с кривой фона ``aperiodic_fit_uv2`` —
  «альфа-пик 10.2 Гц на фоне наклона» информативнее голого максимума, потому
  что на «розовом» фоне пики смещаются. Отказ фита не валит задачу: поля
  становятся ``null``, а текст — в ``warnings``;
 * **разведочный спектральный проход** (С3, B4): список отдельных частот с
   мощностью (PSD × df), плотностью и амплитудными диапазонами по эпохам
   (min/квартили/макс) в долях от «полки» своей полосы — вход для выбора узких
   поддиапазонов пакета С1. Нормировка — только внутри своего ритма (базис С0,
   константы ``EXPLORE_POWER_BASIS``/``EXPLORE_PSD_BASIS``): δ и γ сравнимы
   только как доли от своих максимумов. Выбор полос за числами не стоит
   (правило `docs/rules/dipoles.md`) — проход только показывает измерения.


Топокарта
---------
Каналы 10-20 раскладываются на плоскость **ортогональной проекцией** координат
монтажа (x, y в системе головы), интерполяцию и цвет делает MNE:
``mne.viz.plot_topomap`` — сферический сплайн и палитра ``TOPO_CMAP`` (N32).
Рендер — только Agg: ``matplotlib.use("Agg")`` вызывается на импорте модуля
**до** первого pyplot (его тянет внутри себя ``plot_topomap``), а фигура
собирается через ``Figure`` + ``FigureCanvasAgg`` без pyplot — расчёт идёт в
потоках (`job_manager`, ``asyncio.to_thread``), глобальное состояние pyplot там
не thread-safe. Вне контура головы пиксель прозрачен: за границей электродов
мощности нет, и «дорисовывать» её нельзя. Шкала каждого диапазона своя
(min..max его мощностей, как у прежнего IDW): картинка показывает форму
распределения, абсолютное число — в подписи под ней. PNG пишет свой
RGBA-энкодер (`app/utils/png.py`) — Pillow не нужен.

Кэш
---
Топокарты кладутся на диск (``cache_dir/spectra/<recording_id>/<signature>/<band>.png``)
и отдаются с ETag. ``signature`` — отпечаток параметров расчёта (полоса фильтра,
notch, длина эпохи, n_fft, набор каналов): сменили фильтр — сменилась подпись, и
старые картинки не «залипают» в кэше браузера. Повторный запрос PNG — чтение
файла без пересчёта PSD; если файла нет (задача ещё не считалась), он строится
лениво, как пирамида сигналов вьюера (2.5).
"""
import hashlib
import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import matplotlib
import mne
import numpy as np

from app.core.config import EXPLORE_POWER_BASIS, EXPLORE_PSD_BASIS, Settings
from app.services import journal
from app.services.cache_store import cache_clear, cache_path, cache_write
from app.services.edf_loader import _MONTAGE_NAMES
from app.services.epoch_segmenter import segment_epochs
from app.services.filter_design import nyquist_ceiling_hz
from app.services.prepared_signal import prepared_raw
from app.services.recordings import Recording
from app.utils.png import encode_png_rgba8

# Рендер топокарт — только Agg (N32): расчёт идёт в потоках, GUI-бэкенд в них
# не работает, а без дисплея matplotlib и так свалился бы в Agg молча. Вызов
# обязан опередить первый импорт pyplot — его тянет внутри себя
# `mne.viz.plot_topomap` (внутри вызова функции, а не на импорте модуля).
matplotlib.use("Agg")

logger = logging.getLogger(__name__)

# Окно Welch: длиннее 256 отсчётов смысла нет (частотное разрешение и так выше,
# чем нужно для октавных полос), а коротким эпохам окно урезается.
SPECTRUM_N_FFT = 256

# Методы оценки PSD (N17): Welch — привычный, multitaper (DPSS) — для коротких
# эпох, где Welch даёт 1–2 окна и грубую частотную сетку.
SPECTRUM_PSD_METHODS: tuple[str, ...] = ("welch", "multitaper")

# Ширина полосы сглаживания multitaper, Гц (DPSS). Не параметр формы: разумная
# ширина — свойство оценки, а не предмет разбора эксперимента.
SPECTRUM_MULTITAPER_BANDWIDTH_HZ = 4.0

# Сторона квадратной топокарты, пикселей. 128 — картинка ~10 КБ: её рисует
# `<img>` в разделе, а браузер кэширует по URL.
TOPO_SIZE = 128

# Палитра топокарт: viridis — перцептивно равномерная, читается и при
# дальтонизме, и в ч/б-копии; серый IDW заменён на неё (N32). Гамма —
# «обратная» по отношению к серой шкале (правка 20.10.2026): **более сильная
# мощность — более светлый цвет** (жёлтый конец viridis), а не более тёмный.
TOPO_CMAP = "viridis"

# Точки датчиков на топокарте (правка 20.10.2026): белые, крупные — 5 px в
# растре картинки. Реальные каналы записи — залитый круг; электроды эталонной
# сетки монтажа, которых в записи нет (например запись без T7/T8), — окружность
# того же размера: «пустое» место монтажа видно, но не выдаётся за измерение.
TOPO_DOT_PX = 5.0
TOPO_DOT_COLOR = "white"

# Линии топокарты (изолинии интерполяции и контур головы) — светлые: на тёмных
# зонах палитры тёмные линии не читались (правка 20.10.2026).
TOPO_LINE_RGBA = (1.0, 1.0, 1.0, 0.55)


class SpectrumError(ValueError):
    """Ошибка параметров/данных спектра — превращается в понятный текст задачи."""


@dataclass
class SpectrumParams:
    """Параметры расчёта спектра (плоская проекция формы запроса)."""

    filter_band: tuple[float, float] | None = None
    notch_hz: float | None = None
    epoch_length_ms: float = 2000.0
    reference: str = "average"
    reference_channels: list[str] | None = None
    n_fft: int = SPECTRUM_N_FFT
    # Метод PSD (N17): welch | multitaper. Меняет сами числа, поэтому входит
    # и в отпечаток кэша топокарт, и в результат задачи.
    psd_method: str = "welch"


def spectrum_signature(params: SpectrumParams, cfg: Settings, channels: Sequence[str]) -> str:
    """Отпечаток параметров расчёта: ключ дискового кэша топокарт и их ETag.

    Каналы входят в подпись осознанно: после смены набора каналов (или записи)
    топокарта «старыми» значениями не отдаётся.
    """
    digest = hashlib.sha256()
    band = f"{params.filter_band[0]:g}-{params.filter_band[1]:g}" if params.filter_band else "none"
    digest.update("|".join((
        band,
        f"notch={params.notch_hz}",
        f"epoch={params.epoch_length_ms:g}",
        f"nfft={params.n_fft}",
        f"ref={params.reference}",
        # Метод PSD меняет сами числа (N17): топокарта multitaper не имеет права
        # отдаваться по подписи расчёта Welch — иначе картинка не своего метода.
        f"method={params.psd_method}",
        ",".join(channels),
        ",".join(f"{name}:{cfg.freq_bands[name]}" for name in sorted(cfg.freq_bands)),
        ",".join(f"{name}:{cfg.functional_bands[name]}" for name in sorted(cfg.functional_bands)),
        # v3: топокарта — mne.viz.plot_topomap (сферический сплайн + палитра,
        # N32) вместо серого IDW — картинки прежней отрисовки не отдаются даже
        # при тех же параметрах (v2 была смена метрики мощности на интеграл, N15).
        # v4 (правка 20.10.2026): белые точки датчиков (залитый круг — реальные
        # каналы, окружность — отсутствующие в записи), светлые изолинии —
        # картинки прежней отрисовки в кэше не отдаются.
        "v4-topomap-sensors",
    )).encode("utf-8"))
    return digest.hexdigest()[:16]


def _topomap_path(cfg: Settings, recording_id: str, signature: str, band: str) -> str:
    """Путь топокарты в дисковом кэше."""
    return cache_path(cfg.cache_dir, "spectra", recording_id, signature, f"{band}.png")


def topomap_url(cfg: Settings, recording_id: str, band: str) -> str:
    """URL топокарты диапазона (версию клиент добавляет из ``topomap_version``)."""
    return f"{cfg.api_prefix}/recordings/{recording_id}/spectrum/topomap/{band}.png"


def clear_spectrum_cache(cfg: Settings, recording_id: str | None = None) -> None:
    """Удаляет дисковый кэш топокарт: одну запись или весь (тесты и реестр)."""
    parts = ("spectra", recording_id) if recording_id else ("spectra",)
    cache_clear(cfg.cache_dir, *parts)


@lru_cache(maxsize=4)
def _montage_positions(montage_name: str) -> dict[str, np.ndarray]:
    """Координаты каналов монтажа в системе головы (кэш: файл монтажа читается раз).

    Имя монтажа берётся из общего списка `edf_loader` (MNE 1.13 переименовал
    `standard_1020` в `colin27_1020`), чтобы не дублировать правила версий.
    """
    # MNE 1.13: `make_standard_montage(kind, head_size='auto')` — без verbose.
    montage = mne.channels.make_standard_montage(montage_name)
    return {
        name: np.asarray(position, dtype=float)
        for name, position in montage.get_positions()["ch_pos"].items()
    }


def channel_positions(channels: Sequence[str]) -> dict[str, np.ndarray]:
    """Позиции каналов записи по монтажу 10-20 (только те, что нашлись).

    Пустой dict — монтаж недоступен: спектр всё равно считается, а топокарты не
    строятся (UI покажет числа и предупреждение) — «рисовать наугад» нельзя.
    """
    for name in _MONTAGE_NAMES:
        try:
            positions = _montage_positions(name)
        except (ValueError, KeyError, RuntimeError):
            continue
        return {ch: positions[ch] for ch in channels if ch in positions}
    return {}


def _scalp_projection(positions: np.ndarray, radius: float | None = None) -> np.ndarray:
    """Плоскость скальпа: ортогональная проекция (x, y) головы, нормировка к [-1, 1].

    Нормировка по максимальному радиусу, а не по крайним значениям осей: так
    круг скальпа остаётся кругом, а его края совпадают с границей картинки.
    ``radius`` — база нормировки для точек, рисуемых на той же картинке
    («отсутствующие» датчики): без неё каждый набор масштабировался бы сам по
    себе, и точки легли бы не на свои места монтажа.
    """
    xy = positions[:, :2]
    if radius is None:
        radius = float(np.max(np.linalg.norm(xy, axis=1))) or 1.0
    return xy / radius


def head_map_positions(channels: Sequence[str]) -> dict[str, list[float]]:
    """Позиции датчиков для карты-силуэта головы в UI: ``(x, y)`` в ``[-1, 1]``.

    Проекция и нормировка — те же, что у топокарт (`_scalp_projection`):
    единица — максимальный радиус электродов списка, нос — ``+y`` (UI инвертирует
    экранную ось y). Нормировка по **переданному** списку, а не по отдельному
    каналу: координаты стабильны между запросами, контур головы рисуется шире
    датчиков — как в топокартах MNE.

    Пустой dict — монтаж недоступен: карту не строим, UI показывает список
    чекбоксов (`HeadChannelMap`), «рисовать наугад» нельзя.
    """
    positions = channel_positions(channels)
    if not positions:
        return {}
    names = list(positions)
    xy = _scalp_projection(np.stack([positions[name] for name in names]))
    return {name: [float(pair[0]), float(pair[1])] for name, pair in zip(names, xy, strict=True)}


def topomap_png(
    positions: dict[str, np.ndarray], values: dict[str, float], size: int = TOPO_SIZE,
    cmap: str = TOPO_CMAP, vlim: tuple[float, float] | None = None,
    absent: dict[str, np.ndarray] | None = None,
) -> bytes:
    """PNG топокарты: контур головы, палитра MNE, вне контура прозрачно.

    Чистая функция (без диска) — её и проверяет тест сервиса: картинка
    разбирается обратно RGBA-декодером (`tests/test_png.py`).

    ``cmap``/``vlim`` — для карт **разности** (B−A, дифференциальный анализ,
    `services/compare.py`): дивергентная палитра со шкалой ``(-m, m)``, чтобы
    знак дельты читался цветом; по умолчанию — всё как у карт мощности
    (viridis, min..max своих значений).

    ``absent`` — позиции электродов эталонной сетки монтажа, которых **нет** в
    записи: они рисуются окружностью (без заливки), реальные каналы — залитым
    кругом (правка 20.10.2026). Пустой/None — рисуются только реальные каналы.
    """
    if not positions:
        raise SpectrumError("Нет позиций каналов — топокарта не строится")
    names = [name for name in positions if name in values]
    if not names:
        raise SpectrumError("Нет мощностей для построения топокарты")

    stacked = np.stack([positions[name] for name in names])
    radius = float(np.max(np.linalg.norm(stacked[:, :2], axis=1))) or 1.0
    channel_xy = _scalp_projection(stacked, radius)
    data = np.asarray([values[name] for name in names], dtype=float)
    absent_map = absent or {}
    absent_names = [name for name in absent_map if name not in positions]
    absent_xy = (
        _scalp_projection(np.stack([absent_map[name] for name in absent_names]), radius)
        if absent_names else None
    )
    return encode_png_rgba8(_render_topomap(
        channel_xy, data, size, cmap=cmap, vlim=vlim, absent_xy=absent_xy,
    ))


def _render_topomap(
    channel_xy: np.ndarray, data: np.ndarray, size: int,
    cmap: str = TOPO_CMAP, vlim: tuple[float, float] | None = None,
    absent_xy: np.ndarray | None = None,
) -> np.ndarray:
    """Рендер `mne.viz.plot_topomap` в RGBA-массив формы (size, size, 4).

    Фигура собирается без pyplot (Agg включён на импорте модуля): расчёт идёт
    в потоках (`job_manager`, ``asyncio.to_thread``), а глобальное состояние
    pyplot в них не thread-safe. Ось — на весь холст, фон фигуры и оси
    прозрачный: вне контура головы пиксель не рисуется (изображение MNE
    обрезано контуром ``outlines='head'``, а линии контура не клипуются).
    ``vlim=None`` — шкала min..max самих данных (карта мощности); для карты
    разности передаётся симметричная пара ``(-m, m)``.

    Датчики MNE не рисует (``sensors=False``): точки ставятся своими после
    отрисовки — белые, Ø ``TOPO_DOT_PX`` px, реальные каналы залитым кругом,
    ``absent_xy`` (отсутствующие в записи) — окружностью. Изолинии и контур
    головы перекрашиваются в ``TOPO_LINE_RGBA`` (светлые): у `plot_topomap` нет
    параметра цвета линий, поэтому стилизуются уже нарисованные художники оси.
    """
    from matplotlib.backends.backend_agg import FigureCanvasAgg
    from matplotlib.figure import Figure
    from mne.viz import plot_topomap

    figure = Figure(figsize=(size / 100.0, size / 100.0), dpi=100, facecolor="none")
    canvas = FigureCanvasAgg(figure)
    axes = figure.add_axes((0.0, 0.0, 1.0, 1.0))
    axes.patch.set_alpha(0.0)
    plot_topomap(
        data, channel_xy,
        axes=axes, show=False, cmap=cmap, res=size,
        sensors=False,
        # Шкала каждого диапазона — свои min..max мощностей (как прежний IDW):
        # картинка показывает форму распределения, число — в подписи под ней.
        vlim=vlim if vlim is not None else (float(np.min(data)), float(np.max(data))),
    )
    # Светлые изолинии и контур головы + белые точки датчиков (см. хелперы).
    _lighten_topomap_lines(axes)
    _draw_sensor_dots(axes, channel_xy, absent_xy, dpi=figure.dpi)
    canvas.draw()
    return np.asarray(canvas.buffer_rgba(), dtype=np.uint8).copy()


def _lighten_topomap_lines(axes: Any) -> None:
    """Светлые линии топокарты: изолинии интерполяции и контур головы.

    `plot_topomap` не принимает цвет линий, поэтому перекрашиваются уже
    нарисованные художники оси (Line2D-контуры, коллекции изолиний, патчи).
    Слой точек датчиков добавляется **после** вызова — его стилизация здесь
    не задевается.
    """
    for line in axes.lines:
        line.set_color(TOPO_LINE_RGBA)
    for collection in axes.collections:
        collection.set_edgecolor(TOPO_LINE_RGBA)
        collection.set_linewidth(0.6)
    for patch in axes.patches:
        patch.set_edgecolor(TOPO_LINE_RGBA)


def _draw_sensor_dots(
    axes: Any, channel_xy: np.ndarray, absent_xy: np.ndarray | None, dpi: float,
) -> None:
    """Белые точки датчиков поверх топокарты (правка 20.10.2026).

    Ø ``TOPO_DOT_PX`` px в растре картинки (площадь маркера переводится из
    пикселей в points² — единицы ``s`` у scatter). Реальные каналы записи —
    залитый круг; ``absent_xy`` (электроды эталонной сетки без каналов в
    записи) — окружность: сетка монтажа читается целиком, но пустое место не
    выглядит измеренным.
    """
    dot_area = float(np.pi * (TOPO_DOT_PX * 72.0 / dpi / 2.0) ** 2)
    if absent_xy is not None and len(absent_xy) > 0:
        axes.scatter(
            absent_xy[:, 0], absent_xy[:, 1], s=dot_area,
            facecolors="none", edgecolors=TOPO_DOT_COLOR, linewidths=1.0,
        )
    axes.scatter(
        channel_xy[:, 0], channel_xy[:, 1], s=dot_area, facecolors=TOPO_DOT_COLOR,
    )



def _integrate_band(freqs: np.ndarray, values: np.ndarray, df: float) -> np.ndarray:
    """Интеграл PSD по маске диапазона вдоль последней оси (trapezoid), мкВ².

    Именно трапециевидное правило, а не Simpson: оно **аддитивно** — интегралы
    соседних полос в сумме дают интеграл охвата, поэтому `relative_power`
    гарантированно в 0..1. Simpson на узких пиках ритма (1–2 бина над 1/f)
    недосчитывает в зависимости от чётности точек и эту гарантию ломал.
    Одиночный бин трапециями не интегрируется — оценка значением × шаг сетки.
    """
    if freqs.size >= 2:
        return np.asarray(np.trapezoid(values, x=freqs, axis=-1), dtype=float)
    return np.asarray(np.sum(values, axis=-1), dtype=float) * df


def _band_powers(
    freqs: np.ndarray, psd_mean: np.ndarray, bands: dict[str, tuple],
) -> dict[str, float | None]:
    """Мощность каждого диапазона — **интеграл PSD по полосе, мкВ²** (N15).

    Интеграл, а не среднее по бинам: среднее сравнивало «плотности» и делало
    ответ зависимым от ширины диапазона (узкая α против широкого β), а
    физически сравнимая величина — площадь под PSD. PSD уже усреднён по эпохам.
    Диапазон без попавших частот (например γ при узкой полосе фильтра) даёт
    ``None``, а не NaN: «NaN» — невалидный JSON, и ответ ломался бы на клиенте,
    тогда как ``None`` читается как «не измерено» (UI покажет «—»).
    """
    df = float(freqs[1] - freqs[0]) if freqs.size > 1 else 1.0
    powers: dict[str, float | None] = {}
    for name, (fmin, fmax) in bands.items():
        mask = (freqs >= fmin) & (freqs <= fmax)
        if not np.any(mask):
            powers[name] = None
            continue
        per_channel = _integrate_band(freqs[mask], psd_mean[:, mask], df)
        powers[name] = float(np.mean(per_channel))
    return powers


def _individual_alpha_hz(
    freqs: np.ndarray, psd_mean: np.ndarray, alpha: tuple[float, float],
) -> float | None:
    """Индивидуальная пиковая α-частота (IAF): максимум среднего PSD в полосе α.

    Пик уточняется параболической интерполяцией по трём точкам: разрешение
    Welch (1–4 Гц) грубее ширины α-пика, голый argmax давал бы шаг сетки.
    ``None`` — в полосе меньше трёх бинов (ни пика, ни интерполяции).
    """
    mask = (freqs >= alpha[0]) & (freqs <= alpha[1])
    if int(mask.sum()) < 3:
        return None
    band_freqs = freqs[mask]
    band_psd = psd_mean[mask]
    peak = int(np.argmax(band_psd))
    if peak == 0 or peak == band_psd.size - 1:
        return float(band_freqs[peak])
    y0, y1, y2 = band_psd[peak - 1], band_psd[peak], band_psd[peak + 1]
    denom = float(y0 - 2.0 * y1 + y2)
    if denom >= 0:  # вершина не выпуклая — интерполяция бессмысленна
        return float(band_freqs[peak])
    shift = 0.5 * float(y0 - y2) / denom
    df = float(band_freqs[1] - band_freqs[0])
    return float(band_freqs[peak] + shift * df)


def _band_key_of_freq(freq: float, bands: dict[str, tuple]) -> str | None:
    """Ключ ритма `freq_bands`, которому принадлежит частота (С3).

    Полуинтервал ``[lo, hi)``: граница ритмов (2 Гц между δ и δ/θ) принадлежит
    верхнему ритму, иначе строка прохода нормировалась бы на «чужую» полку.
    Верхняя граница самого верхнего ритма принадлежит ему. ``None`` — частота
    вне ритмов (дыра в пользовательской сетке): строка остаётся в списке без
    нормировки — «не измерено», а не выдуманный ключ.
    """
    names = list(bands)
    for index, name in enumerate(names):
        lo, hi = bands[name]
        if lo <= freq < hi:
            return name
        # Верхняя граница самого верхнего ритма включается (запас 1e-9 — на
        # округление сетки), но частоты выше ритмов сюда не попадают.
        if index == len(names) - 1 and lo <= freq <= hi + 1e-9:
            return name
    return None


def _band_psd_peaks(
    freqs: np.ndarray, psd_ch_mean: np.ndarray, bands: dict[str, tuple],
) -> dict[str, tuple[float | None, float | None]]:
    """Пик PSD каждого ритма (B4 «пик по частоте»): ``(частота, значение)``.

    Голый argmax по бинам полосы, без параболы (как у IAF): «пик по частоте» —
    нормировочная база плотности и ориентир выбора узких поддиапазонов (С3),
    а не уточнённая физиологическая частота. Ритм без бинов на оси —
    ``(None, None)`` («не измерено»).
    """
    peaks: dict[str, tuple[float | None, float | None]] = {}
    for name, (fmin, fmax) in bands.items():
        mask = (freqs >= fmin) & (freqs <= fmax)
        if not np.any(mask):
            peaks[name] = (None, None)
            continue
        band_freqs = freqs[mask]
        band_psd = psd_ch_mean[mask]
        index = int(np.argmax(band_psd))
        peaks[name] = (float(band_freqs[index]), float(band_psd[index]))
    return peaks


def _explore_pass(
    freqs: np.ndarray,
    psd: np.ndarray,
    psd_ch_mean: np.ndarray,
    bands: dict[str, tuple],
    band_max: dict[str, float | None],
    psd_peaks: dict[str, tuple[float | None, float | None]],
    df: float,
) -> dict[str, Any]:
    """Разведочный спектральный проход (С3): список частот в нормированных единицах.

    Одна строка — один бин сетки PSD. Поля (B4/`SpectrumExploreLineOut`):

    * мощность бина — ``PSD × df`` (прямоугольник: у одного бина нет площади
      под кривой), плотность — среднее по каналам и эпохам;
    * **амплитудный диапазон частоты** — разброс её мощности по эпохам сессии
      (min/квартили/макс) в долях от «полки» своей полосы (`band_max`,
      ``EXPLORE_POWER_BASIS``); доли мощности — от той же «полки», доли
      плотности — от пика PSD своей полосы (`psd_peaks`, ``EXPLORE_PSD_BASIS``).

    Без базы нормировки (ритм вне оси, нулевая «полка») доли — ``None``, а не
    ноль: «не измерено» честнее выдуманного значения (правило B4).
    """
    def share(value: float, base: float | None) -> float | None:
        return float(value / base) if base else None

    lines: list[dict[str, Any]] = []
    for index, freq in enumerate(freqs):
        band_key = _band_key_of_freq(float(freq), bands)
        psd_value = float(psd_ch_mean[index])
        power_value = psd_value * df
        power_base = band_max.get(band_key) if band_key else None
        psd_base = psd_peaks.get(band_key, (None, None))[1] if band_key else None
        series = np.mean(psd[:, :, index] * df, axis=-1) if psd.size else np.empty(0)
        if series.size:
            amp_min, amp_q25, amp_med, amp_q75, amp_max = np.percentile(
                series, [0, 25, 50, 75, 100],
            )
        else:
            amp_min = amp_q25 = amp_med = amp_q75 = amp_max = None
        lines.append({
            "freq_hz": float(freq),
            "band_key": band_key,
            "psd_uv2_hz": psd_value,
            "power_uv2": power_value,
            "psd_share": share(psd_value, psd_base),
            "power_share": share(power_value, power_base),
            "amp_min_share": share(float(amp_min), power_base) if amp_min is not None else None,
            "amp_q25_share": share(float(amp_q25), power_base) if amp_q25 is not None else None,
            "amp_median_share": share(float(amp_med), power_base) if amp_med is not None else None,
            "amp_q75_share": share(float(amp_q75), power_base) if amp_q75 is not None else None,
            "amp_max_share": share(float(amp_max), power_base) if amp_max is not None else None,
        })
    return {
        "df_hz": df,
        "power_basis": EXPLORE_POWER_BASIS,
        "psd_basis": EXPLORE_PSD_BASIS,
        "lines": lines,
    }



def _channel_band_power(
    freqs: np.ndarray, psd_mean: np.ndarray, channels: list[str], fmin: float, fmax: float,
) -> dict[str, float]:
    """Мощность диапазона по каждому каналу — значения для топокарты."""
    mask = (freqs >= fmin) & (freqs <= fmax)
    if not np.any(mask):
        return {}
    # Интеграл PSD (как `_band_powers`, N15): иначе шкала картинки и число
    # в таблице диапазонов читались бы в разных единицах.
    df = float(freqs[1] - freqs[0]) if freqs.size > 1 else 1.0
    per_channel = _integrate_band(freqs[mask], psd_mean[:, mask], df)
    # ``strict=False`` — явная фиксация контракта: набор каналов и мощность берутся
    # из одного расчёта, а если они разойдутся, обрезка повторит прежнее поведение.
    return {name: float(value) for name, value in zip(channels, per_channel, strict=False)}


def _prepare_epochs(recording: Recording, cfg: Settings, params: SpectrumParams) -> Any:
    """Читает запись и нарезает эпохи для PSD (reject-порог из параметров).

    Аннотации артефактов здесь не нужны: `segment_epochs` отбраковывает эпохи по
    амплитуде (reject), а детекция артефактов — отдельная стадия предподготовки
    (2.7). Считать её второй раз ради спектра незачем. Сигнал берётся из кэша
    подготовленного сигнала (A4): повтор расчёта с теми же параметрами не читает
    EDF заново.
    """
    l_freq: float | None = None
    h_freq: float | None = None
    if params.filter_band is not None:
        l_freq, h_freq = params.filter_band

    try:
        raw = prepared_raw(
            recording,
            cfg,
            l_freq=l_freq,
            h_freq=h_freq,
            notch_hz=params.notch_hz,
            reference_channels=params.reference_channels,
            pipeline="spectrum",
        )
    except ValueError as exc:
        raise SpectrumError(str(exc)) from exc

    try:
        with journal.step(
            "spectrum", "segment_epochs",
            note=f"epoch={params.epoch_length_ms:g}ms",
        ) as entry:
            epochs = segment_epochs(
                raw,
                mne.Annotations([], [], []),
                filter_band=params.filter_band,
                epoch_length_ms=params.epoch_length_ms,
            )
            entry.epochs = len(epochs.drop_log)
    except ValueError as exc:
        raise SpectrumError(str(exc)) from exc
    return raw, epochs


def _compute_psd(
    epochs: Any, cfg: Settings, params: SpectrumParams,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    """PSD по эпохам: ``(freqs, psd, psd_mean, n_fft)`` в мкВ²/Гц.

    Данные MNE приходят в вольтах, поэтому x1e12 даёт мкВ²/Гц без параметра
    ``units`` (он дрейфует между версиями MNE — см. правила в `AGENTS.md`).
    Метод оценки — из параметров (N17):

    * ``welch`` — окно ``n_fft`` не длиннее эпохи (иначе короткие нарезки
      250 мс роняют `compute_psd`);
    * ``multitaper`` — DPSS на всей эпохе целиком: у коротких окон нет «второго
      окна» для усреднения, а multitaper даёт сглаженную оценку низкой дисперсии.
      Ширина полосы сглаживания не может быть меньше ``2·sfreq/n_times``:
      иначе time-bandwidth product DPSS падает ниже единицы (один тейпер),
      и оценка вырождается. ``n_fft`` в подписи результата для multitaper —
      длина окна анализа (эпоха целиком), а не параметр окна Welch.
    """
    n_times = len(epochs.times)
    sfreq = float(epochs.info["sfreq"])
    n_fft = int(min(max(4, params.n_fft), n_times))
    # Ось PSD — пересечение сетки `freq_bands` и полосы фильтра: сигнал **вне**
    # полосы отфильтрован, и числа там — околонулевой шум, а не спектр (по ним
    # 1/f-фит «раздувал» бы наклон, а бинов вне оси у диапазона честно нет —
    # None). Потолок — Найквист − 2 Гц: сетка доходит до 128 Гц, а запись может
    # быть 250 Гц (MNE: «fmax must not exceed ½ the sampling frequency»).
    fmin = min(band[0] for band in cfg.freq_bands.values())
    fmax = max(band[1] for band in cfg.freq_bands.values())
    if params.filter_band is not None:
        fmin = max(fmin, params.filter_band[0])
        fmax = min(fmax, params.filter_band[1])
    fmax = min(fmax, nyquist_ceiling_hz(sfreq))
    if fmin >= fmax:
        raise SpectrumError(
            f"Полоса фильтра {params.filter_band} целиком выше частотного предела "
            f"записи (Найквист − 2 Гц = {nyquist_ceiling_hz(sfreq):g} Гц)"
        )

    if params.psd_method == "multitaper":
        bandwidth = max(SPECTRUM_MULTITAPER_BANDWIDTH_HZ, 2.0 * sfreq / n_times)
        spectrum = epochs.compute_psd(
            method="multitaper", fmin=fmin, fmax=fmax, bandwidth=bandwidth, verbose=False,
        )
        window = n_times
    elif params.psd_method == "welch":
        spectrum = epochs.compute_psd(
            method="welch", fmin=fmin, fmax=fmax, n_fft=n_fft, verbose=False,
        )
        window = n_fft
    else:
        raise SpectrumError(
            f"Неизвестный метод PSD: {params.psd_method!r} — доступны {', '.join(SPECTRUM_PSD_METHODS)}"
        )
    psd = spectrum.get_data() * 1e12  # (n_epochs, n_channels, n_freqs), мкВ²/Гц
    freqs = np.asarray(spectrum.freqs, dtype=float)
    return freqs, psd, np.mean(psd, axis=0), window


def _fit_specparam(
    freqs: np.ndarray, psd_mean: np.ndarray,
) -> tuple[dict[str, Any], list[str]]:
    """Разложение 1/f + пики (specparam/FOOOF): ``(fit, warnings)``.

    Подгоняется средний спектр записи (та же линия, что рисует UI): апериодика
    ``offset − exponent·log10(f)`` в log10-пространстве мощности и гауссовые
    пики над ней. Модель — fixed (без «колена»): полоса 1–40 Гц его не видит,
    а лишняя свобода раскачивала бы exponent.

    Контракт возврата — словарь под поля ``SpectrumResult`` (кривая фона — на
    всей сетке ``freqs``, та же длина, что ``psd_mean_uv2``, чтобы клиент рисовал
    её поверх PSD без досчётов). **Любой** сбой фита не валит задачу: возвращается
    пустой fit и предупреждение — «не измерено» честнее, чем упавшая задача.
    """
    warnings: list[str] = []
    empty: dict[str, Any] = {
        "aperiodic_exponent": None,
        "aperiodic_offset": None,
        "aperiodic_fit_uv2": [],
        "peaks": [],
        "fit_r_squared": None,
    }
    mask = np.isfinite(psd_mean) & (psd_mean > 0) & (freqs > 0)
    if int(mask.sum()) < 8:
        warnings.append("1/f-разложение не посчитано: слишком мало положительных бинов спектра")
        return empty, warnings
    try:
        from specparam import SpectralModel
    except ImportError as exc:  # зависимости могли не собраться — это не 500 задачи
        warnings.append(f"1/f-разложение недоступно: {exc}")
        return empty, warnings

    fit_freqs = freqs[mask]
    fit_psd = psd_mean[mask]
    try:
        # API specparam 2.0 дрейфует (как у MNE): фиксируем его тестами,
        # а всё, что мы читаем, — `fit` + `results.get_params(...)` (docs/rules/safety.md).
        model = SpectralModel(
            peak_width_limits=(1.5, 8.0), aperiodic_mode="fixed", verbose=False,
        )
        model.fit(fit_freqs, fit_psd)
        aperiodic = np.asarray(model.results.get_params("aperiodic"), dtype=float)
        offset, exponent = float(aperiodic[0]), float(aperiodic[1])
        raw_peaks = np.asarray(model.results.get_params("peak"), dtype=float)
    except Exception as exc:  # отказ фита любой природы = предупреждение, не 500
        warnings.append(f"1/f-разложение не сошлось: {exc}")
        return empty, warnings

    # Кривая фона — сами по параметрам (offset, exponent): в log10-пространстве
    # specparam это `offset − exponent·log10(f)`, и считать её без объекта модели
    # надёжнее — меньше зависимостей от того, как пакет назовёт атрибуты.
    positive = freqs > 0
    background = np.zeros_like(freqs, dtype=float)
    background[positive] = 10.0 ** (
        offset - exponent * np.log10(np.maximum(freqs[positive], 1e-12))
    )

    peaks_out: list[dict[str, float]] = []
    if raw_peaks.size:
        peaks_2d = raw_peaks.reshape(-1, 3)
        # Пики упорядочиваются по убыванию высоты (так их показывает UI)
        for center_hz, height_log10, bandwidth_hz in peaks_2d[
            np.argsort(-peaks_2d[:, 1])
        ]:
            peaks_out.append({
                "center_hz": float(center_hz),
                # Высота над фоном в log10-пространстве мощности → дБ (×10)
                "amplitude_db": float(height_log10 * 10.0),
                "bandwidth_hz": float(bandwidth_hz),
            })

    # GOF — как в FOOOF: R² между log10(PSD) и кривой модели
    log_psd = np.log10(fit_psd)
    log_fit = np.log10(np.maximum(background[mask], 1e-30))
    ss_res = float(np.sum((log_psd - log_fit) ** 2))
    ss_tot = float(np.sum((log_psd - float(np.mean(log_psd))) ** 2))
    r_squared = (1.0 - ss_res / ss_tot) if ss_tot > 0 else None

    return {
        "aperiodic_exponent": exponent,
        "aperiodic_offset": offset,
        "aperiodic_fit_uv2": [float(value) for value in background],
        "peaks": peaks_out,
        "fit_r_squared": r_squared,
    }, warnings


def compute_spectrum(
    recording: Recording,
    cfg: Settings,
    params: SpectrumParams,
    progress: Any = None,
) -> dict[str, Any]:
    """Считает PSD по диапазонам, строит и кэширует топокарты.

    Возвращает dict под схему ``SpectrumResult`` (её валидирует API): так воркер
    не зависит от схемы ответа, а прогресс доступен по ходу вычислений.
    """
    report = progress or (lambda *args, **kwargs: None)
    started = time.perf_counter()
    report("load_edf", message="Чтение EDF, монтаж 10-20")

    raw, epochs = _prepare_epochs(recording, cfg, params)
    channels = list(epochs.ch_names)
    if not channels:
        raise SpectrumError("В записи не нашлось каналов для спектра")
    # Сигнатура результата (ETag топокарт) — до расчёта: она же `params_key`
    # строк журнала, по ней видно, делили ли задачи кэш.
    signature = spectrum_signature(params, cfg, channels)

    report(
        "spectrum",
        message=f"PSD ({params.psd_method}) по {len(epochs)} эпохам",
        epochs_done=0,
        epochs_total=len(epochs),
    )
    with journal.step(
        "spectrum", "psd", params_key=signature, epochs=len(epochs),
    ) as entry:
        freqs, psd, psd_mean, n_fft = _compute_psd(epochs, cfg, params)
        entry.note = f"method={params.psd_method}, n_fft={n_fft}, epoch={params.epoch_length_ms:g}ms"
    psd_ch_mean = np.mean(psd_mean, axis=0)
    # Все частотные полосы каталога (правка 20.10.2026): базовые октавные +
    # функциональные ритмы — числа и топокарты по всем полосам, а не только по
    # октавной сетке. Разведочный проход остаётся на `cfg.freq_bands`:
    # функциональные полосы пересекаются с базовыми (μ 8–13 внутри α 8–16), а
    # разбиение «частота → своя полоса» обязано быть однозначным.
    spectrum_bands: dict[str, tuple] = {**cfg.freq_bands, **cfg.functional_bands}
    band_powers = _band_powers(freqs, psd_mean, spectrum_bands)
    # N16: медиана/квартили мощности диапазона по эпохам (куб PSD уже посчитан
    # в `_compute_psd`, поэтому разброс — почти бесплатный).
    df = float(freqs[1] - freqs[0]) if freqs.size > 1 else 1.0
    epoch_stats: dict[str, tuple[float, float, float] | None] = {}
    # «Полка» полосы (B4, С3): максимум мощности полосы по эпохам сессии —
    # нормировочная база X % КД и долей разведочного прохода.
    band_maxima: dict[str, float | None] = {}
    for band_name, (fmin, fmax) in spectrum_bands.items():
        mask = (freqs >= fmin) & (freqs <= fmax)
        if not mask.any():
            epoch_stats[band_name] = None
            band_maxima[band_name] = None
            continue
        series = np.mean(_integrate_band(freqs[mask], psd[:, :, mask], df), axis=-1)
        epoch_stats[band_name] = (
            float(np.median(series)),
            float(np.percentile(series, 25)),
            float(np.percentile(series, 75)),
        )
        band_maxima[band_name] = float(np.max(series))
    # С3 — разведочный спектральный проход: пик PSD каждого ритма (B4) и список
    # частот в нормированных единицах. Считается на уже готовом кубе PSD —
    # отдельного чтения записи не требует (вход выбора полос пакета С1).
    psd_peaks = _band_psd_peaks(freqs, psd_ch_mean, spectrum_bands)
    with journal.step("spectrum", "explore", params_key=signature, epochs=len(epochs)) as entry:
        explore = _explore_pass(
            freqs, psd, psd_ch_mean, cfg.freq_bands, band_maxima, psd_peaks, df,
        )
        entry.note = f"lines={len(explore['lines'])}"

    # Полная мощность спектра — интеграл среднего PSD: знаменатель relative power.
    total_power = float(np.trapezoid(psd_ch_mean, x=freqs)) if freqs.size >= 2 else 0.0
    alpha_range = cfg.freq_bands.get("alpha")
    iaf_hz = (
        _individual_alpha_hz(freqs, psd_ch_mean, alpha_range)
        if alpha_range is not None else None
    )
    theta_p = band_powers.get("theta")
    alpha_p = band_powers.get("alpha")
    beta_p = band_powers.get("beta")
    theta_beta_ratio = theta_p / beta_p if theta_p is not None and beta_p else None
    theta_alpha_beta_ratio = (
        (theta_p + alpha_p) / beta_p
        if theta_p is not None and alpha_p is not None and beta_p else None
    )

    # 1/f + пики (specparam/FOOOF): фит дешёвый (curve_fit по ~40 бинам),
    # поэтому считается в этой же задаче, а не отдельной.
    report("specparam", message="Разложение 1/f и поиск пиков")
    with journal.step(
        "spectrum", "specparam", params_key=signature,
    ) as entry:
        specparam_fit, specparam_warnings = _fit_specparam(freqs, psd_ch_mean)
        entry.note = (
            f"peaks={len(specparam_fit['peaks'])}, "
            f"exponent={specparam_fit['aperiodic_exponent']}"
        )

    warnings: list[str] = [*specparam_warnings]
    positions = channel_positions(channels)
    missed = [name for name in channels if name not in positions]
    if missed:
        warnings.append(
            "Каналы без позиции в монтаже не попали в топокарты: " + ", ".join(missed)
        )
    if len(positions) < 3:
        warnings.append("Слишком мало каналов с позициями — топокарты не построены")
    # «Отсутствующие» датчики (правка 20.10.2026): электроды эталонной сетки
    # монтажа, которых нет среди каналов записи (как их показывает раздел ЭЭГ).
    # На топокарте они — белые окружности: сетка монтажа читается целиком, а
    # дырки в записи не выдаются за измеренные каналы.
    absent = {
        name: xy for name, xy in channel_positions(cfg.standard_channels).items()
        if name not in positions
    }

    report(
        "topomaps",
        message=f"Топокарты диапазонов: {len(spectrum_bands)}",
        epochs_done=len(epochs),
        epochs_total=len(epochs),
    )
    bands_out: list[dict[str, Any]] = []
    written = 0
    with journal.step(
        "spectrum", "topomaps", params_key=signature, epochs=len(epochs),
    ) as entry:
        for name, (fmin, fmax) in spectrum_bands.items():
            url: str | None = None
            values = _channel_band_power(freqs, psd_mean, channels, fmin, fmax)
            if len(values) >= 3:
                size = _write_topomap(
                    cfg, recording.recording_id, signature, name, positions, values,
                    absent=absent,
                )
                written += size or 0
                url = topomap_url(cfg, recording.recording_id, name)
            power = band_powers[name]
            stats = epoch_stats[name]
            bands_out.append({
                "name": name,
                "fmin": float(fmin),
                "fmax": float(fmax),
                "power_uv2": power,
                "relative_power": (
                    power / total_power if power is not None and total_power > 0 else None
                ),
                "median_power_uv2": stats[0] if stats else None,
                "q25_power_uv2": stats[1] if stats else None,
                "q75_power_uv2": stats[2] if stats else None,
                # B4 (С3): два максимума полосы — «полка» по эпохам и пик по частоте
                "band_power_max_uv2": band_maxima[name],
                "psd_peak_uv2_hz": psd_peaks[name][1],
                "psd_peak_hz": psd_peaks[name][0],
                "topomap_url": url,
            })
        entry.bytes_out = written or None
        entry.note = (
            f"bands={len(spectrum_bands)}, "
            f"written={sum(1 for band in bands_out if band['topomap_url'])}"
        )

    report(
        "done", 1.0,
        message=f"Спектр готов: {len(freqs)} частот, {len(spectrum_bands)} диапазонов",
        epochs_done=len(epochs),
        epochs_total=len(epochs),
    )
    return {
        "recording_id": recording.recording_id,
        "channels": channels,
        "missed_channels": missed,
        "sfreq": float(raw.info["sfreq"]),
        "epoch_length_ms": params.epoch_length_ms,
        "n_epochs": len(epochs),
        "n_fft": n_fft,
        "psd_method": params.psd_method,
        "filter_band_hz": list(params.filter_band) if params.filter_band else None,
        "notch_hz": params.notch_hz,
        "freqs": [float(value) for value in freqs],
        "psd_mean_uv2": [float(value) for value in psd_ch_mean],
        "bands": bands_out,
        "explore": explore,
        "iaf_hz": iaf_hz,
        "theta_beta_ratio": theta_beta_ratio,
        "theta_alpha_beta_ratio": theta_alpha_beta_ratio,
        **specparam_fit,
        "topomap_version": signature,
        "warnings": warnings,
        "duration_sec_calc": round(time.perf_counter() - started, 3),
    }


def _write_topomap(
    cfg: Settings,
    recording_id: str,
    signature: str,
    band: str,
    positions: dict[str, np.ndarray],
    values: dict[str, float],
    absent: dict[str, np.ndarray] | None = None,
) -> int | None:
    """Строит и атомарно кладёт топокарту на диск; сбой кэша не критичен.

    Возвращает размер PNG (``None`` — картинка не построена): размер нужен
    журналу шагов, чтобы «топокарты 120 мс» можно было сверить с объёмом записи.
    ``absent`` — позиции отсутствующих датчиков (см. `topomap_png`).
    """
    path = _topomap_path(cfg, recording_id, signature, band)
    try:
        data = topomap_png(positions, values, absent=absent)
    except Exception as exc:  # сбой картинки (в т.ч. matplotlib) не валит задачу спектра
        logger.warning("Топокарта %s не построена: %s", band, exc)
        return None
    cache_write(path, data, label="Кэш топокарт")
    return len(data)


def cached_topomap(
    recording: Recording, cfg: Settings, params: SpectrumParams, band: str,
) -> tuple[bytes, str]:
    """PNG топокарты + ETag; при промахе кэша картинка строится заново.

    Ленивый пересчёт (как у пирамиды сигналов, 2.5): браузер может запросить
    картинку из уже показанного результата после перезапуска сервера — кэша в
    памяти нет, но посчитать картинку дешевле, чем отдать 404 на живую ссылку.
    """
    if band not in cfg.freq_bands and band not in cfg.functional_bands:
        raise SpectrumError(f"Неизвестный диапазон: {band!r}")
    channels = list(recording.meta.get("channels") or [])
    signature = spectrum_signature(params, cfg, channels)
    path = _topomap_path(cfg, recording.recording_id, signature, band)
    started = time.perf_counter()
    try:
        with open(path, "rb") as fh:
            data = fh.read()
        journal.record(
            "spectrum", "topomap_read",
            ms=(time.perf_counter() - started) * 1000.0,
            params_key=signature, bytes_out=len(data), cache_hit=True, note=f"band={band}",
        )
    except OSError:
        journal.record(
            "spectrum", "topomap_read",
            ms=(time.perf_counter() - started) * 1000.0,
            params_key=signature, cache_hit=False, note=f"band={band}, reason=cold",
        )
        compute_spectrum(recording, cfg, params)
        try:
            with open(path, "rb") as fh:
                data = fh.read()
        except OSError as exc:
            raise SpectrumError(
                f"Топокарта {band} недоступна: не удалось построить (позиции каналов?)"
            ) from exc
    return data, f"{signature}-{band}"
