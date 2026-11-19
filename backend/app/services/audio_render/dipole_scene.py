"""Дипольная сцена «Монтажа»: траектории диполей → параметры локализации.

Срез 19.11.2026 (спецификация владельца, `docs/rules/neuromusic.md`
§«Дипольный рендер»): рендер «Монтажа» берёт **данные анимации движения
диполей для 7 полос** как источник локализации 7 входных аудио. Источник
данных — прогон пакета поддиапазонов (``kind=dipole_batch``): точки
«эпоха × полоса» с позицией MNI, единичным моментом ``moment`` и амплитудой
``amplitude_nam`` — ровно то, чем анимация «Диполей» двигает диполь по эпохам.

Семантика времени — как у анимации ``frontend/src/shared/lib/playback.ts``:

* кадр ``i`` стоит в момент ``t_i = epoch_index · epoch_length_ms / 1000``
  (эпохи нарезаются встык по всей записи, включая отброшенные BAD_ — у
  отброшенных точек просто нет, движение «растягивается» до следующей
  измеренной);
* между измеренными кадрами — линейная интерполяция позиции/силы и
  интерполяция **развёрнутого** угла момента θ (slerp момента по азимуту —
  та же траектория без скачков на ±π); до первой/после последней точки —
  крайние значения (hold).

Параметры на каждый отсчёт аудио (:func:`band_series`):

* ``theta`` — непрерывный азимут момента в горизонтальной плоскости
  ``atan2(m_y, m_x)`` (MNI: x — лево/право, y — перед/зад): определяет фазы
  L/R каналов (``φ_L/R = ±θ/2``, ``dipole_spatial``) и поворот восьмёрки на
  силуэте головы;
* ``x_mm``/``y_mm`` — позиция MNI (панорама по x, проекция «вид сверху»);
* ``depth`` — глубина «колодца» реверберации: уход диполя вниз по коронарному
  срезу (z MNI) к ``cfg.dipole_depth_z_bottom_mm`` → 1;
* ``strength`` — сила диполя (амплитуда, нормированная по пику своей полосы) —
  **только визуализация** (прозрачность заливки восьмёрки), в звук не идёт.

Модуль чистый (numpy + чтение job-файлов) — юнит-тесты
``tests/test_audio_dipole_scene.py``.
"""
import logging
from dataclasses import dataclass, field

import numpy as np

from app.core.config import Settings
from app.services import job_store
from app.services.recordings import Recording

logger = logging.getLogger(__name__)

# Источник траекторий: прогон пакета поддиапазонов (С1) — одна задача на
# набор полос, точки «эпоха × поддиапазон».
DIPOLE_JOB_KIND = "dipole_batch"


class DipoleSceneError(ValueError):
    """Дипольных данных для «Монтажа» нет или они непригодны (400 в API)."""


@dataclass(frozen=True)
class DipoleFrame:
    """Один измеренный кадр траектории полосы (эпоха прогона)."""

    epoch_index: int
    pos_mni: tuple[float, float, float]
    moment: tuple[float, float, float]
    amplitude_nam: float


@dataclass(frozen=True)
class BandTrajectory:
    """Траектория диполя одной полосы: измеренные кадры по возрастанию эпохи."""

    band: str
    frames: list[DipoleFrame] = field(default_factory=list)


@dataclass(frozen=True)
class DipoleScene:
    """Дипольная сцена рендера: траектории полос + сетка эпох прогона."""

    job_id: str | None
    epoch_length_ms: float
    bands: dict[str, BandTrajectory]
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class BandSeries:
    """Параметры локализации полосы на отсчётах аудио (длина ``n_samples``)."""

    theta: np.ndarray
    """Непрерывный азимут момента, рад (развёрнутый, без скачков ±π)."""
    x_mm: np.ndarray
    y_mm: np.ndarray
    depth: np.ndarray
    """Глубина «колодца» 0..1 (уход z вниз по коронарному срезу)."""
    strength: np.ndarray
    """Сила диполя 0..1 (нормировка амплитуды по пику своей полосы)."""


