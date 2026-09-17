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
Свинцовое поле `G` (канал × узел × 3) считается один раз на сетку и каналы и
кэшируется (`lru_cache`), а по узлам всё считается массивами: `GᵀG`, `Gᵀd`,
`m = (GᵀG)⁻¹Gᵀd`, невязка. При 18 каналах и ~4200 узлах (шаг 7 мм) это ~8 мс на
эпоху — цикл по узлам был бы в сотни раз дольше. Замер на живой записи
(`data/edf/test.edf`: 130.7 с, 500 Гц, 18 каналов, нарезка 500 мс → 261 эпоха):
шаг 7 мм — 2.2 с, 4 мм — 11.8 с, 2 мм (~180 тыс. узлов) — 99.8 с.

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
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Dict, List, Optional, Sequence, Tuple

import mne
import numpy as np

from app.core.config import Settings
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
GRID_CENTER_MM: Tuple[float, float, float] = (0.0, 0.0, 40.0)
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

    filter_band: Optional[Tuple[float, float]] = None
    notch_hz: Optional[float] = None
    epoch_length_ms: float = 1000.0
    reject_threshold_uv: float = 150.0
    reference: str = "average"
    reference_channels: Optional[List[str]] = None
    grid_mm: float = GRID_STEP_MM


@lru_cache(maxsize=8)
def candidate_grid(
    step_mm: float = GRID_STEP_MM,
    center_mm: Tuple[float, float, float] = GRID_CENTER_MM,
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
) -> Tuple[np.ndarray, np.ndarray]:
    """Свинцовое поле точечного диполя: ``G`` (канал × узел × 3) и расстояния.

    Φ_i = (m · (r_i − r_q)) / (4πσ |r_i − r_q|³). Домножение на 1/(4πσ) делает
    момент физическим (А·м), а не произвольным масштабом: амплитуда из ответа
    сравнима с результатом `mne.fit_dipole`.
    """
    diff = positions_m[:, None, :] - grid_m[None, :, :]  # (n_ch, n_grid, 3)
    distance = np.linalg.norm(diff, axis=2)              # (n_ch, n_grid)
    gain = 1.0 / (_FOUR_PI * HEAD_CONDUCTIVITY_S_M * np.maximum(distance, 1e-9) ** 3)
    return diff * gain[:, :, None], distance


def scan_point(
    positions_m: np.ndarray,
    data_v: np.ndarray,
    grid_m: np.ndarray,
    min_distance_m: float = MIN_SENSOR_DISTANCE_MM / 1000.0,
) -> Tuple[np.ndarray, np.ndarray, float, float]:
    """Лучший диполь одного отсчёта: ``(позиция, единичный момент, |m|, GOF)``.

    Считает свинцовое поле, центрирует его по каналам (average reference),
    решает МНК по моменту в каждом узле и возвращает узел с максимальным GOF.
    Точки рядом с электродами (< ``min_distance_m``) исключаются.
    """
    if grid_m.size == 0:
        raise DipoleScanError("Пустая сетка поиска")
    signal = np.asarray(data_v, dtype=float)
    if signal.size != positions_m.shape[0]:
        raise DipoleScanError(
            f"Каналов в данных {signal.size}, а позиций {positions_m.shape[0]}"
        )
    signal = signal - float(np.mean(signal))
    total = float(np.sum(signal ** 2))

    gain, distance = _leadfield(positions_m, grid_m)
    gain = gain - np.mean(gain, axis=0, keepdims=True)
    # Регуляризация: без неё узлы с почти линейно зависимыми столбцами дают
    # вырожденную GᵀG и `solve` падает на вырожденной матрице.
    gram = np.einsum("iqj,iqk->qjk", gain, gain)
    ridge = 1e-9 * np.maximum(np.trace(gram, axis1=1, axis2=2) / 3.0, 1e-30)
    gram = gram + ridge[:, None, None] * np.eye(3)
    moment = np.linalg.solve(
        gram, np.einsum("iqj,i->qj", gain, signal)[..., None],
    )[..., 0]
    predicted = np.einsum("iqj,qj->qi", gain, moment)
    residual = np.sum((predicted - signal[None, :]) ** 2, axis=1)

    gof = 1.0 - residual / total if total > 0 else np.zeros_like(residual)
    amplitude = np.linalg.norm(moment, axis=1)
    # Диполь вплотную к электроду физически бессмыслен — исключаем узлы
    valid = np.all(distance > min_distance_m, axis=0) & np.isfinite(gof) & (amplitude > 0)
    if not np.any(valid):
        raise DipoleScanError("Ни один узел сетки не подошёл под ограничения")
    gof = np.where(valid, gof, -np.inf)
    best = int(np.argmax(gof))

    direction = moment[best]
    norm = float(np.linalg.norm(direction))
    unit = direction / norm if norm > 0 else np.zeros(3)
    return grid_m[best], unit, norm, float(gof[best])


@lru_cache(maxsize=1)
def _mri_head_transform(trans_path: str) -> Optional[Any]:
    """Transform mri↔head из файла fsaverage (None — данных нет).

    Возвращается именно ``mne.Transform``: `head_to_mni` не принимает путь
    (правило безопасности из `AGENTS.md`).
    """
    try:
        return mne.read_trans(trans_path, verbose=False)
    except (FileNotFoundError, OSError, ValueError) as exc:
        logger.warning("Transform fsaverage недоступен (%s): %s", trans_path, exc)
        return None


