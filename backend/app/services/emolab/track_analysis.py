"""Анализ аудиотрека «ЕмоЛаб»: ФФТ-кадры «Эмо» + карты темпа и аккордов VAMP.

Постановка 20.10.2026 (шаг 1 + уточнение шага 2): внешний аудиофайл
(wav/mp3) → данные прогноза эмоциональной реакции на прослушивание.
Используются **те же** функциональные блоки «Нейромузыки»:

* быстрый ФФТ — ``services/audio_render/emo_radar`` (окно 32768, сдвиг 32000,
  перекрытие 768, 14 октавных блоков → 7 счётчиков, дБ-шкала); частота
  моно-файла анализа — **32000 Гц** (``track_input.ANALYSIS_FS``), поэтому
  кадр звезды длится ровно **1 с** (уточнение владельца 20.10.2026: кадр =
  32000 сэмплов = 1 сек);
* VAMP-плагины Соник Аннотатора — ``services/audio_render/vamp_analysis``:
  карта темпа (Tempo and Beat Tracker), карта аккордов (Key Detector;
  «аккорд» — термин UI для сегмента тональности) и сегментация трека
  (Segmenter — визуально-слуховой контроль, в расчётах не участвует).

Контракт payload — тот же ``emo.json`` (``AudioEmoOut``, v5): кадры +
``key_track`` + ``tempo_track`` + ``segment_track``, поэтому фронтенд-звезда-
полигон «Нейромузыки» (вращение по аккордам, темп-коррекция лучей)
переиспользуется без правок.

Паттерн — как у рендера (``audio_render/render.py``): in-memory статус для
поллинга, результат пишется в дисковый кэш ``emolab/{track_id}/`` (манифест —
коммит), повторный анализ того же файла (sha256) не пересчитывается. В отличие
от рендера анализов может идти несколько параллельно — их ограничивает
семафор (:data:`MAX_PARALLEL`), а не «один за раз» (файл пользователя не
привязан к записи и не разделяет конвейер с другими).

Тяжёлые шаги синхронны — их зовут из фонового потока (:func:`start_analysis`
создаёт поток), event loop не блокируется (правило «Async»).
"""
import hashlib
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Literal

from app.core.config import Settings, settings
from app.services.audio_render import emo_radar, vamp_analysis
from app.services.emolab import store, track_input

logger = logging.getLogger(__name__)

# Параллельность анализов (фоновых потоков): 2 — пользователь может открыть
# новый трек, не дожидаясь конца предыдущего; больше — только нагрузка CPU.
MAX_PARALLEL = 2

# Сколько живёт статус в памяти после завершения (как у рендера): дальше
# состояние восстанавливается из манифеста диска.
TRACK_STATE_TTL_SEC = 15 * 60


@dataclass
class TrackState:
    """Статус анализа трека для поллинга клиента (pct 0..1 + шаг)."""

    track_id: str
    filename: str = ""
    status: Literal["running", "succeeded", "failed"] = "running"
    stage: str = "Запуск"
    pct: float = 0.0
    message: str = ""
    error: str | None = None
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None


class TrackNotFound(Exception):
    """track_id нет ни в памяти, ни в дисковом кэше (404 в API)."""

    def __init__(self, track_id: str) -> None:
        super().__init__(track_id)
        self.track_id = track_id


_LOCK = threading.Lock()
_TRACKS: dict[str, TrackState] = {}
_SLOTS = threading.Semaphore(MAX_PARALLEL)


def clear_states() -> None:
    """Сбрасывает in-memory статусы (тесты; кэш диска не трогает)."""
    with _LOCK:
        _TRACKS.clear()


def _sweep_locked(now: float) -> None:
    """Убирает истёкшие статусы (вызывается под ``_LOCK``)."""
    expired = [
        track_id
        for track_id, state in _TRACKS.items()
        if state.status != "running"
        and now - (state.finished_at or state.started_at) > TRACK_STATE_TTL_SEC
    ]
    for track_id in expired:
        _TRACKS.pop(track_id, None)


def _state_from_manifest(track_id: str, manifest: dict[str, Any]) -> TrackState:
    """Состояние succeeded из манифеста на диске (кэш-хит/восстановление)."""
    now = time.time()
    return TrackState(
        track_id=track_id,
        filename=str(manifest.get("filename") or ""),
        status="succeeded",
        stage="Готово",
        pct=1.0,
        message="Из дискового кэша",
        started_at=now,
        finished_at=now,
    )


def _emo_cache_valid(cfg: Settings, track_id: str) -> bool:
    """Кэш-хит по делу: в кэше лежит ``emo.json`` текущей версии контракта.

    Файлы кэшей переживают перезапуск и смену контракта, а ``parse_emo``
    отвергает старые версии (кадры v4 при контракте v5) — кэш с устаревшим
    либо битым ``emo.json`` считается промахом и честно пересчитывается
    (иначе трек навсегда остался бы без данных нового контракта).
    """
    blob = store.read_artifact(cfg, track_id, store.EMO_NAME)
    return blob is not None and emo_radar.parse_emo(blob) is not None


