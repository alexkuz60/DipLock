"""Оркестрация рендера «Нейромузыки»: in-memory статус, треки, мастер, sidecar.

Экспериментальная модель (ТЗ фазы 1 — без журнала/кэшей/БД): один активный
рендер в памяти процесса, ``render_id`` → статус (проценты по трекам) и
артефакты (WAV мастера/треков + sidecar). Состояния убираются по TTL; при
перезапуске сервера активный рендер честно теряется (клиент видит 404).

Память (лимит фазы 1): в процессе живут мастер (float64) + текущий стем
(+ нормированная копия) + накопленные WAV-байты треков — для записи ~2 минуты
это сотни МБ; на часовых записях нужен блочный рендер (будущее, вне ТЗ).
"""
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np

from app.core.config import Settings
from app.services.audio_render.core import FS_AUDIO, PITCH_STEPS, RESAMPLE_UP, band_stem
from app.services.audio_render.export import (
    build_sidecar,
    input_checksum,
    sidecar_bytes,
    wav_bytes,
)
from app.services.audio_render.input import AUDIO_NOTCH_HZ, prepare_packages
from app.services.audio_render.mix import (
    apply_peak_ceiling,
    bus_weights,
    normalize_track,
)
from app.services.recordings import Recording

logger = logging.getLogger(__name__)

# TTL состояния рендера: эксперимент не хранит историю — старое удаляется.
RENDER_TTL_SEC = 15 * 60


class RenderBusy(RuntimeError):
    """Уже идёт другой рендер (в фазе 1 — ровно один за раз)."""


class RenderNotFound(KeyError):
    """render_id неизвестен или истёк TTL."""


@dataclass
class RenderArtifacts:
    """Готовые артефакты одного рендера (в памяти процесса)."""

    master_wav: bytes
    tracks_wav: dict[str, bytes]
    sidecar: bytes
    bands: list[str]


@dataclass
class RenderState:
    """Статус рендера для поллинга клиента (пct 0..1 + шаг пайплайна)."""

    render_id: str
    status: Literal["running", "succeeded", "failed"] = "running"
    stage: str = "Запуск"
    pct: float = 0.0
    message: str = ""
    error: str | None = None
    artifacts: RenderArtifacts | None = None
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None


_LOCK = threading.Lock()
_RENDERS: dict[str, RenderState] = {}


def _sweep_locked(now: float) -> None:
    """Убирает истёкшие состояния (вызывается под ``_LOCK``)."""
    expired = [
        render_id
        for render_id, state in _RENDERS.items()
        if state.status != "running" and now - (state.finished_at or state.started_at) > RENDER_TTL_SEC
    ]
    for render_id in expired:
        _RENDERS.pop(render_id, None)


def start_render(
    recording: Recording, cfg: Settings, gains_db: dict[str, float],
) -> str:
    """Запускает рендер в фоновом потоке; возвращает ``render_id``.

    Один активный рендер за раз (``RenderBusy`` → 409 в API): FIFO-очередь
    задач тут намеренно не вводится — это эксперимент, а не job-система.
    """
    with _LOCK:
        _sweep_locked(time.time())
        if any(state.status == "running" for state in _RENDERS.values()):
            raise RenderBusy("Рендер уже идёт — дождитесь его завершения")
        render_id = uuid.uuid4().hex[:16]
        state = RenderState(render_id=render_id)
        _RENDERS[render_id] = state
    thread = threading.Thread(
        target=_run_render,
        args=(state, recording, cfg, dict(gains_db)),
        name=f"audio-render-{render_id}",
        daemon=True,
    )
    thread.start()
    return render_id


def state_of(render_id: str) -> RenderState:
    """Состояние рендера; ``RenderNotFound`` — неизвестен/истёк/после рестарта."""
    with _LOCK:
        _sweep_locked(time.time())
        state = _RENDERS.get(render_id)
    if state is None:
        raise RenderNotFound(render_id)
    return state