def _frame_of(point: dict) -> DipoleFrame | None:
    """Точка прогона → кадр; ``None`` — нет координат/эпохи (честный пропуск)."""
    epoch_index = point.get("epoch_index")
    mni = point.get("mni_coords") or point.get("head_coords")
    moment = point.get("moment")
    if epoch_index is None or not mni or len(mni) != 3 or not moment or len(moment) != 3:
        return None
    values = [float(mni[0]), float(mni[1]), float(mni[2])]
    direction = [float(moment[0]), float(moment[1]), float(moment[2])]
    if not all(np.isfinite(values)) or not all(np.isfinite(direction)):
        return None
    amplitude = point.get("amplitude_nam")
    return DipoleFrame(
        epoch_index=int(epoch_index),
        pos_mni=(values[0], values[1], values[2]),
        moment=(direction[0], direction[1], direction[2]),
        amplitude_nam=float(amplitude) if amplitude is not None else 0.0,
    )


def scene_from_result(result: dict, job_id: str | None) -> DipoleScene:
    """Дипольная сцена из результата ``dipole_batch`` (``DipoleBatchResult``)."""
    epoch_length_ms = float(result.get("epoch_length_ms") or 0.0)
    if epoch_length_ms <= 0.0:
        raise DipoleSceneError(
            "Прогон диполей без длины эпохи — данные анимации непригодны для рендера"
        )
    bands: dict[str, BandTrajectory] = {}
    warnings: list[str] = []
    for run in result.get("bands") or []:
        band_key = run.get("band_key")
        if not band_key:
            continue
        frames = sorted(
            (
                frame
                for point in (run.get("points") or [])
                if (frame := _frame_of(point)) is not None
            ),
            key=lambda frame: frame.epoch_index,
        )
        if not frames:
            warnings.append(f"Полоса {band_key}: в прогоне нет точек диполей")
            continue
        bands[str(band_key)] = BandTrajectory(band=str(band_key), frames=frames)
    return DipoleScene(
        job_id=job_id,
        epoch_length_ms=epoch_length_ms,
        bands=bands,
        warnings=warnings,
    )


def load_dipole_scene(
    cfg: Settings, recording: Recording, dipole_job_id: str | None = None,
) -> DipoleScene:
    """Дипольная сцена записи: прогон ``dipole_batch`` из job-файлов на диске.

    ``dipole_job_id`` — явный выбор прогона; без него берётся **последний**
    прогон пакета записи (``load_records`` отдаёт от старых к новым). Прогон
    обязан покрывать все полосы ``cfg.freq_bands`` (иначе рендеру «Монтажа»
    нечего локализовать). ``DipoleSceneError`` — прогон не найден/не покрывает
    полосы/результат не сохранён (400 в API).
    """
    records = job_store.load_records(
        cfg,
        predicate=lambda record: (
            record.get("kind") == DIPOLE_JOB_KIND
            and (record.get("meta") or {}).get("recording_id") == recording.recording_id
            and isinstance(record.get("result"), dict)
        ),
    )
    if dipole_job_id is not None:
        records = [record for record in records if record.get("job_id") == dipole_job_id]
        if not records:
            raise DipoleSceneError(
                f"Прогон диполей {dipole_job_id} для записи {recording.recording_id} "
                "не найден (нет завершённого пакета с сохранённым результатом)"
            )
    if not records:
        raise DipoleSceneError(
            "Нет данных анимации диполей: сначала выполните прогон пакета "
            "поддиапазонов («Диполи» → «Пакет поддиапазонов» по 7 полосам)"
        )
    record = records[-1]
    scene = scene_from_result(record["result"], str(record.get("job_id")))
    missing = [band for band in cfg.freq_bands if band not in scene.bands]
    if missing:
        raise DipoleSceneError(
            "Прогон диполей не покрывает полосы рендера: " + ", ".join(missing)
        )
    return scene


def _unwrap_theta(moments: list[tuple[float, float, float]]) -> list[float]:
    """Азимуты момента ``atan2(m_y, m_x)``, развёрнутые вдоль траектории."""
    theta = np.unwrap(np.array([float(np.arctan2(m[1], m[0])) for m in moments]))
    return [float(value) for value in theta]


def frame_times_of(scene: DipoleScene) -> dict[str, list[float]]:
    """Времена кадров каждой полосы, с (``t = epoch_index · L``)."""
    epoch_s = scene.epoch_length_ms / 1000.0
    return {
        band: [frame.epoch_index * epoch_s for frame in trajectory.frames]
        for band, trajectory in scene.bands.items()
    }


