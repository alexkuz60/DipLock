"""Оркестрация рендера «Нейромузыки»: статус в памяти, артефакты на диске.

Модель (срез 07.10.2026, хранение аудио): ``render_id`` = ``sig`` — детерминированный
ключ параметров (см. ``store.render_sig``). Активный рендер живёт в памяти
(проценты по трекам для поллинга); готовые артефакты (WAV мастера/треков +
sidecar) пишутся в дисковый кэш ``audio/{recording_id}/{sig}/`` с манифестом-
коммитом — они переживают перезапуск сервера и TTL памяти, а повторный POST
тех же параметров отдаёт кэш-попадание без запуска конвейера. Если диск
недоступен, байты остаются в памяти (фоллбэк — сбой записи кэша не ломает
расчёт, `docs/rules/data-and-caches.md` п.4).

Память (лимит фазы 1): в процессе рендера живут мастер (float64) + текущий стем
(+ нормированная копия) + накопленные WAV-байты треков — для записи ~2 минуты
это сотни МБ; после записи на диск они освобождаются. На часовых записях нужен
блочный рендер (будущее, вне ТЗ).
"""
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np

from app.core.config import Settings, settings
from app.services import journal
from app.services.audio_render import emo_radar, store, vamp_analysis
from app.services.audio_render import rows as rows_module
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
    normalize_group,
    normalize_track,
    track_rms,
)
from app.services.recordings import Recording

logger = logging.getLogger(__name__)

# TTL состояния рендера в памяти: артефакты живут на диске (store), сюда
# попадают только статус/прогресс — старое удаляется, восстановить можно из
# манифеста (см. state_of).
RENDER_TTL_SEC = 15 * 60


class RenderBusy(RuntimeError):
    """Уже идёт другой рендер (в фазе 1 — ровно один за раз)."""


class RenderNotFound(KeyError):
    """render_id неизвестен или истёк TTL."""


@dataclass
class RenderArtifacts:
    """Готовые артефакты рендера: каталог на диске (норма) либо байты в памяти.

    ``directory`` — каталог кэша ``audio/{recording_id}/{sig}``: WAV читаются
    по требованию (:meth:`read`), поэтому после завершения рендера RAM не
    удерживает сотни мегабайт. ``memory`` — фоллбэк, если запись на диск не
    удалась: файлы отдаются из памяти, манифест не записан (следующий POST —
    честный пересчёт).
    """

    bands: list[str]
    recording_id: str
    sig: str
    variant: str = "express"
    rows: list[str] = field(default_factory=list)
    """Для «Монтажа»: id рядов, по которым есть рядовые треки (иначе пусто)."""
    directory: str | None = None
    memory: dict[str, bytes] = field(default_factory=dict)

    def read(self, name: str) -> bytes | None:
        """Байты файла артефакта (диск → память; ``None`` — нет/не читается)."""
        if self.directory:
            data = store.read_artifact(self.directory, name)
            if data is not None:
                return data
        return self.memory.get(name)


@dataclass
class RenderState:
    """Статус рендера для поллинга клиента (пct 0..1 + шаг пайплайна)."""

    render_id: str
    recording_id: str = ""
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


def _state_from_manifest(
    cfg: Settings, sig: str, recording_id: str, manifest: dict[str, Any],
) -> RenderState:
    """Состояние succeeded из манифеста на диске (кэш-хит/восстановление)."""
    directory = store.render_dir(cfg, recording_id, sig)
    now = time.time()
    return RenderState(
        render_id=sig,
        recording_id=recording_id,
        status="succeeded",
        stage="Готово",
        pct=1.0,
        message=str(manifest.get("message") or "Из дискового кэша"),
        artifacts=RenderArtifacts(
            bands=list(manifest.get("bands") or []),
            recording_id=recording_id,
            sig=sig,
            variant=str(manifest.get("variant") or "express"),
            rows=list(manifest.get("rows") or []),
            directory=directory,
        ),
        started_at=now,
        finished_at=now,
    )


