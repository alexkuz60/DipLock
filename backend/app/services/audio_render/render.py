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
from app.services.audio_render.core import FS_AUDIO, RESAMPLE_UP, band_stem
from app.services.audio_render.export import (
    build_sidecar,
    input_checksum,
    sidecar_bytes,
    wav_bytes,
)
from app.services.audio_render.input import (
    AUDIO_NOTCH_HARMONICS,
    AUDIO_NOTCH_HZ,
    prepare_packages,
)
from app.services.audio_render.loudness import (
    LOUDNESS_PHON_DEFAULT,
    autobase_db,
    band_loudness_offsets,
    pit_bands,
)
from app.services.audio_render.mix import (
    BOOST_DEFAULT_DB,
    TRACK_RMS_DBFS,
    apply_peak_ceiling,
    bus_weights,
    normalize_track,
    track_rms,
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
    boost_db: float = BOOST_DEFAULT_DB,
    loudness_phon: float | None = LOUDNESS_PHON_DEFAULT,
    loudness_autobase: bool = True,
    octave_shift: int = 7,
) -> str:
    """Запускает рендер в фоновом потоке; возвращает ``render_id``.

    ``boost_db`` — базовое усиление полос (0…12 дБ, дефолт +6): целевой RMS
    трека −18 + boost (приёмка 05.10.2026). ``octave_shift`` — число октав
    транспонирования ядра (5/6/7 → ×32/×64/×128, дефолт 7 — выбор
    эксперимента 06.10.2026); валидируется в API. ``loudness_phon`` — опорный уровень
    психоакустической компенсации ISO 226 (60…90, дефолт 75; ``None`` —
    выключить, чистый RMS без поправок). ``loudness_autobase`` — стратегия A:
    при включённой компенсации база ограничивается потолком «ямы» (θ/α/β
    выравниваются по перцептиву, boost срезается до запаса потолка); ``False``
    — «максимум громкости» (база −18+boost, треки crest-limited). Один активный
    рендер за раз (``RenderBusy`` → 409 в API): FIFO-очередь задач тут
    намеренно не вводится — это эксперимент, а не job-система.
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
        args=(
            state, recording, cfg, dict(gains_db), float(boost_db),
            loudness_phon, bool(loudness_autobase), int(octave_shift),
        ),
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
    boost_db: float = BOOST_DEFAULT_DB,
    loudness_phon: float | None = LOUDNESS_PHON_DEFAULT,
    loudness_autobase: bool = True,
    octave_shift: int = 7,
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
        # Психоакустические смещения ISO 226 (считаются один раз на рендер):
        # None — режим «без компенсации» (loudness_phon=null в запросе).
        offsets: dict[str, float] | None = None
        if loudness_phon is not None:
            offsets = band_loudness_offsets(cfg.freq_bands, float(loudness_phon), octave_shift)
        n_bands = max(1, len(bands))
        n_out = packages.n_times * RESAMPLE_UP
        master = np.zeros((n_out, 2), dtype=np.float64)
        tracks_wav: dict[str, bytes] = {}
        rows: dict[str, dict[str, Any]] = {}

        # Фаза автобазы (стратегия A): стемы «ямы» считаются заранее — их crest
        # ограничивает базу, чтобы θ/α/β не упирались в потолок 0.891 и
        # выравнивались по перцептиву. Без этого при boost ≥ ~1 все треки
        # становятся crest-limited и ни boost, ни компенсация не работают
        # (приёмочный прогон 05.10.2026: дельта 0.00 дБ).
        base_db = TRACK_RMS_DBFS + boost_db
        pit: list[str] = []
        if offsets is not None and loudness_autobase:
            pit = pit_bands(cfg.freq_bands, octave_shift)
        pit_stems: dict[str, np.ndarray] = {}
        if pit:
            crests: dict[str, float] = {}
            for index, band in enumerate(pit):
                state.stage = f"Автобаза: стем «ямы» {band} ({index + 1}/{len(pit)})"
                state.pct = 0.3 + 0.15 * (index + 1) / len(pit)
                state.message = "crest середины → ограничение базы (ISO 226)"
                eeg_band = packages.packages.pop(band)
                stem = band_stem(eeg_band, w_left, w_right, pitch_steps=octave_shift)
                del eeg_band
                pit_stems[band] = stem
                rms_stem = track_rms(stem)
                peak_stem = float(np.max(np.abs(stem))) if stem.size else 0.0
                if rms_stem > 0.0 and peak_stem > 0.0:
                    crests[band] = 20.0 * float(np.log10(peak_stem / rms_stem))
            base_db = autobase_db(base_db, crests, offsets or {}, pit)
        # Фактический boost с учётом автобазы (в баланс-режиме срезается до
        # запаса потолка «ямы» — физика без компрессии).
        effective_boost = base_db - TRACK_RMS_DBFS
        tracks_start = 0.3 + (0.15 if pit else 0.0)

        for index, band in enumerate(bands):
            state.stage = f"Трек {band} ({index + 1}/{n_bands})"
            state.pct = tracks_start + (0.9 - tracks_start) * index / n_bands
            state.message = f"Ядро ×{2 ** octave_shift}: hilbert → ресемпл ×96 → {octave_shift} октав ({band})"
            if band in pit_stems:
                stem = pit_stems.pop(band)
            else:
                eeg_band = packages.packages.pop(band)
                stem = band_stem(eeg_band, w_left, w_right, pitch_steps=octave_shift)
                del eeg_band
            gain_db = float(gains_db.get(band, 0.0))
            loudness_db = 0.0 if offsets is None else offsets.get(band, 0.0)
            normalized, applied_db, rms_dbfs = normalize_track(
                stem, gain_db=gain_db, boost_db=effective_boost, loudness_db=loudness_db,
            )
            del stem
            master += normalized
            tracks_wav[band] = wav_bytes(normalized, FS_AUDIO)
            del normalized
            fmin, fmax = cfg.freq_bands[band]
            rows[band] = {
                "name": band,
                "fmin": float(fmin),
                "fmax": float(fmax),
                "audio_fmin": float(fmin) * 2**octave_shift,
                "audio_fmax": float(fmax) * 2**octave_shift,
                "weights_left": [float(value) for value in w_left],
                "weights_right": [float(value) for value in w_right],
                "gain_db": gain_db,
                "loudness_offset_db": loudness_db,
                "applied_gain_db": applied_db,
                "rms_out_dbfs": rms_dbfs,
            }
        # Строки партитуры — в порядке freq_bands (порядок расчёта не важен).
        band_rows = [rows[band] for band in bands]

        state.stage = "Сведение мастера"
        state.pct = 0.9
        state.message = "Сумма треков + контроль пика −1 dBFS"
        peak_scale = apply_peak_ceiling(master)
        master_wav = wav_bytes(master, FS_AUDIO)
        del master

        loudness_meta: dict[str, Any] | None = None
        if loudness_phon is not None and offsets is not None:
            loudness_meta = {
                "method": "iso226",
                "phon": float(loudness_phon),
                "offsets_db": {name: float(value) for name, value in offsets.items()},
                "autobase": bool(pit),
                "base_db": float(base_db),
            }
        sidecar = sidecar_bytes(build_sidecar(
            duration_s=packages.duration_s,
            channels=packages.channels,
            bands=band_rows,
            checksum=checksum,
            gains_db=gains_db,
            boost_db=boost_db,
            loudness=loudness_meta,
            warnings=packages.warnings,
            clean_label=packages.clean_label,
            interpolated=packages.interpolated,
            notch_hz=AUDIO_NOTCH_HZ,
            notch_harmonics=AUDIO_NOTCH_HARMONICS,
            groups=groups,
            octave_shift=octave_shift,
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