def start_analysis(
    blob: bytes, filename: str, cfg: Settings | None = None,
) -> tuple[str, bool]:
    """Возвращает ``(track_id, cached)``: запускает анализ либо отдаёт кэш.

    ``track_id`` — sha256 содержимого файла (хвост ``store.TRACK_ID_LEN``):
    повторное открытие того же трека возвращает тот же id и не пересчитывает.
    Порядок — как у рендера: кэш памяти → кэш диска → запуск фонового потока.
    Уже идущий анализ того же файла идемпотентен: второй поток не стартует.
    Устаревший кэш (нет ``emo.json`` текущей версии контракта, см.
    :func:`_emo_cache_valid`) — промах: тот же файл пересчитывается заново.
    """
    cfg = cfg or settings
    track_id = hashlib.sha256(blob).hexdigest()[: store.TRACK_ID_LEN]
    fresh = _emo_cache_valid(cfg, track_id)
    with _LOCK:
        _sweep_locked(time.time())
        state = _TRACKS.get(track_id)
        if state is not None and (state.status != "succeeded" or fresh):
            return track_id, state.status == "succeeded"
        if state is not None:
            # Устаревший кэш-хит в памяти (восстановлен из манифеста прошлой
            # версии контракта): убираем, ниже стартует честный пересчёт.
            _TRACKS.pop(track_id, None)
    manifest = store.load_manifest(cfg, track_id)
    cached_hit = manifest is not None and fresh
    state = (
        _state_from_manifest(track_id, manifest)
        if cached_hit and manifest is not None
        else TrackState(track_id=track_id, filename=filename)
    )
    with _LOCK:
        again = _TRACKS.get(track_id)
        if again is not None:  # параллельный запуск того же файла — не плодим
            return track_id, again.status == "succeeded"
        _TRACKS[track_id] = state
    if cached_hit:
        return track_id, True
    thread = threading.Thread(
        target=_run_analysis,
        args=(state, blob, cfg),
        name=f"emolab-{track_id}",
        daemon=True,
    )
    thread.start()
    return track_id, False


def _run_analysis(state: TrackState, blob: bytes, cfg: Settings) -> None:
    """Фоновый конвейер: декод → VAMP-карты → ФФТ-кадры → запись кэша."""
    with _SLOTS:
        try:
            state.stage, state.pct = "Декодирование аудио", 0.05
            audio = track_input.decode_track(blob)
            wav_blob = track_input.wav_bytes(audio)
            state.stage, state.pct = "Карта аккордов (VAMP)", 0.25
            key_track = vamp_analysis.key_track_from_wav(
                wav_blob, cfg, transform_name=vamp_analysis.KEY_TRANSFORM_NAME_32K,
            )
            state.stage, state.pct = "Карта темпа (VAMP)", 0.45
            tempo_track = vamp_analysis.tempo_track_from_wav(wav_blob, cfg)
            state.stage, state.pct = "Сегментер (VAMP)", 0.55
            segment_track = vamp_analysis.segment_track_from_wav(wav_blob, cfg)
            state.stage, state.pct = "ФФТ-кадры «Эмо»", 0.65
            payload = emo_radar.emo_frames(
                audio.data,
                fs=track_input.ANALYSIS_FS,
                key_track=key_track,
                tempo_track=tempo_track,
                segment_track=segment_track,
            )
            state.stage, state.pct = "Сохранение", 0.9
            files = {
                store.EMO_NAME: emo_radar.emo_bytes(payload),
                store.source_name(state.filename): blob,
            }
            manifest = {
                "format": store.TRACK_FORMAT_VERSION,
                "track_id": state.track_id,
                "filename": state.filename,
                "source": store.source_name(state.filename),
                "created_at": time.time(),
                "duration_s": round(audio.duration_s, 6),
                "fs_source": audio.fs_source,
                "fs_analysis": track_input.ANALYSIS_FS,
                "channels_source": audio.channels_source,
                "files": {name: len(data) for name, data in files.items()},
            }
            ok = store.write_track_files(cfg, state.track_id, files)
            ok = store.write_manifest(cfg, state.track_id, manifest) and ok
            if not ok:
                raise RuntimeError("Не удалось записать кэш анализа")
            store.sweep_tracks(cfg)
            state.status = "succeeded"
            state.stage = "Готово"
            state.pct = 1.0
            state.message = (
                f"Кадров: {payload['frame_count']}; "
                f"аккорды: {'есть' if key_track else 'нет'}; "
                f"темп: {'есть' if tempo_track else 'нет'}; "
                f"сегменты: {len(segment_track) if segment_track else 'нет'}"
            )
            state.finished_at = time.time()
        except Exception as exc:  # статус несёт ошибку клиенту, поток не падает
            state.status = "failed"
            state.error = str(exc)
            state.finished_at = time.time()
            logger.warning("Анализ трека %s не удался", state.track_id, exc_info=True)


def state_of(track_id: str, cfg: Settings | None = None) -> TrackState:
    """Состояние анализа; ``TrackNotFound`` — нет ни в памяти, ни в кэше диска.

    После рестарта сервера (или истечения TTL памяти) готовый анализ
    восстанавливается из манифеста на диске — результаты переживают процесс.
    """
    cfg = cfg or settings
    with _LOCK:
        _sweep_locked(time.time())
        state = _TRACKS.get(track_id)
    if state is not None:
        return state
    manifest = store.load_manifest(cfg, track_id)
    if manifest is None:
        raise TrackNotFound(track_id)
    state = _state_from_manifest(track_id, manifest)
    with _LOCK:
        _TRACKS[track_id] = state
    return state


def emo_payload_of(state: TrackState, cfg: Settings | None = None) -> dict[str, Any] | None:
    """Кадры «Эмо» готового анализа: ``emo.json`` кэша (``None`` — нет файла)."""
    cfg = cfg or settings
    blob = store.read_artifact(cfg, state.track_id, store.EMO_NAME)
    if blob is None:
        return None
    return emo_radar.parse_emo(blob)