def band_series(
    trajectory: BandTrajectory, frame_times: list[float], n_samples: int, fs: float,
    cfg: Settings,
) -> BandSeries:
    """Параметры локализации полосы на отсчётах аудио.

    ``frame_times[i]`` — время кадра ``trajectory.frames[i]``, с (сетка эпох
    ``epoch_index · epoch_length_ms / 1000``, см. :func:`frame_times_of`).
    Позиция/сила/θ интерполируются линейно между измеренными кадрами (hold по
    краям — та же семантика, что у анимации playback.ts), глубина — из z.
    """
    frames = trajectory.frames
    if not frames:
        raise DipoleSceneError(f"Полоса {trajectory.band}: нет кадров дипольной сцены")
    if len(frame_times) != len(frames):
        raise DipoleSceneError(f"Полоса {trajectory.band}: сетка времён ≠ числу кадров")
    sample_times = np.arange(n_samples, dtype=np.float64) / float(fs)
    times = np.asarray(frame_times, dtype=np.float64)
    thetas = _unwrap_theta([frame.moment for frame in frames])
    amplitudes = [abs(frame.amplitude_nam) for frame in frames]
    peak = max(amplitudes, default=0.0)
    strengths = [value / peak if peak > 0 else 0.0 for value in amplitudes]
    x = np.interp(sample_times, times, [f.pos_mni[0] for f in frames])
    y = np.interp(sample_times, times, [f.pos_mni[1] for f in frames])
    z = np.interp(sample_times, times, [f.pos_mni[2] for f in frames])
    theta = np.interp(sample_times, times, thetas)
    strength = np.interp(sample_times, times, strengths)
    depth = np.clip(
        (cfg.dipole_depth_z_top_mm - z)
        / (cfg.dipole_depth_z_top_mm - cfg.dipole_depth_z_bottom_mm),
        0.0, 1.0,
    )
    return BandSeries(theta=theta, x_mm=x, y_mm=y, depth=depth, strength=strength)


def scene_payload(scene: DipoleScene, cfg: Settings) -> dict:
    """Блок ``extensions.dipoles`` sidecar: кадры сцены для UI (вид сверху).

    Кадры — измеренные точки траекторий (интерполяция в UI повторяет аудио):
    ``t`` (с), ``x``/``y``/``z`` (мм MNI), ``theta`` (рад, развёрнутый),
    ``strength`` (0..1). Статика — стереобаза полос и границы глубины.
    """
    times = frame_times_of(scene)
    bands_payload: dict[str, dict] = {}
    for band, trajectory in scene.bands.items():
        thetas = _unwrap_theta([frame.moment for frame in trajectory.frames])
        amplitudes = [abs(frame.amplitude_nam) for frame in trajectory.frames]
        peak = max(amplitudes, default=0.0)
        frames_payload = [
            {
                "t": round(times[band][index], 6),
                "x": round(frame.pos_mni[0], 2),
                "y": round(frame.pos_mni[1], 2),
                "z": round(frame.pos_mni[2], 2),
                "theta": round(thetas[index], 4),
                "strength": round(amplitudes[index] / peak if peak > 0 else 0.0, 4),
            }
            for index, frame in enumerate(trajectory.frames)
        ]
        bands_payload[band] = {
            "stereo_base": float(cfg.dipole_stereo_base.get(band, 0.0)),
            "frames": frames_payload,
        }
    return {
        "source_job_id": scene.job_id,
        "epoch_length_ms": scene.epoch_length_ms,
        "mni_half_x_mm": float(cfg.dipole_mni_half_x_mm),
        "depth_z_mm": {
            "top": float(cfg.dipole_depth_z_top_mm),
            "bottom": float(cfg.dipole_depth_z_bottom_mm),
        },
        "bands": bands_payload,
        "warnings": list(scene.warnings),
    }


def mean_positions(payload: dict) -> dict[str, tuple[float, float]]:
    """Средняя позиция ``(x, y)`` каждой полосы — геометрия 3D-bake/силуэта."""
    out: dict[str, tuple[float, float]] = {}
    for band, block in (payload.get("bands") or {}).items():
        frames = block.get("frames") or []
        if not frames:
            continue
        out[str(band)] = (
            float(np.mean([frame["x"] for frame in frames])),
            float(np.mean([frame["y"] for frame in frames])),
        )
    return out