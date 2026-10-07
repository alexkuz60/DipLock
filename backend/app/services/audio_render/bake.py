"""3D-bake «Нейромузыки»: детерминированный запек пространственной цепочки в WAV.

Срез 07.10.2026 (`docs/rules/spatial-audio.md`, п.3): параметры цепочки плеера
(ширина базы, разброс, влажность, помещение) → бэкенд печатает итоговый WAV
тем же способом, что и рендер — ``soundfile``/float64 без сторонних аудио-
библиотек (librosa/rubberband/pydub запрещены ТЗ). Браузер остаётся инструментом
эксперимента (real-time правки), **эталон байтов печатает Python**.

Цепочка, которую запекаем (зеркало Tone-графа ``neuromusicPlayer.ts``):

1. **StereoWidener** → M/S-формула ``L'=(2−α)·m+α·s``, ``R'=(2−α)·m−α·s``,
   ``α = width_pct/100`` (100 % → без изменения, 0 % → моно; то же
   свойство у ``widthParam`` Tone: w=0.5 ↔ no change);
2. **Панорама** — равномощная амплитудная панорама по азимуту источника
   (приближение вместо HRTF ``Panner3D`` — «Ловушки» в
   `docs/rules/neuromusic.md`, §«Варианты рендера»); геометрия азимутов та же,
   что у плеера: «Экспресс» — дуга ±60°, «Монтаж» — 4 модуля рядов
   (:func:`module_position`);
3. **Общая Convolver** на сумме модулей: ``oaconvolve`` со stereo-IR пресета,
   нормировка единичной энергией (приближение ``ConvolverNode.normalize``),
   линейный dry/wet по ``wet_pct``.

Артефакты: ``cache_dir/audio/{recording_id}/bake/{bake_sig}.wav`` + sidecar
``.json`` (пишется последним — коммит, как манифест рендера). Ключ
``bake_sig`` включает ``render_id`` (стемы), параметры цепочки, sha256 IR и
версии библиотек — детерминизм байтов одинаков с рендером. Статус — в памяти
(поллинг UI), готовый бак переживает рестарт через sidecar на диске.

Ловушки (честные ограничения метода):

* HRTF в браузере не воспроизводится — запечённый файл звучит «ближе»
  (амплитудная панорама без эффектов головы): осознанное приближение;
* хвост свёртки обрезается по длине источника (Convolver в браузере тоже
  не звучит после остановки буфера);
* память: стем читается → панорамируется → складывается в аккумулятор и
  освобождается (28 файлов «Монтажа» в RAM одновременно не держим).
"""
import hashlib
import io
import json
import logging
import math
import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
import soundfile as sf
from scipy.signal import oaconvolve

from app.core.config import Settings, settings
from app.services import audio_ir, journal
from app.services.audio_render import render as neuro_render
from app.services.audio_render import store
from app.services.audio_render.core import FS_AUDIO
from app.services.audio_render.export import wav_bytes
from app.services.audio_render.mix import apply_peak_ceiling
from app.services.cache_store import cache_path, cache_read, cache_write
from app.utils.versions import library_versions

logger = logging.getLogger(__name__)

# Версия формата/математики запекания: меняется формула цепочки — поднимите,
# иначе старый кэш отдаст старые байты под тем же ключом.
BAKE_FORMAT_VERSION = 1

# TTL статуса в памяти (как у рендера): готовый бак переживает его на диске.
BAKE_TTL_SEC = 15 * 60

# Каталог баков внутри записи (sibling рендеров — квота/сироты видят запись).
BAKE_SUBDIR = "bake"

# Границы параметров цепочки — те же, что валидирует API и держит UI.
WIDTH_MAX_PCT = 150.0
SPREAD_MAX_PCT = 100.0
WET_MAX_PCT = 100.0


class BakeBusy(RuntimeError):
    """Уже идёт другой бак (в фазе 1 — ровно один за раз, как рендер)."""


class BakeNotFound(KeyError):
    """bake_id неизвестен (нет в памяти и в sidecar на диске)."""


