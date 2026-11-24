"""Экспорт рендера «Нейромузыки»: WAV 48 кГц/PCM_16 и sidecar-«партитура».

Детерминизм (ТЗ §3): при одинаковых входах байты WAV идентичны — в файле нет
времени/случайности, float → int16 происходит только в момент записи.
Сторонние аудио-библиотеки обработки (librosa/rubberband/pydub) не используются:
только запись файла ``soundfile`` (libsndfile).
"""
import hashlib
import io
import json
from typing import Any

import numpy as np
import soundfile as sf

from app.services.audio_render.core import FS_AUDIO

# Версия контракта sidecar (ТЗ §6): поле schema_version, расширение по
# semver-логике «новые ключи — minor, ломающие — major». 2 — ключ ``rows``
# упразднён («Монтаж» — дипольный рендер, срез 19.11.2026), траектории
# диполей рендера легли в ``extensions.dipoles``.
SIDECAR_SCHEMA_VERSION = 2


def wav_bytes(data: np.ndarray, fs: int = FS_AUDIO, subtype: str = "PCM_16") -> bytes:
    """Стерео float → байты WAV @48000 (конвертация только при записи).

    PCM_16 вместо PCM_24 (политика 24.11.2026): диск рендера −33 % при
    динамическом диапазоне 96 дБ — для нормализованного по RMS микса с
    потолком −1 dBFS этого достаточно. Версия формата кэша поднята
    (``store.RENDER_FORMAT_VERSION``), старые комплекты пересчитываются.

    ``subtype`` — исключение для IR-ассетов: они кэшируются по пресету
    (``audio_ir``), остаются PCM_24 и не инвалидируют свой кэш.
    """
    payload = np.ascontiguousarray(data, dtype=np.float32)
    buffer = io.BytesIO()
    sf.write(buffer, payload, int(fs), subtype=subtype, format="WAV")
    return buffer.getvalue()


def input_checksum(packages: dict[str, np.ndarray]) -> str:
    """sha256 по float64-байтам полосовых пакетов — отпечаток входа рендера."""
    digest = hashlib.sha256()
    for band in sorted(packages):
        digest.update(band.encode("utf-8"))
        digest.update(np.ascontiguousarray(packages[band], dtype=np.float64).tobytes())
    return digest.hexdigest()


def sidecar_bytes(sidecar: dict[str, Any]) -> bytes:
    """Sidecar «партитура» → UTF-8 JSON (стабильный порядок ключей)."""
    text = json.dumps(sidecar, ensure_ascii=False, indent=2, sort_keys=True)
    return (text + "\n").encode("utf-8")


def build_sidecar(
    *,
    duration_s: float,
    channels: list[str],
    bands: list[dict[str, Any]],
    checksum: str,
    gains_db: dict[str, float],
    boost_db: float,
    loudness: dict[str, Any] | None,
    warnings: list[str],
    clean_label: str,
    interpolated: list[str],
    notch_hz: float,
    notch_harmonics: int,
    groups: dict[str, list[str]] | None = None,
    octave_shift: int = 7,
    variant: str = "express",
    dipole: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Собирает sidecar по схеме ТЗ §6 (+ детали эксперимента для воспроизводимости).

    ``octave_shift`` — число октав транспонирования рендера (5/6/7, дефолт 7):
    ключи схемы не меняются, поэтому ``schema_version`` остаётся прежним —
    меняются только значения ``octave_shift``/``pitch_factor``.

    ``variant`` — вариант рендера («Экспресс»/«Монтаж»); ``dipole`` — блок
    дипольной сцены «Монтажа» (``extensions.dipoles``: траектории диполей,
    стереобазы полос, границы глубины — «Диполи»), для «Экспресса» ``None``.
    Ключ ``rows`` (ряды 4×7) упразднён схемой 2 (срез 19.11.2026).
    """
    return {
        "schema_version": SIDECAR_SCHEMA_VERSION,
        "variant": variant,
        "fs_eeg": 500,
        "fs_audio": FS_AUDIO,
        "octave_shift": int(octave_shift),
        "pitch_factor": 2 ** int(octave_shift),
        "duration_s": round(float(duration_s), 6),
        "bands": bands,
        "channel_order": list(channels),
        "busses": {name: list(members) for name, members in (groups or {}).items()},
        "input_checksum_sha256": checksum,
        "gains_db": {name: float(value) for name, value in sorted(gains_db.items())},
        "boost_db": float(boost_db),
        "loudness": loudness,
        "clean": clean_label,
        "interpolated_channels": list(interpolated),
        "notch_hz": notch_hz,
        "notch_harmonics": int(notch_harmonics),
        "reference": "none",
        "warnings": list(warnings),
        "extensions": {"dipoles": dipole, "intracranial_ir": None, "doppler": None},
    }
