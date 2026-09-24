"""Быстрый расчёт диполей: одна точка на эпоху и перебор объёмной сетки (срез 3.4).

Зачем не `mne.fit_dipole`
-----------------------
Точный фитинг (`services/dipole_fitter.py`) считает траекторию по всем отсчётам
эпохи на BEM-модели головы: это десятки секунд на запись и главный потребитель
времени в пайплайне. Разделу нужно **увидеть результат сразу** — по кнопке, с
прогрессом, — поэтому здесь реализован «быстрый» режим с честно названными
компромиссами (docs/ui.md §3.3, профиль `fast`):

* одна эпоха → **один** диполь в пике GFP (global field power): у эпохи берётся
  отсчёт с максимальной суммарной амплитудой, а не траектория по всем отсчётам;
* модель головы — **сферическая** (проводимость 0.3 См/м) вместо BEM fsaverage;
* положение ищется **перебором узлов** объёмной сетки (~7 мм) с линейным МНК по
  моменту, а не градиентной оптимизацией: узел с лучшим GOF и есть ответ.

Ошибка позиции при этом — порядка шага сетки, а не миллиметра. Это осознанный
размен, а не «упрощение ради простоты»: результат помечен `method='fast_grid'`,
и точный режим останется отдельным профилем, а не подменой чисел.

Почему перебор векторизован
---------------------------
Свинцовое поле `G` (канал × узел × 3), его центрирование по каналам и
обращённая (с ridge) `GᵀG` не зависят от сигнала эпохи, поэтому считаются
**один раз на монтаж и шаг сетки** и кэшируются как «ядро» (`_scan_kernel`,
N20). По узлам всё считается массивами: `Gᵀd`, `m = (GᵀG)⁻¹Gᵀd`, невязка —
цикл по узлам был бы в сотни раз дольше. Замер на 261 эпохе, 18 каналов
(синтетика, `scripts`-бенчмарк от 19.09.2026): шаг 7 мм (~4200 узлов) —
10.6 → 0.8 мс на эпоху (13×), шаг 4 мм (~22 тыс. узлов) — 51 → 4.6 мс (11×).
До N20 (поле и `GᵀG` считались на каждую эпоху) живой прогон `test.edf`
(130.7 с, 500 Гц, нарезка 500 мс) давал: 7 мм — 2.2 с, 4 мм — 11.8 с,
2 мм (~180 тыс. узлов) — 99.8 с; после N20 цикл перебора — доли секунды,
а доминируют загрузка сигнала и локализация (атлас, transform).

Что остаётся общим с точным режимом
-----------------------------------
* единицы: данные MNE — вольты, момент — А·м, в ответ уходит нА·м (×1e9), как в
  таблице локализации;
* average reference: сигнал уже вычтен по среднему (``load_edf`` в кэше
  подготовленного сигнала), поэтому и
  свинцовое поле центрируется по каналам — иначе МНК «подгонял» бы общий сдвиг;
* минимальное расстояние диполя от электродов 5 мм (`min_dist` у `fit_dipole`);
* MNI — только через `mne.read_trans` + `mne.head_to_mni` (правило безопасности
  из `AGENTS.md`: путь-строка в `head_to_mni` не передаётся).
"""
import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import mne
import numpy as np

from app.core.config import Settings
from app.services import journal
from app.services.asset_versions import BRODMANN_METHOD
from app.services.dipole_fitter import _get_bem, _get_covariance, attribution_fields
from app.services.epoch_segmenter import segment_epochs
from app.services.prepared_signal import prepared_raw
from app.services.recordings import Recording
from app.services.spectral import channel_positions

logger = logging.getLogger(__name__)

# Шаг объёмной сетки поиска, мм (в UI и в форме запроса диапазон 2…20 мм).
# 7 мм — компромисс: ~4200 узлов дают ~8 мс на эпоху, а ошибка позиции всё равно
# больше точности BEM-фита. Шаг 2 мм уточняет позицию, но считается в ~40 раз
# дольше (см. замер в докстринге модуля), поэтому это осознанный выбор быстрого
# профиля, а не настройка «чем меньше, тем лучше».
GRID_STEP_MM = 7.0