def start_render(
    recording: Recording, cfg: Settings, gains_db: dict[str, float],
    boost_db: float = BOOST_DEFAULT_DB,
    loudness_phon: float | None = LOUDNESS_PHON_DEFAULT,
    loudness_autobase: bool = True,
    octave_shift: int = 7,
    variant: str = "express",
) -> tuple[str, bool]:
    """Возвращает ``(render_id, cached)``: запускает рендер либо отдаёт кэш.

    ``render_id`` = ``sig`` — детерминированный ключ параметров (см.
    ``store.render_sig``), поэтому повторный POST с теми же параметрами
    возвращает тот же идентификатор. Порядок: кэш в памяти → кэш на диске →
    запуск. Кэш-попадание не трогает конвейер и не требует «свободного»
    слота, поэтому возвращается даже параллельно с другим идущим рендером.

    Параметры: ``boost_db`` — базовое усиление полос (0…12 дБ, дефолт +6):
    целевой RMS трека −18 + boost (приёмка 05.10.2026). ``octave_shift`` — число
    октав транспонирования ядра (5/6/7 → ×32/×64/×128, дефолт 7 — выбор
    эксперимента 06.10.2026); валидируется в API. ``loudness_phon`` — опорный
    уровень психоакустической компенсации ISO 226 (60…90, дефолт 75; ``None`` —
    выключить, чистый RMS без поправок). ``loudness_autobase`` — стратегия A:
    при включённой компенсации база ограничивается потолком «ямы» (θ/α/β
    выравниваются по перцептиву, boost срезается до запаса потолка); ``False``
    — «максимум громкости» (база −18+boost, треки crest-limited). Один активный
    рендер за раз (``RenderBusy`` → 409 в API): FIFO-очередь задач тут
    намеренно не вводится — это эксперимент, а не job-система.
    """
    sig = store.render_sig(
        recording, cfg, gains_db, boost_db, loudness_phon, loudness_autobase,
        octave_shift, variant,
    )
    lookup_started = time.perf_counter()
    # 1) Кэш в памяти: недавний рендер с теми же параметрами (в том числе
    #    фоллбэк «запись на диск не удалась» — байты ещё в RAM).
    with _LOCK:
        _sweep_locked(time.time())
        state = _RENDERS.get(sig)
        if state is not None and state.status == "succeeded":
            return sig, True
    # 2) Кэш на диске: манифест-коммит переживает TTL памяти и рестарт.
    manifest = store.load_manifest(cfg, recording.recording_id, sig)
    if manifest is not None:
        with _LOCK:
            _RENDERS[sig] = _state_from_manifest(cfg, sig, recording.recording_id, manifest)
        _journal_render(
            cfg, recording, sig,
            ms=(time.perf_counter() - lookup_started) * 1000.0,
            bytes_out=sum(int(v) for v in (manifest.get("files") or {}).values()),
            cache_hit=True, note="попадание в дисковый кэш",
        )
        return sig, True
    # 3) Запуск нового рендера.
    with _LOCK:
        _sweep_locked(time.time())
        if any(state.status == "running" for state in _RENDERS.values()):
            raise RenderBusy("Рендер уже идёт — дождитесь его завершения")
        state = RenderState(render_id=sig, recording_id=recording.recording_id)
        _RENDERS[sig] = state
    thread = threading.Thread(
        target=_run_render,
        args=(
            state, recording, cfg, dict(gains_db), float(boost_db),
            loudness_phon, bool(loudness_autobase), int(octave_shift), variant,
        ),
        name=f"audio-render-{sig}",
        daemon=True,
    )
    thread.start()
    return sig, False


def _journal_render(
    cfg: Settings, recording: Recording, sig: str, *,
    ms: float, bytes_out: int, cache_hit: bool, note: str,
) -> None:
    """Строка журнала шагов о рендере (запись — в analytics под recording_id).

    Сбой журнала не должен ломать рендер — ``record`` сам гасит ошибки записи,
    здесь дополнительно оборачиваем: вызов идёт из фонового потока.
    """
    try:
        with journal.job_scope(f"render-{sig}", recording.recording_id):
            journal.record(
                "audio", "render", ms=ms, params_key=sig,
                bytes_out=bytes_out or None, cache_hit=cache_hit, note=note, cfg=cfg,
            )
    except Exception:
        logger.warning("Строка журнала о рендере %s не записана", sig, exc_info=True)


