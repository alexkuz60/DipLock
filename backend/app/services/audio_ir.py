"""Импульсные характеристики (IR) для свёрточной реверберации «Нейромузыки».

Генерация IR помещений лежит в Python по вердикту `docs/rules/spatial-audio.md`
(06.10.2026): браузер даёт real-time эксперимент, но акустику помещения честнее
считать офлайн — `pyroomacoustics` (image source model) детерминирован и быстр
(замер 06.10.2026: 4–11 мс на пресет). Результат — стерео-IR WAV 48 кГц/PCM_24
(переиспользуем ``wav_bytes`` рендера: тот же детерминизм «одинаковые входы →
одинаковые байты») в дисковом кэше ``cache_dir/ir/``; отдаётся ассетом с ETag.

Роль Python по вердикту — **только ассеты и печать**: в real-time цепочку
плеера IR попадает готовым файлом через ``Convolver`` Tone.js.
"""
import hashlib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from app.core.config import settings
from app.services.audio_render.export import wav_bytes
from app.services.cache_store import cache_path, cache_read, cache_write

# Частота IR совпадает с частотой рендера (48 кГц): ConvolverNode сам ресемплирует,
# но единая частота убивает лишний шаг при прослушивании.
_IR_FS = 48000
# Потолок пика IR: pyroomacoustics даёт пики и >1 (короткие комнаты: замер
# «cranium» — 15.5), а PCM_24 не клипчит — нормируем к тому же запасу, что и
# мастер рендера, до записи.
_IR_PEAK = 0.891
# База стерео-микрофонов (межушное расстояние): IR стерео, L/R декоррелированы.
_MIC_SPACING_M = 0.17


@dataclass(frozen=True)
class IrPreset:
    """Один пресет комнаты: коробка (dims), поглощение, порядок отражений."""

    id: str
    label: str
    description: str
    dims_m: tuple[float, float, float]
    absorption: float
    max_order: int
    source_m: tuple[float, float, float]
    mic_m: tuple[float, float, float]
    tags: tuple[str, ...] = field(default=(), compare=False)


# Пресеты фиксированы (параметры — часть контракта UI): смена любого параметра
# меняет байты → другой sha256 → другой ETag, старые файлы в кэше невалидны
# по версии (ETag от байтов).
IR_PRESETS: tuple[IrPreset, ...] = (
    IrPreset(
        id="room_small",
        label="Комната малая",
        description="Комната 3.6×3.2×2.5 м, умеренное поглощение — близкий «кабинетный» ревер",
        dims_m=(3.6, 3.2, 2.5),
        absorption=0.35,
        max_order=12,
        source_m=(1.1, 1.3, 1.6),
        mic_m=(1.8, 1.6, 1.5),
        tags=("комната",),
    ),
    IrPreset(
        id="room_large",
        label="Зал большой",
        description="Зал 12×9×4 м, слабое поглощение — длинная хвостовая реверберация",
        dims_m=(12.0, 9.0, 4.0),
        absorption=0.25,
        max_order=16,
        source_m=(3.0, 2.5, 1.7),
        mic_m=(7.0, 5.0, 1.6),
        tags=("зал",),
    ),
    IrPreset(
        id="cranium",
        label="Свод черепа (прокси)",
        description=(
            "Коробка 18×16×14 см, высокое отражение стен — экспериментальный прокси "
            "внутричерепной акустики (задел `intracranial_ir` из sidecar)"
        ),
        dims_m=(0.18, 0.16, 0.14),
        absorption=0.15,
        max_order=12,
        source_m=(0.05, 0.05, 0.05),
        mic_m=(0.09, 0.08, 0.07),
        tags=("эксперимент",),
    ),
)

_PRESETS_BY_ID = {preset.id: preset for preset in IR_PRESETS}


def generate_ir(preset: IrPreset) -> bytes:
    """Генерирует стерео-IR одного пресета → байты WAV PCM_24 @48000.

    Image source model (``pyroomacoustics.ShoeBox.compute_rir``) детерминирован:
    одинаковые параметры → одинаковые байты (замер/повтор 06.10.2026 —
    идентичный sha256). Два микрофона с базой ``_MIC_SPACING_M`` дают стерео с
    разными путями до L/R — вход для ``Convolver``.
    """
    import pyroomacoustics as pra

    room = pra.ShoeBox(
        list(preset.dims_m),
        fs=_IR_FS,
        max_order=preset.max_order,
        materials=pra.Material(preset.absorption),
    )
    room.add_source(list(preset.source_m))
    x, y, z = preset.mic_m
    room.add_microphone_array(
        np.array(
            [
                [x - _MIC_SPACING_M / 2, x + _MIC_SPACING_M / 2],
                [y, y],
                [z, z],
            ]
        )
    )
    room.compute_rir()

    left = np.asarray(room.rir[0][0], dtype=np.float64)
    right = np.asarray(room.rir[1][0], dtype=np.float64)
    length = max(len(left), len(right))
    stereo = np.zeros((length, 2), dtype=np.float64)
    stereo[: len(left), 0] = left
    stereo[: len(right), 1] = right

    # Нормировка пика (короткие комнаты дают пик >> 1) + защита от NaN/inf
    # на входе в конвертер — как в ядре рендера, пакет чистится сразу.
    if not np.isfinite(stereo).all():
        raise ValueError(f"IR {preset.id}: не-конечные значения после генерации")
    peak = float(np.abs(stereo).max())
    if peak > 0:
        stereo *= _IR_PEAK / peak
    return wav_bytes(stereo, fs=_IR_FS)


def ir_path(preset_id: str) -> str:
    """Путь файла IR в кэше (``cache_dir/ir/{id}.wav``)."""
    return cache_path(settings.cache_dir, "ir", f"{preset_id}.wav")


def ir_bytes(preset_id: str) -> bytes:
    """IR пресета: чтение кэша, при промахе — генерация и запись в кэш.

    Кэш — оптимизация, а не источник истины (правило `cache_store`): сбой записи
    не ломает ответ, следующий запрос пересчитает.
    """
    path = ir_path(preset_id)
    cached = cache_read(path)
    if cached is not None:
        return cached
    data = generate_ir(_PRESETS_BY_ID[preset_id])
    cache_write(path, data, label="Кэш IR нейромузыки")
    return data


def ir_version(data: bytes) -> str:
    """Версия ассета для ETag — отпечаток самих байтов.

    Генерация детерминирована, поэтому тег стабилен между перезапусками; смена
    параметров пресета меняет байты → тег меняется (инвалидация старых файлов).
    """
    return hashlib.sha256(data).hexdigest()[:16]


def warm_cache() -> list[str]:
    """Генерирует все пресеты в кэш (скрипт прогрева); возвращает id."""
    for preset in IR_PRESETS:
        ir_bytes(preset.id)
    return preset_ids()


def cache_dir() -> Path:
    """Каталог кэша IR (для скрипта прогрева и диагностики)."""
    return Path(settings.cache_dir) / "ir"


def preset_ids() -> list[str]:
    """Валидные id пресетов (для 404 и селекта UI)."""
    return list(_PRESETS_BY_ID)


def get_preset(preset_id: str) -> IrPreset | None:
    """Пресет по id; ``None`` — неизвестный id (404)."""
    return _PRESETS_BY_ID.get(preset_id)