# Сетка — шар вокруг центра мозга в системе координат головы, мм. Центр взят
# чуть выше нуля: кора fsaverage лежит в диапазоне z ≈ 0…90 мм.
GRID_CENTER_MM: tuple[float, float, float] = (0.0, 0.0, 40.0)
GRID_RADIUS_MM = 70.0

# Диполь не ставится ближе 5 мм к электроду (как `min_dist` у `mne.fit_dipole`):
# иначе решение «взрывается» у поверхности скальпа.
MIN_SENSOR_DISTANCE_MM = 5.0

# Проводимость головы, См/м (однородная сфера: стандартное приближение).
HEAD_CONDUCTIVITY_S_M = 0.3

# Коэффициент потенциала точечного диполя в проводящей среде: Φ = (m·r)/(4πσr³)
_FOUR_PI = 4.0 * np.pi


class DipoleScanError(ValueError):
    """Ошибка параметров/данных быстрого расчёта — понятный текст для задачи."""


@dataclass
class DipoleScanParams:
    """Параметры быстрого расчёта диполей (плоская проекция формы запроса)."""

    filter_band: tuple[float, float] | None = None
    notch_hz: float | None = None
    epoch_length_ms: float = 1000.0
    reference: str = "average"
    reference_channels: list[str] | None = None
    grid_mm: float = GRID_STEP_MM


@lru_cache(maxsize=8)
def candidate_grid(
    step_mm: float = GRID_STEP_MM,
    center_mm: tuple[float, float, float] = GRID_CENTER_MM,
    radius_mm: float = GRID_RADIUS_MM,
) -> np.ndarray:
    """Узлы объёмной сетки поиска в метрах: шар вокруг центра мозга.

    Кэшируется целиком: сетка зависит только от шага/центра/радиуса, а не от
    записи, поэтому строится один раз на процесс.
    """
    step = float(step_mm)
    if step <= 0:
        raise DipoleScanError(f"Шаг сетки должен быть положительным (получено {step_mm})")
    offsets = np.arange(-radius_mm, radius_mm + 1e-9, step)
    grid = np.stack(np.meshgrid(offsets, offsets, offsets, indexing="ij"), axis=-1)
    grid = grid.reshape(-1, 3)
    grid = grid[np.linalg.norm(grid, axis=1) <= radius_mm]
    return (grid + np.asarray(center_mm, dtype=float)) / 1000.0