def _localize_point(
    position_m: np.ndarray, cfg: Settings,
) -> Tuple[Optional[List[float]], Optional[str]]:
    """MNI-координаты и поле Бродмана позиции; ``(None, None)`` — fsaverage нет.

    Ошибка локализации не отменяет расчёт: раздел покажет точку в системе
    головы и честное предупреждение вместо выдуманных координат MNI.
    """
    transform = _mri_head_transform(str(cfg.fsaverage_trans))
    if transform is None:
        return None, None
    try:
        mni = mne.head_to_mni(
            position_m.reshape(1, 3),
            subject="fsaverage",
            mri_head_t=transform,
            subjects_dir=str(cfg.subjects_dir),
            verbose=False,
        )[0]
    except Exception as exc:  # noqa: BLE001 — локализация не обязательна
        logger.warning("MNI недоступно для точки %s: %s", position_m, exc)
        return None, None

    area: Optional[str] = None
    try:
        from app.services.dipole_fitter import _find_ba, _get_ba_centers

        area = _find_ba(mni, _get_ba_centers(str(cfg.subjects_dir)))
    except Exception as exc:  # noqa: BLE001 — атлас может отсутствовать
        logger.info("Поле Бродмана не определено: %s", exc)
    return [float(value) for value in mni], area


def _structure_of(cfg: Settings, mni_coords: Optional[List[float]]) -> Optional[str]:
    """Анатомическая структура по MNI-координате точки (``aparc+aseg``).

    Берётся тем же атласом, что и контуры срезов (`services/atlas_contours.py`),
    поэтому подпись структуры в таблице локализации совпадает с подписью
    структуры под курсором на проекциях: это одна метка объёма, прочитанная в
    двух местах, а не две разные «догадки» об анатомии.

    ``None`` — координат нет, метки в узле нет или атлас недоступен. Отсутствие
    анатомии **не отменяет** расчёт: в таблице будет «—», как у точки без MNI.
    """
    if mni_coords is None:
        return None
    try:
        from app.services.atlas_contours import structure_at

        return structure_at(cfg, mni_coords)
    except Exception as exc:  # noqa: BLE001 — атлас не обязателен для расчёта
        logger.info("Структура по MNI не определена: %s", exc)
        return None


def _prepare_epochs(recording: Recording, cfg: Settings, params: DipoleScanParams) -> Any:
    """Читает запись и нарезает эпохи для расчёта (reject-порог из параметров).

    Сигнал — из кэша подготовленного сигнала (A4): повторный запуск с теми же
    параметрами фильтра и нарезки не читает EDF заново.
    """
    l_freq: Optional[float] = None
    h_freq: Optional[float] = None
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
        )
    except ValueError as exc:
        raise DipoleScanError(str(exc)) from exc

    try:
        epochs = segment_epochs(
            raw,
            mne.Annotations([], [], []),
            epoch_length_ms=params.epoch_length_ms,
            reject_threshold_uv=params.reject_threshold_uv,
        )
    except ValueError as exc:
        raise DipoleScanError(str(exc)) from exc
    return raw, epochs


def _electrode_matrix(
    channels: Sequence[str], positions: Dict[str, np.ndarray],
) -> Tuple[List[str], np.ndarray, List[int]]:
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
) -> Dict[str, Any]:
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

    warnings: List[str] = []
    dropped = len(epochs.drop_log) - n_epochs
    if dropped:
        warnings.append(
            f"Отброшено эпох reject-фильтром: {dropped} из {len(epochs.drop_log)} "
            f"(порог {params.reject_threshold_uv:.0f} мкВ)"
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

    points: List[Dict[str, Any]] = []
    mni_available = True
    for epoch_index in range(n_epochs):
        sample = peak_index[epoch_index]
        try:
            position_m, moment, amplitude_am, gof = scan_point(
                positions_m, data[epoch_index, :, sample], grid_m,
            )
        except DipoleScanError as exc:
            warnings.append(f"Эпоха {epoch_index + 1}: {exc}")
            continue

        mni_coords, area = _localize_point(position_m, cfg)
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
            "brodmann_area": area,
            "anatomical_structure": _structure_of(cfg, mni_coords),
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

    report(
        "done", 1.0,
        message=f"Диполей: {len(points)} (быстрый режим, сетка {params.grid_mm:g} мм)",
        epochs_done=n_epochs,
        epochs_total=n_epochs,
    )
    return {
        "recording_id": recording.recording_id,
        "method": "fast_grid",
        "channels": used_channels,
        "sfreq": float(raw.info["sfreq"]),
        "epoch_length_ms": params.epoch_length_ms,
        "reject_threshold_uv": params.reject_threshold_uv,
        "filter_band_hz": list(params.filter_band) if params.filter_band else None,
        "notch_hz": params.notch_hz,
        "n_epochs_total": len(epochs.drop_log),
        "n_epochs_used": n_epochs,
        "grid_mm": params.grid_mm,
        "points": points,
        "warnings": warnings,
        "duration_sec_calc": round(time.perf_counter() - started, 3),
    }