@dataclass
class BakeParams:
    """Параметры 3D-цепочки для запекания (тело POST)."""

    width_pct: float = 100.0
    spread_pct: float = 100.0
    wet_pct: float = 25.0
    ir: str = "room_small"

    def normalized(self) -> dict[str, Any]:
        """Параметры ключа кэша (стабильные float, порядок фиксирован)."""
        return {
            "width_pct": float(self.width_pct),
            "spread_pct": float(self.spread_pct),
            "wet_pct": float(self.wet_pct),
            "ir": str(self.ir),
        }


@dataclass
class BakeState:
    """Статус бака для поллинга клиента (pct 0..1 + шаг)."""

    bake_id: str
    render_id: str
    recording_id: str = ""
    status: Literal["running", "succeeded", "failed"] = "running"
    stage: str = "Запуск"
    pct: float = 0.0
    message: str = ""
    error: str | None = None
    bytes_out: int = 0
    payload: bytes | None = None
    """Фоллбэк байтов WAV, если запись на диск не удалась (сбой не ломает)."""
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None


_LOCK = threading.Lock()
_BAKES: dict[str, BakeState] = {}


def _sweep_locked(now: float) -> None:
    """Убирает истёкшие состояния (вызывается под ``_LOCK``)."""
    expired = [
        bake_id
        for bake_id, state in _BAKES.items()
        if state.status != "running" and now - (state.finished_at or state.started_at) > BAKE_TTL_SEC
    ]
    for bake_id in expired:
        _BAKES.pop(bake_id, None)


# --- геометрия сцены (зеркало frontend/shared/lib/spatialLayout.ts) -----------

SOURCE_DISTANCE_M = 1.5
"""Радиус дуг/модулей, метры (= refDistance плеера: равномерная громкость)."""

ARC_HALF_DEG = 60.0
"""«Экспресс»: полудуга дуги источников при полном разбросе."""

FRONTAL_HALF_DEG = 30.0
"""«Монтаж», лобной ряд: узкая дуга к лбу."""

OCCIPITAL_HALF_DEG = 30.0
"""«Монтаж», затылочный: зеркало лобной (тоже узкое)."""

PARIETAL_HALF_DEG = 60.0
"""«Монтаж», теменной: смещён в тыл, широкая дуга к затылку."""

TEMPORAL_HALF_M = 1.5
"""«Монтаж», височный: прямая линия на уровне ушей (вдоль X, Z=0)."""


def _clamp(value: float) -> float:
    """Схлопывает параметр разброса к 0…1 (NaN → 0, как на клиенте)."""
    if math.isnan(value):
        return 0.0
    return min(1.0, max(0.0, value))


def _polar(azimuth_deg: float) -> tuple[float, float]:
    """Полярные (r = SOURCE_DISTANCE_M) → ``(x, z)``: 0° — фронт (−Z), вправо +X."""
    azimuth = math.radians(azimuth_deg)
    return SOURCE_DISTANCE_M * math.sin(azimuth), -SOURCE_DISTANCE_M * math.cos(azimuth)


def arc_position(index: int, count: int, spread: float) -> tuple[float, float]:
    """Позиция ``(x, z)`` на дуге «Экспресса»: ±60°·spread перед слушателем."""
    unit = 0.0 if count <= 1 else index / (count - 1) * 2.0 - 1.0
    return _polar((ARC_HALF_DEG * unit) * _clamp(spread))


def module_position(row: str, index: int, count: int, spread: float) -> tuple[float, float]:
    """Позиция ``(x, z)`` источника модуля «Монтажа» (спецификация 07.10.2026).

    * **frontal** — дуга к лбу, узкая (±30°·spread);
    * **temporal** — прямая линия на уровне ушей (Z = 0, X −1.5…+1.5 м):
      панорама широкая, крайние точки — у слушателя на уровне ушей;
    * **parietal** — смещён в тыл, широкая дуга к затылку (180° ± 60°·spread);
    * **occipital** — зеркало лобной (180° ± 30°·spread).

    ``spread`` 0…1 схлопывает модуль к его центру. Неизвестный ряд —
    ``ValueError`` (id рядов приходят из манифеста рендера, там только свои).
    """
    unit = 0.0 if count <= 1 else index / (count - 1) * 2.0 - 1.0
    spread = _clamp(spread)
    if row == "frontal":
        return _polar((FRONTAL_HALF_DEG * unit) * spread)
    if row == "temporal":
        return TEMPORAL_HALF_M * unit * spread, 0.0
    if row == "parietal":
        return _polar(180.0 + (PARIETAL_HALF_DEG * unit) * spread)
    if row == "occipital":
        return _polar(180.0 + (OCCIPITAL_HALF_DEG * unit) * spread)
    raise ValueError(f"Неизвестный ряд модуля «Монтажа»: {row!r}")