def _leadfield(
    positions_m: np.ndarray, grid_m: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Свинцовое поле точечного диполя: ``G`` (канал × узел × 3) и расстояния.

    Φ_i = (m · (r_i − r_q)) / (4πσ |r_i − r_q|³). Домножение на 1/(4πσ) делает
    момент физическим (А·м), а не произвольным масштабом: амплитуда из ответа
    сравнима с результатом `mne.fit_dipole`.
    """
    diff = positions_m[:, None, :] - grid_m[None, :, :]  # (n_ch, n_grid, 3)
    distance = np.linalg.norm(diff, axis=2)              # (n_ch, n_grid)
    gain = 1.0 / (_FOUR_PI * HEAD_CONDUCTIVITY_S_M * np.maximum(distance, 1e-9) ** 3)
    return diff * gain[:, :, None], distance


@dataclass(frozen=True)
class _ScanKernel:
    """Предрасчёт перебора сетки, не зависящий от сигнала эпохи (N20).

    Свинцовое поле, его центрирование по каналам, обращённая (с ridge) GᵀG
    и маска «узел слишком близко к электроду» одинаковы для всех эпох записи,
    поэтому считаются один раз. В цикле по эпохам остаются только Gᵀd,
    одно умножение на обращённую граммиану и невязка — это и даёт основной
    выигрыш быстрого режима (замер — в докстринге модуля).
    """

    grid_m: np.ndarray  # (q, 3), метры
    gain_centered: np.ndarray  # (i, q, 3) — поле, центрированное по каналам
    gram_inv: np.ndarray  # (q, 3, 3) — (GᵀG + ridge)⁻¹ по узлам
    too_close: np.ndarray  # (q,) bool — узлы ближе min_distance к электроду


def _build_kernel(
    positions_m: np.ndarray, grid_m: np.ndarray, min_distance_m: float,
) -> _ScanKernel:
    """Собирает предрасчёт сетки для фиксированных позиций электродов."""
    gain, distance = _leadfield(positions_m, grid_m)
    gain_centered = gain - np.mean(gain, axis=0, keepdims=True)
    # Регуляризация: без неё узлы с почти линейно зависимыми столбцами дают
    # вырожденную GᵀG и обращение падает на вырожденной матрице.
    gram = np.einsum("iqj,iqk->qjk", gain_centered, gain_centered)
    ridge = 1e-9 * np.maximum(np.trace(gram, axis1=1, axis2=2) / 3.0, 1e-30)
    gram = gram + ridge[:, None, None] * np.eye(3)
    gram_inv = np.linalg.inv(gram)
    # Диполь вплотную к электроду физически бессмыслен — исключаем узлы
    too_close = np.any(distance <= min_distance_m, axis=0)
    return _ScanKernel(
        grid_m=grid_m,
        gain_centered=gain_centered,
        gram_inv=gram_inv,
        too_close=too_close,
    )


@lru_cache(maxsize=4)
def _scan_kernel(
    positions_key: bytes,
    positions_shape: tuple[int, ...],
    grid_step_mm: float,
    min_distance_m: float,
) -> _ScanKernel:
    """Кэш ядра перебора: ключ — байты позиций электродов и шаг сетки.

    maxsize=4: при шаге 2 мм (~180 тыс. узлов) ядро занимает ~90 МБ, большее
    число записей в кэше неоправданно раздувает память процесса.
    """
    positions_m = np.frombuffer(positions_key, dtype=float).reshape(positions_shape)
    return _build_kernel(positions_m, candidate_grid(grid_step_mm), min_distance_m)


def _fit_best_node(
    kernel: _ScanKernel, signal: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, float, float]:
    """Линейный МНК по всем узлам для одного (уже центрированного) отсчёта.

    Общее ядро `scan_point` и `scan_point_fast`: Gᵀd, момент через
    предрасчитанную обращённую граммиану, невязка, выбор лучшего узла.
    """
    total = float(np.sum(signal ** 2))
    moment = np.einsum(
        "qjk,qk->qj", kernel.gram_inv,
        np.einsum("iqj,i->qj", kernel.gain_centered, signal),
    )
    predicted = np.einsum("iqj,qj->qi", kernel.gain_centered, moment)
    residual = np.sum((predicted - signal[None, :]) ** 2, axis=1)

    gof = 1.0 - residual / total if total > 0 else np.zeros_like(residual)
    amplitude = np.linalg.norm(moment, axis=1)
    valid = ~kernel.too_close & np.isfinite(gof) & (amplitude > 0)
    if not np.any(valid):
        raise DipoleScanError(
            "Все узлы сетки отсеяны ограничениями (близость к электродам)"
        )
    gof = np.where(valid, gof, -np.inf)
    best = int(np.argmax(gof))
    direction = moment[best]
    norm = float(np.linalg.norm(direction))
    if norm == 0:
        raise DipoleScanError("Сигнал в пике GFP вырожден: момент нулевой")
    return kernel.grid_m[best], direction / norm, norm, float(gof[best])


def scan_point_fast(
    kernel: _ScanKernel, data_v: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, float, float]:
    """То же, что `scan_point`, но с предрасчитанным ядром сетки (N20).

    Используется в цикле по эпохам: ядро строится один раз на запись через
    `_scan_kernel`, а здесь остаётся только центрирование вектора сигнала
    (average reference) и сам МНК.
    """
    signal = np.asarray(data_v, dtype=float)
    if signal.size != kernel.gain_centered.shape[0]:
        raise DipoleScanError(
            f"Каналов в данных {signal.size}, а в ядре {kernel.gain_centered.shape[0]}"
        )
    return _fit_best_node(kernel, signal - float(np.mean(signal)))


def scan_point(
    positions_m: np.ndarray,
    data_v: np.ndarray,
    grid_m: np.ndarray,
    min_distance_m: float = MIN_SENSOR_DISTANCE_MM / 1000.0,
) -> tuple[np.ndarray, np.ndarray, float, float]:
    """Локализует один отсчёт: перебор узлов сетки + линейный МНК по моменту.

    Одноразовый вход (ядро строится на каждый вызов) — для тестов и
    одиночных точек; цикл по эпохам должен идти через `scan_point_fast`.
    Возвращает позицию лучшего узла (м), единичное направление момента,
    амплитуду (А·м) и GOF лучшего узла.
    """
    signal = np.asarray(data_v, dtype=float)
    if signal.size != positions_m.shape[0]:
        raise DipoleScanError(
            f"Каналов в данных {signal.size}, а позиций {positions_m.shape[0]}"
        )
    signal = signal - float(np.mean(signal))
    return _fit_best_node(
        _build_kernel(positions_m, grid_m, min_distance_m), signal,
    )


@lru_cache(maxsize=1)
def _mri_head_transform(trans_path: str) -> Any | None:
    """Transform mri↔head из файла fsaverage (None — данных нет).

    Возвращается именно ``mne.Transform``: `head_to_mni` не принимает путь
    (правило безопасности из `AGENTS.md`).
    """
    try:
        return mne.read_trans(trans_path, verbose=False)
    except (FileNotFoundError, OSError, ValueError) as exc:
        logger.warning("Transform fsaverage недоступен (%s): %s", trans_path, exc)
        return None


def _localize_point(position_m: np.ndarray, cfg: Settings) -> list[float] | None:
    """MNI-координаты позиции; ``None`` — fsaverage недоступен.

    Ошибка локализации не отменяет расчёт: раздел покажет точку в системе
    головы и честное предупреждение вместо выдуманных координат MNI.
    """
    transform = _mri_head_transform(str(cfg.fsaverage_trans))
    if transform is None:
        return None
    try:
        mni = mne.head_to_mni(
            position_m.reshape(1, 3),
            subject="fsaverage",
            mri_head_t=transform,
            subjects_dir=str(cfg.subjects_dir),
            verbose=False,
        )[0]
    except Exception as exc:
        logger.warning("MNI недоступно для точки %s: %s", position_m, exc)
        return None
    return [float(value) for value in mni]


def _prepare_epochs(recording: Recording, cfg: Settings, params: DipoleScanParams) -> Any:
    """Читает запись и нарезает эпохи для расчёта (reject-порог из параметров).

    Сигнал — из кэша подготовленного сигнала (A4): повторный запуск с теми же
    параметрами фильтра и нарезки не читает EDF заново.
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
            pipeline="dipoles",
        )
    except ValueError as exc:
        raise DipoleScanError(str(exc)) from exc

    try:
        with journal.step(
            "dipoles", "segment_epochs",
            note=f"epoch={params.epoch_length_ms:g}ms",
        ) as entry:
            epochs = segment_epochs(
                raw,
                mne.Annotations([], [], []),
                epoch_length_ms=params.epoch_length_ms,
            )
            entry.epochs = len(epochs.drop_log)
    except ValueError as exc:
        raise DipoleScanError(str(exc)) from exc
    return raw, epochs