def _run_render(
    state: RenderState, recording: Recording, cfg: Settings, gains_db: dict[str, float],
) -> None:
    """Цикл рендера: подготовка → ядро по полосам → мастер → экспорт.

    Прогресс: подготовка 0..0.3 (``prepare_packages``), семь треков 0.3..0.9,
    сведение/экспорт 0.9..1.0 — клиент рисует единый прогресс-бар (ТЗ M5).
    """
    started = time.perf_counter()
    try:

        def _stage(message: str, pct: float) -> None:
            state.stage = message
            state.pct = float(pct)

        packages = prepare_packages(recording, cfg, on_stage=_stage)
        # Отпечаток входа — до освобождения пакетов (в sidecar и для детерминизма).
        checksum = input_checksum(packages.packages)
        # Группы L/C/R нужны для sidecar-«партитуры»: веса несут ту же
        # информацию, но явная раскладка электродов читается человеком.
        w_left, w_right, groups = bus_weights(packages.channels)

        bands = list(cfg.freq_bands)
        n_bands = max(1, len(bands))
        n_out = packages.n_times * RESAMPLE_UP
        master = np.zeros((n_out, 2), dtype=np.float64)
        tracks_wav: dict[str, bytes] = {}
        band_rows: list[dict[str, Any]] = []

        for index, band in enumerate(bands):
            state.stage = f"Трек {band} ({index + 1}/{n_bands})"
            state.pct = 0.3 + 0.6 * index / n_bands
            state.message = f"Ядро ×128: hilbert → ресемпл ×96 → 7 октав ({band})"
            eeg_band = packages.packages.pop(band)
            stem = band_stem(eeg_band, w_left, w_right)
            del eeg_band
            gain_db = float(gains_db.get(band, 0.0))
            normalized, applied_db, rms_dbfs = normalize_track(stem, gain_db=gain_db)
            del stem
            master += normalized
            tracks_wav[band] = wav_bytes(normalized, FS_AUDIO)
            del normalized
            fmin, fmax = cfg.freq_bands[band]
            band_rows.append({
                "name": band,
                "fmin": float(fmin),
                "fmax": float(fmax),
                "audio_fmin": float(fmin) * 2**PITCH_STEPS,
                "audio_fmax": float(fmax) * 2**PITCH_STEPS,
                "weights_left": [float(value) for value in w_left],
                "weights_right": [float(value) for value in w_right],
                "gain_db": gain_db,
                "applied_gain_db": applied_db,
                "rms_out_dbfs": rms_dbfs,
            })

        state.stage = "Сведение мастера"
        state.pct = 0.9
        state.message = "Сумма треков + контроль пика −1 dBFS"
        peak_scale = apply_peak_ceiling(master)
        master_wav = wav_bytes(master, FS_AUDIO)
        del master

        sidecar = sidecar_bytes(build_sidecar(
            duration_s=packages.duration_s,
            channels=packages.channels,
            bands=band_rows,
            checksum=checksum,
            gains_db=gains_db,
            warnings=packages.warnings,
            clean_label=packages.clean_label,
            interpolated=packages.interpolated,
            notch_hz=AUDIO_NOTCH_HZ,
            groups=groups,
        ))
        state.artifacts = RenderArtifacts(
            master_wav=master_wav,
            tracks_wav=tracks_wav,
            sidecar=sidecar,
            bands=bands,
        )
        elapsed = time.perf_counter() - started
        state.status = "succeeded"
        state.stage = "Готово"
        state.pct = 1.0
        state.message = (
            f"7 треков + мастер, {packages.duration_s:.1f} с, "
            f"пик мастера ×{peak_scale:.3f}, {elapsed:.1f} с"
        )
        logger.info(
            "Рендер «Нейромузыки» готов: запись %s, %.1f с записи, %.1f с рендера",
            recording.recording_id, packages.duration_s, elapsed,
        )
    except Exception as exc:
        logger.exception("Рендер «Нейромузыки» упал: %s", exc)
        state.status = "failed"
        state.stage = "Ошибка"
        state.error = str(exc)
        state.finished_at = time.time()
        return
    state.finished_at = time.time()


def clear_renders() -> None:
    """Полный сброс (тесты)."""
    with _LOCK:
        _RENDERS.clear()