def state_of(render_id: str) -> RenderState:
    """Состояние рендера; ``RenderNotFound`` — нет ни в памяти, ни в кэше диска.

    После рестарта сервера (или истечения TTL памяти) готовый рендер
    восстанавливается из манифеста на диске — артефакты переживают процесс.
    """
    with _LOCK:
        _sweep_locked(time.time())
        state = _RENDERS.get(render_id)
    if state is not None:
        return state
    found = store.find_manifest(settings, render_id)
    if found is None:
        raise RenderNotFound(render_id)
    recording_id, manifest = found
    state = _state_from_manifest(settings, render_id, recording_id, manifest)
    with _LOCK:
        _RENDERS[render_id] = state
    return state


def emo_payload_of(state: RenderState) -> dict[str, Any] | None:
    """Кадры «Эмо» готового рендера: артефакт либо добивка из ``master.wav``.

    Рендеры, посчитанные до среза «Эмо» (08.10.2026), манифеста с ``emo.json``
    не имеют: кадры считаются из ``master.wav`` (без временных файлов) и
    дописываются в кэш — новый артефакт не поднимает ``RENDER_FORMAT_VERSION``
    (байты аудио не меняются), файл добавляется в ``files`` манифеста, чтобы
    комплект оставался самопроверяемым. ``None`` — нет ни кадров, ни мастера
    (409 в API). Вычисление дискового чтения идёт вне event loop (to_thread).
    """
    artifacts = state.artifacts
    if artifacts is None:
        return None
    blob = artifacts.read(store.EMO_NAME)
    if blob is not None:
        payload = emo_radar.parse_emo(blob)
        if payload is not None:
            return payload
    master_blob = artifacts.read(store.MASTER_NAME)
    if master_blob is None:
        return None
    # Трек тональности и темп (VAMP) по байтам мастера; инструмент
    # недоступен → треки None, кадры всё равно добиваются.
    key_track = vamp_analysis.key_track_from_wav(master_blob)
    tempo_track = vamp_analysis.tempo_track_from_wav(master_blob)
    payload = emo_radar.frames_from_wav(
        master_blob, key_track=key_track, tempo_track=tempo_track,
    )
    fresh = emo_radar.emo_bytes(payload)
    if artifacts.directory is None:
        # Фоллбэк «запись на диск не удалась» — держим кадры в памяти рядом
        # с байтами мастер-файла (случай сбоя записи кэша, data-and-caches §4).
        artifacts.memory[store.EMO_NAME] = fresh
        return payload
    store.write_artifacts(
        settings, state.recording_id, state.render_id, {store.EMO_NAME: fresh},
    )
    manifest = store.load_manifest(settings, state.recording_id, state.render_id)
    if manifest is not None:
        files = manifest.setdefault("files", {})
        files[store.EMO_NAME] = len(fresh)
        store.write_manifest(settings, state.recording_id, state.render_id, manifest)
    logger.debug(
        "Кадры «Эмо» %s добиты из master.wav: %d кадров",
        state.render_id, payload.get("frame_count", 0),
    )
    return payload