def _electrode_matrix(
    channels: Sequence[str], positions: dict[str, np.ndarray],
) -> tuple[list[str], np.ndarray, list[int]]:
    """Каналы с позициями, их координаты (м) и индексы в исходном порядке.

    Позиции электродов нужны для свинцового поля: канал без позиции в монтаже
    в модель не входит, и в расчёт берётся подмножество каналов.
    """
    used = [name for name in channels if name in positions]
    if len(used) < 4:
        raise DipoleScanError(
            f"Для расчёта нужно минимум 4 канала с позициями в монтаже 10-20 "
            f"(найдено {len(used)})"
        )
    index = {name: position for position, name in enumerate(channels)}
    matrix = np.stack([positions[name] for name in used])
    return used, matrix, [index[name] for name in used]


def compute_dipole_scan(
    recording: Recording,
    cfg: Settings,
    params: DipoleScanParams,
    progress: Any = None,
) -> dict[str, Any]:
    """Быстрый расчёт диполей по эпохам: одна точка на эпоху (пик GFP).

    Возвращает dict под схему ``DipoleScanResult`` (её валидирует API). Прогресс
    сообщается по эпохам (``epochs_done``/``epochs_total``) — расчёт эпох
    составляет основное время, и «12 из 30» информативнее дробного прогресса.
    """
    report = progress or (lambda *args, **kwargs: None)
    started = time.perf_counter()
    report("load_edf", message="Чтение EDF, монтаж 10-20")

    raw, epochs = _prepare_epochs(recording, cfg, params)
    channels = list(epochs.ch_names)
    positions = channel_positions(channels)
    used_channels, positions_m, used_index = _electrode_matrix(channels, positions)

    report(
        "epochs",
        message=f"Нарезка эпох по {params.epoch_length_ms:.0f} мс",
        epochs_done=0,
        epochs_total=len(epochs.drop_log),
    )
    data = epochs.get_data()[:, used_index, :]  # (n_epochs, n_ch, n_times), В
    n_epochs = data.shape[0]
    grid_m = candidate_grid(params.grid_mm)

    warnings: list[str] = []
    dropped = len(epochs.drop_log) - n_epochs
    if dropped:
        warnings.append(
            f"Отброшено эпох аннотациями BAD_: {dropped} из {len(epochs.drop_log)}"
        )
    if len(used_channels) < len(channels):
        missing = [name for name in channels if name not in positions]
        warnings.append(
            "Каналы без позиции в монтаже не участвовали в модели: " + ", ".join(missing)
        )

    # GFP: пик суммарной амплитуды эпохи — самый «дипольный» отсчёт
    gfp = np.sqrt(np.mean(data ** 2, axis=1))  # (n_epochs, n_times)
    peak_index = np.argmax(gfp, axis=1)
    times = np.asarray(epochs.times, dtype=float)

    points: list[dict[str, Any]] = []
    mni_available = True
    # Меряем цикл двумя строками журнала: перебор сетки и локализация (head_to_mni
    # + структура атласа) — самая дорогая часть по замерам аудита (0.25–0.36 с на
    # точку). Строку на эпоху журнал не получает: это сотни строк на запись.
    scan_started = time.perf_counter()
    # N20: свинцовое поле и (GᵀG)⁻¹ не зависят от эпохи — ядро сетки
    # строится один раз на запись (и кэшируется между задачами с тем же
    # монтажом и шагом), в цикле остаётся только МНК по готовым матрицам.
    kernel = _scan_kernel(
        np.ascontiguousarray(positions_m, dtype=float).tobytes(),
        positions_m.shape,
        params.grid_mm,
        MIN_SENSOR_DISTANCE_MM / 1000.0,
    )
    localize_ms = 0.0
    for epoch_index in range(n_epochs):
        sample = peak_index[epoch_index]
        try:
            position_m, moment, amplitude_am, gof = scan_point_fast(
                kernel, data[epoch_index, :, sample],
            )
        except DipoleScanError as exc:
            warnings.append(f"Эпоха {epoch_index + 1}: {exc}")
            continue

        locate_started = time.perf_counter()
        mni_coords = _localize_point(position_m, cfg)
        # Атрибуция читается здесь же (шаг 1.4): первое обращение собирает объёмы
        # (≈1 с на test.edf — видно строкой `asset-contours`), и это время
        # принадлежит локализации, а не перебору сетки.
        attribution = attribution_fields(cfg, mni_coords)
        localize_ms += (time.perf_counter() - locate_started) * 1000.0
        if mni_coords is None:
            mni_available = False
        points.append({
            "epoch_index": epoch_index,
            "time_ms": float(times[sample] * 1000.0),
            "head_coords": [float(value * 1000.0) for value in position_m],
            "mni_coords": mni_coords,
            "moment": [float(value) for value in moment],
            "amplitude_nam": float(amplitude_am * 1e9),
            "gof": float(gof),
            **attribution,
        })
        report(
            "scan",
            message=f"Диполи: {epoch_index + 1} из {n_epochs}",
            epochs_done=epoch_index + 1,
            epochs_total=n_epochs,
        )

    if not mni_available:
        warnings.append(
            "MNI-координаты недоступны (нет transform fsaverage): точки показаны "
            "только в системе головы"
        )
    if not points:
        raise DipoleScanError("Ни одной эпохи не удалось локализовать")

    # Две агрегированные строки вместо строки на эпоху: сумма локализации
    # вычитается из общего времени цикла, поэтому «перебор сетки» — остаток.
    scan_ms = (time.perf_counter() - scan_started) * 1000.0
    journal.record(
        "dipoles", "grid_scan",
        ms=scan_ms - localize_ms,
        note=(
            f"grid={params.grid_mm:g}mm, nodes={int(grid_m.shape[0])}, "
            f"points={len(points)}, без локализации"
        ),
        epochs=n_epochs,
    )
    journal.record(
        "dipoles", "head_to_mni",
        ms=localize_ms,
        note="сумма по точкам: head_to_mni + атрибуция атласа",
        epochs=len(points),
    )

    report(
        "done", 1.0,
        message=f"Диполей: {len(points)} (быстрый режим, сетка {params.grid_mm:g} мм)",
        epochs_done=n_epochs,
        epochs_total=n_epochs,
    )
    return {
        "recording_id": recording.recording_id,
        "method": "fast_grid",
        "brodmann_method": BRODMANN_METHOD,
        "reference": params.reference,
        "reference_channels": (
            list(params.reference_channels) if params.reference_channels else None
        ),
        "channels": used_channels,
        "sfreq": float(raw.info["sfreq"]),
        "epoch_length_ms": params.epoch_length_ms,
        "filter_band_hz": list(params.filter_band) if params.filter_band else None,
        "notch_hz": params.notch_hz,
        "n_epochs_total": len(epochs.drop_log),
        "n_epochs_used": n_epochs,
        "grid_mm": params.grid_mm,
        "points": points,
        "warnings": warnings,
        "duration_sec_calc": round(time.perf_counter() - started, 3),
    }