def azimuth_deg(x: float, z: float) -> float:
    """Азимут точки ``(x, z)``: 0° — перед слушателем, +90° — справа."""
    # z == 0 (височная линия): делим на +0.0, чтобы atan2 дал ±90°/0°.
    forward = 0.0 if z == 0.0 else -z
    return math.degrees(math.atan2(x, forward))


def pan_gains(azimuth: float) -> tuple[float, float]:
    """Равномощные гейны ``(gL, gR)`` амплитудной панорамы по азимуту."""
    lateral = math.sin(math.radians(azimuth))
    return math.sqrt((1.0 - lateral) / 2.0), math.sqrt((1.0 + lateral) / 2.0)


# --- аудио-примитивы цепочки ---------------------------------------------------


def widen(stereo: np.ndarray, width_pct: float) -> np.ndarray:
    """StereoWidener: ``L'=(2−α)m+αs``, ``R'=(2−α)m−αs``, ``α=width_pct/100``.

    ``α=1`` (100 %) — без изменения, ``α=0`` — моно ``L+R``: то же свойство,
    что у ширины Tone (w=0.5 ↔ no change); формула — приближение M/S-цепочки.
    """
    alpha = float(width_pct) / 100.0
    mid = (stereo[:, 0] + stereo[:, 1]) * 0.5
    side = (stereo[:, 0] - stereo[:, 1]) * 0.5
    out = np.empty_like(stereo)
    out[:, 0] = (2.0 - alpha) * mid + alpha * side
    out[:, 1] = (2.0 - alpha) * mid - alpha * side
    return out


def normalize_ir(ir: np.ndarray) -> np.ndarray:
    """Нормировка IR единичной энергией канала (приближение ConvolverNode)."""
    out = np.array(ir, dtype=np.float64, copy=True)
    for channel in range(out.shape[1]):
        energy = float(np.sqrt(np.sum(out[:, channel] ** 2)))
        if energy > 0.0:
            out[:, channel] /= energy
    return out


# --- ключ и диск ---------------------------------------------------------------


def bake_sig(render_id: str, params: BakeParams, ir_sha: str) -> str:
    """Ключ бака: sha256 от render_id, параметров цепочки, IR и версий.

    ``render_id`` входит в ключ, потому что стемы — его артефакты: другой
    рендер (гейны/октавы/вариант) обязан перепечататься, а не взять чужие байты.
    """
    payload: dict[str, Any] = {
        "v": BAKE_FORMAT_VERSION,
        "render": render_id,
        **params.normalized(),
        "ir_sha": ir_sha,
        "versions": library_versions(),
    }
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:store.SIG_LEN]


def bake_dir(cfg: Settings, recording_id: str) -> str:
    """Каталог баков записи ``audio/{recording_id}/bake`` (путь — из ``settings``)."""
    return cache_path(cfg.cache_dir, store.AUDIO_SUBDIR, recording_id, BAKE_SUBDIR)


def _wav_name(bake_id: str) -> str:
    return f"{bake_id}.wav"


def _sidecar_name(bake_id: str) -> str:
    return f"{bake_id}.json"


def read_bake(cfg: Settings, recording_id: str, bake_id: str) -> bytes | None:
    """Байты готового бака (``None`` — нет/не читается)."""
    return cache_read(f"{bake_dir(cfg, recording_id)}/{_wav_name(bake_id)}")