def _run_render(
    state: RenderState, recording: Recording, cfg: Settings, gains_db: dict[str, float],
    boost_db: float = BOOST_DEFAULT_DB,
    loudness_phon: float | None = LOUDNESS_PHON_DEFAULT,
    loudness_autobase: bool = True,
    octave_shift: int = 7,
    variant: str = "express",
) -> None:
    """Цикл рендера: подготовка → ядро по полосам → мастер → экспорт.

    Прогресс: подготовка 0..0.3 (``prepare_packages``), семь треков 0.3..0.9,
    сведение/экспорт 0.9..1.0 — клиент рисует единый прогресс-бар (ТЗ M5).

    ``variant`` — «express» (7 треков L/C/R, шины ``bus_weights``) или
    «montage» (ряды ``rows.row_mixes``: для каждой полосы отдельный стем на
    каждый непустой ряд, групповой гейн ``normalize_group`` сохраняет
    баланс рядов; файлы ``track_{row}_{band}.wav``). Мастер и психоакустика
    общие для обоих вариантов.
    """
    started = time.perf_counter()
    try:

        def _stage(message: str, pct: float) -> None:
            state.stage = message
            state.pct = float(pct)

        packages = prepare_packages(recording, cfg, on_stage=_stage)
        # Отпечаток входа — до освобождения пакетов (в sidecar и для детерминизма).
        checksum = input_checksum(packages.packages)
        # Веса шин считаются всегда: фаза автобазы меряет crest по шинному
        # стему (веса шин не зависят от варианта). Для «Монтажа» группу
        # стемов каждой полосы дают ряды, а groups/sidecar описывают ряды.
        w_left, w_right, groups = bus_weights(packages.channels)
        row_mixes_list: list[rows_module.RowMix] = []
        sidecar_rows: list[dict[str, Any]] | None = None
        if variant == "montage":
            row_mixes_list, row_warnings = rows_module.row_mixes(packages.channels)
            packages.warnings.extend(row_warnings)
            groups = {mix.id: mix.channels for mix in row_mixes_list}
            sidecar_rows = [
                {
                    "id": mix.id,
                    "label": mix.label,
                    "channels": mix.channels,
                    "members": mix.members(),
                }
                for mix in row_mixes_list
            ]

        bands = list(cfg.freq_bands)
        # Психоакустические смещения ISO 226 (считаются один раз на рендер):
        # None — режим «без компенсации» (loudness_phon=null в запросе).
        offsets: dict[str, float] | None = None
        if loudness_phon is not None:
            offsets = band_loudness_offsets(cfg.freq_bands, float(loudness_phon), octave_shift)
        n_bands = max(1, len(bands))
        n_out = packages.n_times * RESAMPLE_UP
        master = np.zeros((n_out, 2), dtype=np.float64)
        rows: dict[str, dict[str, Any]] = {}

        # Потоковая запись треков: WAV уходит на диск сразу после полосы.
        # «Монтаж» пишет 4×7 файлов — накопление всех байтов в RAM (схема
        # «Экспресса» фазы 1) умножило бы пик памяти ещё ×4. Манифест
        # по-прежнему пишется последним (коммит, `store`): сбой записи →
        # байты в fallback-памяти и манифест не записан → честный
        # пересчёт при следующем POST; для текущего рендера отдача читает
        # диск, а при сбое — память (`RenderArtifacts.read`).
        file_sizes: dict[str, int] = {}
        memory_fallback: dict[str, bytes] = {}
        files_ok = True

        def _persist(name: str, data: bytes) -> None:
            """Один файл рендера → диск; при сбое записи — байты в память."""
            nonlocal files_ok
            file_sizes[name] = len(data)
            if store.write_artifacts(
                cfg, recording.recording_id, state.render_id, {name: data},
            ):
                return
            files_ok = False
            memory_fallback[name] = data

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
                # «Монтаж»: шинный стем здесь только ради crest — пакет полосы
                # остаётся в очереди (главный цикл соберёт рядовые стемы), а
                # стем сразу отпускается: кэш pit-стемов для «Монтажа» не
                # ведём, он умножил бы память фазы ×4 без выгоды (в основном
                # цикле шинный стем всё равно не используется).
                if variant == "montage":
                    eeg_band = packages.packages[band]
                else:
                    eeg_band = packages.packages.pop(band)
                stem = band_stem(eeg_band, w_left, w_right, pitch_steps=octave_shift)
                del eeg_band
                if variant != "montage":
                    pit_stems[band] = stem
                rms_stem = track_rms(stem)
                peak_stem = float(np.max(np.abs(stem))) if stem.size else 0.0
                if rms_stem > 0.0 and peak_stem > 0.0:
                    crests[band] = 20.0 * float(np.log10(peak_stem / rms_stem))
                if variant == "montage":
                    del stem
            base_db = autobase_db(base_db, crests, offsets or {}, pit)
        # Фактический boost с учётом автобазы (в баланс-режиме срезается до
        # запаса потолка «ямы» — физика без компрессии).
        effective_boost = base_db - TRACK_RMS_DBFS
        tracks_start = 0.3 + (0.15 if pit else 0.0)

        for index, band in enumerate(bands):
            state.stage = f"Трек {band} ({index + 1}/{n_bands})"
            state.pct = tracks_start + (0.9 - tracks_start) * index / n_bands
            state.message = f"Ядро ×{2 ** octave_shift}: hilbert → ресемпл ×96 → {octave_shift} октав ({band})"
            gain_db = float(gains_db.get(band, 0.0))
            loudness_db = 0.0 if offsets is None else offsets.get(band, 0.0)
            if variant == "montage":
                # Один пакет полосы → стем на каждый непустой ряд; общий гейн
                # группы (normalize_group) сохраняет баланс рядов внутри полосы.
                eeg_band = packages.packages.pop(band)
                stems = [
                    band_stem(eeg_band, mix.w_left, mix.w_right, pitch_steps=octave_shift)
                    for mix in row_mixes_list
                ]
                del eeg_band
                normalized_list, applied_db, rms_dbfs = normalize_group(
                    stems, gain_db=gain_db, boost_db=effective_boost,
                    loudness_db=loudness_db,
                )
                del stems
                for mix, normalized in zip(row_mixes_list, normalized_list, strict=True):
                    master += normalized
                    _persist(
                        store.row_track_name(mix.id, band),
                        wav_bytes(normalized, FS_AUDIO),
                    )
                    del normalized
                del normalized_list
            else:
                if band in pit_stems:
                    stem = pit_stems.pop(band)
                else:
                    eeg_band = packages.packages.pop(band)
                    stem = band_stem(eeg_band, w_left, w_right, pitch_steps=octave_shift)
                    del eeg_band
                normalized, applied_db, rms_dbfs = normalize_track(
                    stem, gain_db=gain_db, boost_db=effective_boost, loudness_db=loudness_db,
                )
                del stem
                master += normalized
                _persist(store.track_name(band), wav_bytes(normalized, FS_AUDIO))
                del normalized
            fmin, fmax = cfg.freq_bands[band]
            rows[band] = {
                "name": band,
                "fmin": float(fmin),
                "fmax": float(fmax),
                "audio_fmin": float(fmin) * 2**octave_shift,
                "audio_fmax": float(fmax) * 2**octave_shift,
                "gain_db": gain_db,
                "loudness_offset_db": loudness_db,
                "applied_gain_db": applied_db,
                "rms_out_dbfs": rms_dbfs,
            }
            if variant != "montage":
                # Веса шин (одинаковы для всех полос) — только «Экспресс»:
                # у «Монтажа» веса рядов лежат в sidecar-блоке rows.
                rows[band]["weights_left"] = [float(value) for value in w_left]
                rows[band]["weights_right"] = [float(value) for value in w_right]
        # Строки партитуры — в порядке freq_bands (порядок расчёта не важен).
        band_rows = [rows[band] for band in bands]

        state.stage = "Сведение мастера"
        state.pct = 0.9
        state.message = "Сумма треков + контроль пика −1 dBFS"
        peak_scale = apply_peak_ceiling(master)
        # Кадры радара «Эмо» — по моно-слиянию чистого микса (мастер после
        # пика = байты master.wav и источник `master` плеера): считается здесь
        # же, из памяти, без временного моно-файла и без повторного чтения
        # диска (спецификация 08.10.2026 — «параллельно операциям рендера»).
        master_wav = wav_bytes(master, FS_AUDIO)
        # Трек тональности для вращения звезды и темп для её коррекции (VAMP) —
        # по тем же байтам мастера; инструмент недоступен → треки None
        # (вращение/коррекция в UI нулевые), рендер не падает (best-effort).
        key_track = vamp_analysis.key_track_from_wav(master_wav)
        tempo_track = vamp_analysis.tempo_track_from_wav(master_wav)
        emo_payload = emo_radar.frames_from_master(
            master, key_track=key_track, tempo_track=tempo_track,
        )
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
            variant=variant,
            rows=sidecar_rows,
        ))
        state.stage = "Сохранение на диск"
        state.pct = 0.95
        state.message = "Мастер, sidecar и манифест в дисковый кэш"
        # Треки уже на диске (потоковая запись в цикле): остаётся мастер и
        # sidecar. Манифест пишется последним и служит коммитом (нет его →
        # кэш-промах → честный пересчёт); при сбое записи байты в памяти —
        # кэш оптимизация, а не источник истины.
        _persist(store.MASTER_NAME, master_wav)
        _persist(store.SIDECAR_NAME, sidecar)
        # Кадры «Эмо» рядом с мастером: входят в files манифеста (коммит
        # кэша); для старых рендеров без emo.json есть emo_payload_of.
        _persist(store.EMO_NAME, emo_radar.emo_bytes(emo_payload))
        del emo_payload
        del master_wav
        elapsed = time.perf_counter() - started
        n_tracks = len(bands) if variant != "montage" else len(bands) * len(row_mixes_list)
        message = (
            f"{n_tracks} треков + мастер, {packages.duration_s:.1f} с, "
            f"пик мастера ×{peak_scale:.3f}, {elapsed:.1f} с"
        )
        row_ids = [mix.id for mix in row_mixes_list]
        manifest = {
            "format": store.RENDER_FORMAT_VERSION,
            "sig": state.render_id,
            "recording_id": recording.recording_id,
            "created_at": time.time(),
            "duration_s": float(packages.duration_s),
            "bands": bands,
            "variant": variant,
            "rows": row_ids,
            "params": {
                "gains_db": {name: float(value) for name, value in sorted(gains_db.items())},
                "boost_db": float(boost_db),
                "loudness_phon": None if loudness_phon is None else float(loudness_phon),
                "loudness_autobase": bool(loudness_autobase),
                "octave_shift": int(octave_shift),
                "variant": variant,
            },
            "files": dict(file_sizes),
            "message": message,
        }
        manifest_ok = files_ok and store.write_manifest(
            cfg, recording.recording_id, state.render_id, manifest,
        )
        if files_ok and not manifest_ok:
            logger.warning(
                "Манифест рендера %s не записан — кэш-промах при следующем POST",
                state.render_id,
            )
        state.artifacts = RenderArtifacts(
            bands=bands,
            recording_id=recording.recording_id,
            sig=state.render_id,
            variant=variant,
            rows=row_ids,
            # Диск даже при files_ok=False: успешные файлы там, сбойные — в
            # memory (read сначала смотрит каталог, затем память).
            directory=store.render_dir(cfg, recording.recording_id, state.render_id),
            memory=dict(memory_fallback),
        )
        state.message = message
        # Строка журнала — до «succeeded»: поллинг клиента и чтение журнала
        # увидят завершение одновременно (без гонки «статус есть, строки нет»).
        _journal_render(
            cfg, recording, state.render_id,
            ms=elapsed * 1000.0,
            bytes_out=sum(file_sizes.values()),
            cache_hit=False, note=message,
        )
        state.status = "succeeded"
        state.stage = "Готово"
        state.pct = 1.0
        logger.info(
            "Рендер «Нейромузыки» готов: запись %s, %.1f с записи, %.1f с рендера, кэш %s",
            recording.recording_id, packages.duration_s, elapsed,
            "записан" if manifest_ok else "НЕ записан",
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
    """Полный сброс состояний (тесты); артефакты на диске не трогает."""
    with _LOCK:
        _RENDERS.clear()


def drop_recording(recording_id: str) -> None:
    """Убирает состояния рендера записи (вызывается при её удалении/вытеснении).

    Дисковые артефакты чистит ``store.clear_audio_cache`` рядом — в памяти
    остаётся только статус, и после чистки диска он не должен отдаваться.
    """
    with _LOCK:
        for render_id in [
            rid for rid, state in _RENDERS.items() if state.recording_id == recording_id
        ]:
            _RENDERS.pop(render_id, None)