@dataclass
class DipoleRefineParams:
    """Параметры точного уточнения: параметры быстрого расчёта, эпоха и окно.

    Сканирование передаётся целиком, а не «текущими настройками формы»: номер
    эпохи привязан к нарезке результата, и уточнение обязано повторить её
    точь-в-точь (та же полоса, длина эпохи, reject), иначе «эпоха 12» оказалась
    бы другим куском записи.

    ``halfwin_ms`` — половина окна **свободного** фитинга вокруг пика GFP;
    ``0`` (дефолт конфига) — фитится только пик, то есть тот отсчёт, который уже
    выбрал быстрый расчёт. Каждый следующий отсчёт окна стоит ≈7 с (замер
    20.09.2026, `docs/rules/dipoles.md`), поэтому окно приходит из формы и
    расширяется пользователем осознанно.
    """

    scan: DipoleScanParams
    epoch_index: int
    halfwin_ms: float = 0.0


def _refine_point_payload(
    cfg: Settings,
    epoch_index: int,
    position_m: np.ndarray,
    moment: np.ndarray,
    amplitude_am: float,
    gof: float,
    time_ms: float,
) -> dict[str, Any]:
    """Точка уточнения в схеме быстрого расчёта (``DipoleScanPointOut``).

    Локализация — те же функции, что у быстрого расчёта (`_localize_point`,
    `attribution_fields`), поэтому структура и поле Бродмана в «было/стало»
    читаются одним атласом, а не вторым, «своим».
    """
    mni_coords = _localize_point(position_m, cfg)
    return {
        "epoch_index": epoch_index,
        "time_ms": time_ms,
        "head_coords": [float(value * 1000.0) for value in position_m],
        "mni_coords": mni_coords,
        "moment": [float(value) for value in moment],
        "amplitude_nam": float(amplitude_am * 1e9),
        "gof": gof,
        **attribution_fields(cfg, mni_coords),
    }


