"""Внешний аудиотрек «ЕмоЛаб»: приём wav/mp3 → моно-сигнал анализа 32000 Гц.

Постановка 20.10.2026 (шаг 1 и уточнение шага 2): пользователь открывает
внешний аудиофайл, и из него собираются данные прогноза эмоциональной
реакции. Здесь — только разбор файла: валидация (формат, длительность,
конечность отсчётов) и приведение к **моно-контракту анализа: 32000 Гц**
(решение владельца 20.10.2026, шаг 2): окно FFT 32768 со сдвигом 32000
сэмплов (перекрытие 768) даёт сетку кадров звезды **ровно 1 с**. Моно-файл
же уходит во временный WAV для VAMP (Sonic Annotator). Это **не** контракт
рендера «Нейромузыки» (мастер 48000 Гц, кадр 2/3 с): у разделов свои
частоты, математика кадров параметризована ``fs_audio``.

Ловушки:

* кодеки — через ``soundfile``/libsndfile (в окружении 1.2.2 читает WAV **и
  MP3** без внешних инструментов); битые байты и «не аудио» дают
  :class:`TrackInputError` (400 в API), а не 500;
* длинные файлы режутся до накопления буфера: :data:`MAX_DURATION_SEC` —
  защита памяти (200 МБ mp3 мог бы развернуться в гигабайты float64);
* каналов > 2 (5.1 и пр.) берутся первые два и сливается ``(L+R)/2`` — V-бабочку
  трекер рисует из ``File`` на клиенте, серверу каналы не нужны;
* ресемпл — ``resample_poly`` (kaiser), частота источника сохраняется в
  паспорте трека (``fs_source``) — при сравнении с ЭЭГ-сессией она нужна.
"""
import io
import math
from dataclasses import dataclass

import numpy as np
import soundfile as sf
from numpy.typing import NDArray
from scipy.signal import resample_poly

# Частота моно-файла анализа (шаг 2, решение владельца 20.10.2026): окно FFT
# 32768 и сдвиг 32000 сэмплов дают кадр звезды длиной ровно 1 с (32000/32000).
ANALYSIS_FS = 32000

# Потолок длительности трека, с (30 мин): дальше — отказ до чтения отсчётов.
MAX_DURATION_SEC = 1800.0

# Блок чтения soundfile (кадров): буферизация без загрузки файла целиком.
_READ_BLOCK = 1 << 20


class TrackInputError(ValueError):
    """Ошибка входного файла: текст показывается пользователю (400 в API)."""


@dataclass
class TrackAudio:
    """Нормализованный сигнал внешнего трека: **моно, 32000 Гц, float64**."""

    #: Отсчёты моно-сигнала (L+R)/2 после ресемпла в :data:`ANALYSIS_FS`
    data: NDArray[np.float64]
    #: Частота дискретизации исходного файла, Гц (паспорт трека)
    fs_source: int
    #: Число каналов исходного файла (паспорт трека)
    channels_source: int
    #: Длительность после ресемпла, с
    duration_s: float


def probe(blob: bytes) -> tuple[int, int, float]:
    """Дешёвый зонд файла: ``(fs, каналы, длительность_с)``.

    Читает только заголовок (``sf.info``) — быстрая синхронная валидация в
    роуте до запуска анализа. :class:`TrackInputError` — не аудио, пустой
    файл или трек длиннее :data:`MAX_DURATION_SEC`.
    """
    if not blob:
        raise TrackInputError("Файл пуст")
    try:
        info = sf.info(io.BytesIO(blob))
    except Exception as exc:  # LibsndfileError и пр. → честный 400
        raise TrackInputError(f"Не удалось прочитать аудиофайл: {exc}") from exc
    fs = int(info.samplerate)
    channels = int(info.channels)
    if fs <= 0 or channels <= 0 or info.frames <= 0:
        raise TrackInputError("В файле нет аудио-отсчётов")
    duration_s = float(info.frames) / fs
    if duration_s > MAX_DURATION_SEC:
        raise TrackInputError(
            f"Трек длиннее {MAX_DURATION_SEC / 60:.0f} мин — укоротите файл",
        )
    return fs, channels, duration_s


def decode_track(blob: bytes) -> TrackAudio:
    """Байты wav/mp3 → :class:`TrackAudio` (**моно, 32000 Гц**).

    :class:`TrackInputError` — не аудио, пусто, длиннее :data:`MAX_DURATION_SEC`
    либо содержит NaN/inf (битый декод).
    """
    fs, channels, _ = probe(blob)
    max_frames = int(MAX_DURATION_SEC * fs)
    try:
        with sf.SoundFile(io.BytesIO(blob)) as snd:
            blocks: list[NDArray[np.float64]] = []
            total = 0
            while True:
                block = snd.read(frames=_READ_BLOCK, dtype="float64", always_2d=True)
                if block.size == 0:
                    break
                total += block.shape[0]
                if total > max_frames:
                    raise TrackInputError(
                        f"Трек длиннее {MAX_DURATION_SEC / 60:.0f} мин — укоротите файл",
                    )
                blocks.append(block)
    except TrackInputError:
        raise
    except Exception as exc:
        raise TrackInputError(f"Не удалось прочитать аудиофайл: {exc}") from exc
    if not blocks:
        raise TrackInputError("В файле нет аудио-отсчётов")
    data = np.concatenate(blocks, axis=0)[:, :2]
    mono = data.mean(axis=1)  # (L+R)/2; у моно-исходника — та же дорожка
    if not np.isfinite(mono).all():
        raise TrackInputError("Отсчёты содержат NaN/inf — файл повреждён")
    if fs != ANALYSIS_FS:
        divisor = math.gcd(fs, ANALYSIS_FS)
        mono = resample_poly(mono, ANALYSIS_FS // divisor, fs // divisor)
    return TrackAudio(
        data=np.ascontiguousarray(mono, dtype=np.float64),
        fs_source=fs,
        channels_source=channels,
        duration_s=mono.shape[0] / ANALYSIS_FS,
    )


def wav_bytes(audio: TrackAudio) -> bytes:
    """WAV PCM_16 @32000 **моно** — временный файл входа VAMP (Sonic Annotator).

    Инструмент читает только файлы: ``vamp_analysis`` пишет байты во временный
    WAV, поэтому заранее кодируем в WAV в памяти (без временных файлов здесь).
    """
    buffer = io.BytesIO()
    sf.write(buffer, audio.data, ANALYSIS_FS, format="WAV", subtype="PCM_16")
    return buffer.getvalue()