def _write_bake(
    cfg: Settings, recording_id: str, bake_id: str, wav: bytes, sidecar: dict[str, Any],
) -> bool:
    """Пишет WAV и sidecar (sidecar последним — коммит, как манифест рендера)."""
    directory = bake_dir(cfg, recording_id)
    ok = cache_write(f"{directory}/{_wav_name(bake_id)}", wav, label="Кэш 3D-bake «Нейромузыки»")
    blob = json.dumps(sidecar, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8")
    ok = cache_write(f"{directory}/{_sidecar_name(bake_id)}", blob, label="Sidecar 3D-bake") and ok
    return ok


def find_bake_sidecar(cfg: Settings, bake_id: str) -> tuple[str, dict[str, Any]] | None:
    """Ищет sidecar ``bake_id`` среди записей (восстановление после рестарта)."""
    root = cache_path(cfg.cache_dir, store.AUDIO_SUBDIR)
    try:
        recordings = sorted(os.listdir(root))
    except OSError:
        return None
    for recording_id in recordings:
        blob = cache_read(f"{bake_dir(cfg, recording_id)}/{_sidecar_name(bake_id)}")
        if blob is None:
            continue
        try:
            sidecar = json.loads(blob)
        except ValueError:
            continue
        if (
            isinstance(sidecar, dict)
            and sidecar.get("bake_id") == bake_id
            and read_bake(cfg, recording_id, bake_id) is not None
        ):
            return recording_id, sidecar
    return None


# --- расчёт --------------------------------------------------------------------


def _source_azimuths(
    artifacts: "neuro_render.RenderArtifacts", spread: float,
) -> list[tuple[str, float]]:
    """``(имя файла, азимут)`` для каждого стема в порядке партитуры.

    «Экспресс»: один трек полосы на дуге ±60° (слева δ, справа γ-high).
    «Монтаж»: ``rows × bands`` — стем ряда стоит в геометрии своего модуля
    (:func:`module_position`), индекс внутри модуля — индекс полосы (та же
    логика «слева низкие частоты»).
    """
    sources: list[tuple[str, float]] = []
    bands = list(artifacts.bands)
    if artifacts.variant == "montage":
        for row in artifacts.rows:
            for index, band in enumerate(bands):
                x, z = module_position(row, index, len(bands), spread)
                sources.append((store.row_track_name(row, band), azimuth_deg(x, z)))
        return sources
    for index, band in enumerate(bands):
        x, z = arc_position(index, len(bands), spread)
        sources.append((store.track_name(band), azimuth_deg(x, z)))
    return sources


def _read_stem(blob: bytes, name: str) -> np.ndarray:
    """WAV-байты стема → float64 ``(N, 2)``; неверный формат — ошибка статуса."""
    data, fs = sf.read(io.BytesIO(blob), dtype="float64", always_2d=True)
    if int(fs) != FS_AUDIO:
        raise ValueError(f"Стем {name}: частота {fs} ≠ {FS_AUDIO} Гц")
    if data.shape[1] != 2:
        raise ValueError(f"Стем {name}: ожидалось стерео, получено каналов {data.shape[1]}")
    return data


def bake_wav(
    artifacts: "neuro_render.RenderArtifacts",
    params: BakeParams,
    ir_blob: bytes,
    on_progress: Callable[[float, str], None] | None = None,
) -> bytes:
    """Печатает сцену рендера с 3D-цепочкой → байты WAV PCM_24 @48000.

    Каждый стем проходит widening → панораму по азимуту и сразу складывается
    в аккумулятор (в RAM — один стем + аккумулятор, а не 28 сразу); затем
    общая свёртка с IR и линейный dry/wet. Пик прижимается к −1 dBFS общим
    контролем рендера (:func:`apply_peak_ceiling`).
    """
    def _progress(pct: float, stage: str) -> None:
        if on_progress is not None:
            on_progress(pct, stage)

    ir, ir_fs = sf.read(io.BytesIO(ir_blob), dtype="float64", always_2d=True)
    if int(ir_fs) != FS_AUDIO:
        raise ValueError(f"IR: частота {ir_fs} ≠ {FS_AUDIO} Гц")
    ir = normalize_ir(ir)

    # spread UI-проценты → доля 0…1 (как spreadParam на клиенте).
    sources = _source_azimuths(artifacts, min(1.0, max(0.0, params.spread_pct / 100.0)))
    master: np.ndarray | None = None
    total = max(1, len(sources))
    for index, (name, azimuth) in enumerate(sources):
        _progress(0.05 + 0.55 * index / total, f"Панорама: стем {index + 1}/{total}")
        blob = artifacts.read(name)
        if blob is None:
            raise ValueError(f"Стем {name} не найден в кэше рендера — пересчитайте запись")
        stem = _read_stem(blob, name)
        if master is None:
            master = np.zeros_like(stem)
        stem = widen(stem, params.width_pct)
        gain_l, gain_r = pan_gains(azimuth)
        stem[:, 0] *= gain_l
        stem[:, 1] *= gain_r
        master += stem
        del stem
    if master is None:
        raise ValueError("В рендере нет ни одного стема — нечего запекать")

    wet = min(1.0, max(0.0, params.wet_pct / 100.0))
    if wet > 0.0:
        _progress(0.7, "Реверберация: общая Convolver (oaconvolve)")
        for channel in range(2):
            tail = oaconvolve(master[:, channel], ir[:, channel])
            master[:, channel] = (1.0 - wet) * master[:, channel] + wet * tail[: master.shape[0]]
    _progress(0.9, "Пик-контроль и запись WAV")
    apply_peak_ceiling(master)
    return wav_bytes(master, FS_AUDIO)


# --- статус и запуск -----------------------------------------------------------


def _state_from_sidecar(
    bake_id: str, render_id: str, recording_id: str, sidecar: dict[str, Any],
) -> BakeState:
    """Состояние succeeded из sidecar на диске (кэш-хит/восстановление)."""
    now = time.time()
    return BakeState(
        bake_id=bake_id,
        render_id=render_id,
        recording_id=recording_id,
        status="succeeded",
        stage="Готово",
        pct=1.0,
        message=str(sidecar.get("message") or "Из дискового кэша"),
        bytes_out=int(sidecar.get("bytes") or 0),
        started_at=now,
        finished_at=now,
    )


def start_bake(render_id: str, params: BakeParams) -> tuple[str, bool]:
    """Возвращает ``(bake_id, cached)``: запускает запекание либо отдаёт кэш.

    Порядок как у рендера: кэш в памяти → sidecar на диске → запуск; кэш-
    попадание не трогает расчёт и возвращается параллельно с идущим баком.
    Ровно один бак за раз (``BakeBusy`` → 409). Рендер должен быть готов —
    иначе ``RenderBusy`` (409). ``ir_bytes`` читается здесь (вызов идёт в
    ``asyncio.to_thread``): sha IR входит в ключ, генерация пресета — работа
    с диском.
    """
    render_state = neuro_render.state_of(render_id)
    artifacts = render_state.artifacts
    if artifacts is None:
        raise neuro_render.RenderBusy("Рендер ещё идёт — дождитесь завершения перед запеканием")
    ir_blob = audio_ir.ir_bytes(params.ir)
    ir_sha = hashlib.sha256(ir_blob).hexdigest()
    bake_id = bake_sig(render_id, params, ir_sha)
    lookup_started = time.perf_counter()
    recording_id = artifacts.recording_id

    with _LOCK:
        _sweep_locked(time.time())
        state = _BAKES.get(bake_id)
        if state is not None and state.status == "succeeded":
            return bake_id, True
    found = find_bake_sidecar(settings, bake_id)
    if found is not None:
        disk_recording_id, sidecar = found
        state = _state_from_sidecar(bake_id, render_id, disk_recording_id, sidecar)
        state.message = "попадание в дисковый кэш"
        with _LOCK:
            _BAKES[bake_id] = state
        _journal_bake(
            state, ms=(time.perf_counter() - lookup_started) * 1000.0,
            bytes_out=state.bytes_out, cache_hit=True, note="попадание в дисковый кэш",
        )
        return bake_id, True

    with _LOCK:
        _sweep_locked(time.time())
        if any(running.status == "running" for running in _BAKES.values()):
            raise BakeBusy("Запекание уже идёт — дождитесь его завершения")
        state = BakeState(bake_id=bake_id, render_id=render_id, recording_id=recording_id)
        _BAKES[bake_id] = state
    thread = threading.Thread(
        target=_run_bake,
        args=(state, artifacts, dict(params.normalized()), ir_blob, ir_sha),
        name=f"audio-bake-{bake_id}",
        daemon=True,
    )
    thread.start()
    return bake_id, False


def state_of(bake_id: str) -> BakeState:
    """Состояние бака; ``BakeNotFound`` — нет ни в памяти, ни в sidecar диска."""
    with _LOCK:
        _sweep_locked(time.time())
        state = _BAKES.get(bake_id)
    if state is not None:
        return state
    found = find_bake_sidecar(settings, bake_id)
    if found is None:
        raise BakeNotFound(bake_id)
    recording_id, sidecar = found
    state = _state_from_sidecar(
        bake_id, str(sidecar.get("render_id") or ""), recording_id, sidecar,
    )
    with _LOCK:
        _BAKES[bake_id] = state
    return state


def _run_bake(
    state: BakeState, artifacts: "neuro_render.RenderArtifacts",
    params: dict[str, Any], ir_blob: bytes, ir_sha: str,
) -> None:
    """Фоновый цикл запекания: печать → запись (WAV, потом sidecar) → журнал."""
    started = time.perf_counter()
    bake_params = BakeParams(**params)
    try:

        def _progress(pct: float, stage: str) -> None:
            state.pct = float(pct)
            state.stage = stage

        _progress(0.02, "Чтение стемов и IR")
        wav = bake_wav(artifacts, bake_params, ir_blob, on_progress=_progress)
        state.pct = 0.95
        state.stage = "Сохранение на диск"
        sidecar = {
            "format": BAKE_FORMAT_VERSION,
            "bake_id": state.bake_id,
            "render_id": state.render_id,
            "recording_id": state.recording_id,
            "params": bake_params.normalized(),
            "ir_sha": ir_sha,
            "created_at": time.time(),
            "bytes": len(wav),
            "message": "Запечённая 3D-цепочка (spatial-audio, п.3)",
        }
        ok = _write_bake(settings, state.recording_id, state.bake_id, wav, sidecar)
        if not ok:
            # Сбой записи не ломает расчёт: байты остаются в памяти (кэш —
            # оптимизация, а не источник истины, `data-and-caches.md` п.4).
            logger.warning("Бак %s не записан на диск — байты в памяти", state.bake_id)
            state.payload = wav
        elapsed = (time.perf_counter() - started) * 1000.0
        state.bytes_out = len(wav)
        state.message = (
            f"3D-bake {len(wav) // 1024} КБ, {artifacts.variant}, "
            f"{len(artifacts.bands)} полос, {elapsed:.0f} мс"
        )
        _journal_bake(
            state, ms=elapsed, bytes_out=len(wav), cache_hit=False, note=state.message,
        )
        state.status = "succeeded"
        state.stage = "Готово"
        state.pct = 1.0
        logger.info(
            "3D-bake готов: рендер %s, %.0f мс, кэш %s",
            state.render_id, elapsed, "записан" if ok else "НЕ записан",
        )
    except Exception as exc:
        logger.exception("3D-bake упал: %s", exc)
        state.status = "failed"
        state.stage = "Ошибка"
        state.error = str(exc)
    state.finished_at = time.time()


def _journal_bake(
    state: BakeState, *, ms: float, bytes_out: int, cache_hit: bool, note: str,
) -> None:
    """Строка журнала шагов о запекании (как у рендера; сбои гасятся)."""
    try:
        with journal.job_scope(f"bake-{state.bake_id}", state.recording_id):
            journal.record(
                "audio", "bake", ms=ms, params_key=state.bake_id,
                bytes_out=bytes_out or None, cache_hit=cache_hit, note=note, cfg=settings,
            )
    except Exception:
        logger.warning("Строка журнала о баке %s не записана", state.bake_id, exc_info=True)


def clear_bakes() -> None:
    """Полный сброс состояний (тесты); артефакты на диске не трогает."""
    with _LOCK:
        _BAKES.clear()


def drop_recording(recording_id: str) -> None:
    """Убирает состояния баков записи (вызывается при её удалении/вытеснении).

    Дисковые файлы сносит ``store.clear_audio_cache`` рядом — в памяти
    остаётся только статус, и после чистки диска он не должен отдаваться.
    """
    with _LOCK:
        for bake_id in [
            bid for bid, state in _BAKES.items() if state.recording_id == recording_id
        ]:
            _BAKES.pop(bake_id, None)