def refine_dipole_point(
    recording: Recording,
    cfg: Settings,
    params: DipoleRefineParams,
    progress: Any = None,
) -> dict[str, Any]:
    """Точное уточнение одной точки быстрого расчёта (F19/N22): BEM-фитинг эпохи.

    MNE 1.13 не принимает стартовую точку оптимизации (`pos` у `fit_dipole` —
    это **фиксированная** позиция), поэтому «сетка как старт» устроена иначе:

    1. узел сетки оценивается на BEM-модели с фиксированной позицией (линейный
       момент) — по замеру 20.09.2026 ≈0.5 с. Это **первый** шаг: пользователь
       видит «было/стало» по честной модели сразу, и сбой этого вызова больше не
       уносит всю задачу;
    2. свободный последовательный фитинг идёт по окну вокруг пика GFP
       (``params.halfwin_ms``; ≈8 с постоянной цены + ≈7 с на отсчёт окна).

    Сбой свободного фита не отменяет уточнение: в ответе остаётся оценка узла на
    BEM, а причина уходит в ``warnings`` («стало» не выдумывается).
    """
    scan = params.scan
    report = progress or (lambda *args, **kwargs: None)
    started = time.perf_counter()
    report("load_edf", message="Чтение EDF, монтаж 10-20")

    # Та же подготовка, что и в быстром расчёте (общий `_prepare_epochs`):
    # кэш подготовленного сигнала и нарезка совпадают по построению.
    raw, epochs = _prepare_epochs(recording, cfg, scan)
    n_epochs = len(epochs)
    if n_epochs == 0:
        raise DipoleScanError("После reject-фильтра не осталось эпох — нечего уточнять")
    if not 0 <= params.epoch_index < n_epochs:
        raise DipoleScanError(
            f"Эпохи №{params.epoch_index + 1} нет: в нарезке быстрого расчёта их {n_epochs}. "
            "Уточнение привязано к той нарезке — если параметры менялись, пересчитайте диполи"
        )
    # Тот же порядок выборки, что в compute_dipole_scan: сначала матрица
    # электродов (каналы с позициями), потом данные по ним — иначе индекс
    # эпохи/канала разъедется с быстрым расчётом.
    positions = channel_positions(raw.ch_names)
    used_channels, positions_m, used_index = _electrode_matrix(raw.ch_names, positions)
    data = epochs.get_data()[:, used_index, :]  # (n_epochs, n_ch, n_times), В
    times = epochs.times
    gfp = np.sqrt(np.mean(data ** 2, axis=1))  # (n_epochs, n_times)
    sample = int(np.argmax(gfp[params.epoch_index]))
    kernel = _scan_kernel(
        np.ascontiguousarray(positions_m, dtype=float).tobytes(),
        positions_m.shape, scan.grid_mm, MIN_SENSOR_DISTANCE_MM / 1000.0,
    )
    fast_pos_m, _fast_dir, _fast_amp, fast_gof = scan_point_fast(
        kernel, data[params.epoch_index, :, sample],
    )

    report("refine", 0.3, message=f"Точный фитинг эпохи {params.epoch_index + 1} (BEM)")
    try:
        bem = _get_bem(cfg)
    except (FileNotFoundError, OSError) as exc:
        raise DipoleScanError(
            "Точное уточнение недоступно: не найдено BEM-решение fsaverage "
            f"({exc}). Быстрый результат остаётся в таблице"
        ) from exc
    cov = _get_covariance(cfg)
    if cov is None:
        cov = mne.compute_covariance(epochs, method="empirical", verbose=False)

    # Окно вокруг пика GFP: половина берётся из формы (0 — только пик, то есть
    # тот отсчёт, по которому уже посчитан быстрый результат). Полная эпоха при
    # ≈7 с на отсчёт считалась бы минутами, а лишние отсчёты не добавляют
    # точности позиции — они добавляют траекторию (замер — `docs/rules/dipoles.md`).
    sfreq = float(raw.info["sfreq"])
    half = max(0, round(params.halfwin_ms / 1000.0 * sfreq))
    lo = max(0, sample - half)
    hi = min(data.shape[2], sample + half + 1)
    sel = [raw.ch_names.index(name) for name in used_channels]
    info = mne.pick_info(raw.info, sel)
    evoked = mne.EvokedArray(
        data[params.epoch_index][:, lo:hi], info,
        tmin=float(times[lo]), nave=1, verbose=False,
    )
    n_jobs = int(cfg.dipole_refine_n_jobs or -1)

    warnings: list[str] = []

    # 1) Дешёвый шаг: оценка узла сетки на BEM (фиксированная позиция, линейный
    # момент) — ≈0.5 с по замеру 20.09.2026. Идёт **первым**: «было/стало» по
    # честной модели видно сразу, а его сбой (узел сетки вне внутренней границы
    # черепа — сетка строится без учёта BEM) больше не уносит всю задачу.
    grid_gof_bem: float | None = None
    grid_point: dict[str, Any] | None = None
    with journal.step(
        "dipoles", "refine_fixed", epochs=1,
        note=f"epoch={params.epoch_index + 1}, узел сетки на BEM",
    ):
        try:
            out_fixed = mne.fit_dipole(
                evoked, cov, bem, trans=cfg.fsaverage_trans, pos=fast_pos_m,
                min_dist=MIN_SENSOR_DISTANCE_MM, n_jobs=n_jobs, verbose=False,
            )
            dip_fixed = out_fixed[0] if isinstance(out_fixed, tuple) else out_fixed
            if len(dip_fixed.pos) == 0:
                raise DipoleScanError("fit_dipole с фиксированной позицией не дал точек")
            # Пик GFP — средний отсчёт окна; индекс зажимается: у фиксированной
            # позиции MNE может вернуть меньше отсчётов, чем в evoked.
            fixed_index = min(sample - lo, len(dip_fixed.gof) - 1)
            # MNE отдаёт Dipole.gof в процентах (dipole.py: * 100) — нормализуем
            # на границе сервиса: контракт проекта везде — доля 0..1.
            grid_gof_bem = float(dip_fixed.gof[fixed_index]) / 100.0
            grid_point = _refine_point_payload(
                cfg, params.epoch_index, fast_pos_m, dip_fixed.ori[fixed_index],
                float(dip_fixed.amplitude[fixed_index]), grid_gof_bem,
                float(dip_fixed.times[fixed_index] * 1000.0),
            )
        except Exception as exc:  # метрика сравнения опциональна
            warnings.append(f"Оценка узла сетки на BEM не посчитана: {exc}")

    report("refine", 0.6, message="Свободный фитинг окна (BEM)")
    # 2) Свободный фит окна: основная цена шага (≈8 с постоянной цены + ≈7 с на
    # отсчёт). Второй отсчёт окна и дальше — только то, что выбрал пользователь.
    free_point: dict[str, Any] | None = None
    shift_mm = 0.0
    free_error: str | None = None
    with journal.step(
        "dipoles", "refine_fit", epochs=1,
        note=(
            f"epoch={params.epoch_index + 1}, окно ±{params.halfwin_ms:g} мс, "
            f"отсчётов {hi - lo}"
        ),
    ):
        try:
            out = mne.fit_dipole(
                evoked, cov, bem, trans=cfg.fsaverage_trans,
                min_dist=MIN_SENSOR_DISTANCE_MM, n_jobs=n_jobs, verbose=False,
            )
            dip = out[0] if isinstance(out, tuple) else out
            if len(dip.pos) == 0:
                raise DipoleScanError("fit_dipole не дал ни одной точки в окне пика GFP")
            best = int(np.argmax(dip.gof))
            refined_pos_m = np.asarray(dip.pos[best], dtype=float)
            free_point = _refine_point_payload(
                cfg, params.epoch_index, refined_pos_m, dip.ori[best],
                float(dip.amplitude[best]),
                float(dip.gof[best]) / 100.0,  # MNE отдаёт проценты — см. выше
                float(dip.times[best] * 1000.0),
            )
            shift_mm = float(np.linalg.norm(refined_pos_m - fast_pos_m) * 1000.0)
        except Exception as exc:
            free_error = str(exc)

    if free_point is None:
        if grid_point is None:
            # Ни свободного фита, ни оценки узла: «стало» нет вовсе — это ошибка,
            # а не «пустой результат»
            raise DipoleScanError(
                f"Точный фитинг не выполнен: {free_error or 'fit_dipole не дал точек'}"
            )
        warnings.append(
            "Свободный фит окна не выполнен "
            f"({free_error or 'fit_dipole не дал точек'}); показана оценка узла сетки на BEM"
        )
        point = grid_point
    else:
        point = free_point

    report("done", 1.0, message=f"Эпоха {params.epoch_index + 1} уточнена (BEM)")
    return {
        "recording_id": recording.recording_id,
        "method": "bem_fit",
        "epoch_index": params.epoch_index,
        "time_ms": float(times[sample] * 1000.0),
        "window_ms": [float(times[lo] * 1000.0), float(times[hi - 1] * 1000.0)],
        "halfwin_ms": float(params.halfwin_ms),
        "fast_head_coords": [float(value * 1000.0) for value in fast_pos_m],
        "fast_gof": float(fast_gof),
        "grid_gof_bem": grid_gof_bem,
        "shift_mm": shift_mm,
        "free_fit": free_point is not None,
        "point": point,
        "warnings": warnings,
        "duration_sec_calc": round(time.perf_counter() - started, 3),
    }
