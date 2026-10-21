"""HTTP-контракт «ЕмоЛаб» (шаг 1: анализ внешнего аудиотрека, 20.10.2026).

Роуты — только форма и контракт (правило `AGENTS.md`): приём файла — как у
EDF (``api/uploads.py``: санитизация имени, размер, sha256), работа —
``services/emolab/``. Паттерн — «Нейромузыка»: ``POST`` → 202 + отдельный GET
статуса/кадров; тяжёлые шаги идут в фоновом потоке сервиса, event loop не
блокируется.
"""
import asyncio
import os
import re
import shutil

from fastapi import APIRouter, File, HTTPException, UploadFile

from app.api.private import PrivateRoute
from app.api.uploads import save_upload
from app.core.config import settings
from app.schemas.audio import AudioEmoOut
from app.schemas.emolab import EmoAnalyzeOut, EmoTrackStatus
from app.services.emolab import store as emolab_store
from app.services.emolab import track_analysis, track_input
from app.services.emolab.track_analysis import TrackNotFound
from app.services.emolab.track_input import TrackInputError

router = APIRouter(prefix="/emolab", tags=["ЕмоЛаб"], route_class=PrivateRoute)

# Имя загрузки: как safe_edf_name (F10), но под аудио-расширения.
_UNSAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._+-]+")
_MAX_NAME_LEN = 128


def safe_audio_name(filename: str | None) -> str:
    """Санитизация имени аудиозагрузки (по образцу ``safe_edf_name``, F10).

    Отбрасывает каталоги (в т.ч. ``../`` и Windows-пути), заменяет
    небезопасные символы, требует суффикс ``.wav`` либо ``.mp3``.
    """
    raw_name = (filename or "").replace("\\", "/").strip()
    base = os.path.basename(raw_name) or "track.wav"
    base = _UNSAFE_NAME_RE.sub("_", base)[:_MAX_NAME_LEN]
    if not base.lower().endswith((".wav", ".mp3")):
        raise HTTPException(
            status_code=400, detail="Поддерживаются только файлы .wav и .mp3",
        )
    return base


def _read_file(path: str) -> bytes:
    """Байты загруженного файла (дисковое чтение — вне event loop)."""
    with open(path, "rb") as handle:
        return handle.read()


async def _track_state(track_id: str) -> track_analysis.TrackState:
    """Состояние трека; 404 — нет ни в памяти, ни в дисковом кэше."""
    try:
        return await asyncio.to_thread(track_analysis.state_of, track_id, settings)
    except TrackNotFound as exc:
        raise HTTPException(
            status_code=404,
            detail=f"Трек {track_id} не найден (нет в памяти и дисковом кэше)",
        ) from exc


@router.post(
    "/analyze",
    status_code=202,
    response_model=EmoAnalyzeOut,
    summary="Запустить анализ внешнего аудиотрека (wav/mp3) для прогноза эмо-реакции",
)
async def analyze_audio_track(file: UploadFile = File(...)) -> EmoAnalyzeOut:
    """Приём внешнего аудиофайла и запуск его анализа (шаг 1 «ЕмоЛаб»).

    Из файла собираются данные прогноза: ФФТ-кадры «Эмо» (7 лучей полигона,
    сетка 2/3 с) и карты темпа/аккордов VAMP (Соник Аннотатор) — контракт
    ``GET /emolab/{track_id}/emo``. Повторная загрузка того же содержимого
    (sha256) не пересчитывает: ответ сразу ``status=succeeded, cached=true``.
    400 — не wav/mp3, битый файл либо трек длиннее 30 мин; 413 — файл больше
    лимита загрузки.
    """
    safe_name = safe_audio_name(file.filename)
    tmp_path, upload_dir, _digest = await save_upload(file, safe_name)
    try:
        blob = await asyncio.to_thread(_read_file, tmp_path)
    finally:
        shutil.rmtree(upload_dir, ignore_errors=True)
    try:
        _fs, _channels, duration_s = await asyncio.to_thread(track_input.probe, blob)
    except TrackInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    track_id, cached = await asyncio.to_thread(
        track_analysis.start_analysis, blob, safe_name, settings,
    )
    return EmoAnalyzeOut(
        track_id=track_id,
        status="succeeded" if cached else "running",
        cached=cached,
        filename=safe_name,
        duration_s=duration_s,
    )


@router.get(
    "/{track_id}/status",
    response_model=EmoTrackStatus,
    summary="Статус анализа аудиотрека (проценты и шаг, поллинг UI)",
)
async def emolab_track_status(track_id: str) -> EmoTrackStatus:
    """Статус анализа: running (pct 0..1 + шаг) / succeeded / failed (404 — нет)."""
    state = await _track_state(track_id)
    duration_s: float | None = None
    if state.status == "succeeded":
        manifest = await asyncio.to_thread(emolab_store.load_manifest, settings, track_id)
        if manifest is not None:
            duration_s = float(manifest.get("duration_s") or 0.0) or None
    return EmoTrackStatus(
        track_id=state.track_id,
        status=state.status,
        stage=state.stage,
        pct=state.pct,
        message=state.message,
        error=state.error,
        filename=state.filename,
        duration_s=duration_s,
    )


@router.get(
    "/{track_id}/emo",
    response_model=AudioEmoOut,
    summary="Кадры радара «Эмо» аудиотрека: 7 лучей + карты темпа/аккордов",
)
async def emolab_track_emo(track_id: str) -> AudioEmoOut:
    """Кадры анимации звезды-полигона (контракт рендера «Нейромузыки», v5).

    Окно FFT 32768 (2^15), сдвиг 32000 сэмплов (перекрытие 768): кадр k ↔
    время k · 2/3 с; лучи — децибельная шкала громкости (``db_relative``,
    ``db_floor`` −60 дБ). ``key_track`` — карта аккордов (VAMP Key Detector)
    для вращения звезды, ``tempo_track`` — карта темпа (VAMP Tempo and Beat
    Tracker) для темп-коррекции лучей; ``segment_track`` — сегменты трека
    (VAMP Segmenter) для визуально-слухового контроля (таблица «Опций» и
    линии с метками имён A, B, C…); ``null`` — инструмент недоступен
    (best-effort, вращение/коррекция в UI нулевые, сегментов нет).

    404 — трек не найден, 409 — анализ ещё идёт либо не удался.
    """
    state = await _track_state(track_id)
    if state.status == "running":
        raise HTTPException(
            status_code=409, detail=f"Анализ ещё идёт: {state.stage} ({state.pct:.0%})",
        )
    if state.status == "failed":
        raise HTTPException(status_code=409, detail=f"Анализ не удался: {state.error}")
    payload = await asyncio.to_thread(track_analysis.emo_payload_of, state, settings)
    if payload is None:
        raise HTTPException(
            status_code=409,
            detail="Кадры «Эмо» недоступны: в кэше трека нет emo.json",
        )
    return AudioEmoOut.model_validate(payload)
