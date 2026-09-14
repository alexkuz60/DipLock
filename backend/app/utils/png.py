"""Минимальный PNG-энкодер: 8 бит, оттенки серого, опционально альфа.

Зачем свой: срезы МРТ рисуются в SVG как ``<image href="…png">``, то есть
картинкой. Браузер сам кэширует их по URL, а формат в нужной нам части прост
(сигнатура + IHDR + IDAT + IEND, фильтр строки 0, zlib). Тянуть ради этого
Pillow (новая зависимость в бэкенде) смысла нет — энкодер занимает 40 строк,
а корректность проверяется тестом-декодером (`tests/test_png.py`).

Формат среза — **серый + альфа**: вне маски мозга пиксель прозрачный, поэтому
фон фигуры просвечивает, а сам срез не «приклеен» к теме UI.
"""
import struct
import zlib
from typing import Optional

import numpy as np

# 8-байтовая сигнатура PNG (RFC 2083)
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

# Цветовой тип PNG: 0 — оттенки серого, 4 — серый + альфа
_COLOR_TYPE_GRAY = 0
_COLOR_TYPE_GRAY_ALPHA = 4

# Фильтр строки: 0 (None). Фильтрация не нужна — zlib сжимает сами данные,
# а платить за эвристики фильтров на 30-килобайтной картинке нечем.
_FILTER_NONE = 0


def _chunk(tag: bytes, payload: bytes) -> bytes:
    """Чанк PNG: длина, тег, данные и CRC32 по тегу с данными."""
    return b"".join((
        struct.pack(">I", len(payload)),
        tag,
        payload,
        struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF),
    ))


def encode_png_gray8(gray: np.ndarray, alpha: Optional[np.ndarray] = None) -> bytes:
    """PNG из массива ``uint8`` формы (height, width).

    :param gray: яркость 0…255, строки — сверху вниз.
    :param alpha: прозрачность 0…255 той же формы (0 — пиксель не рисуется);
        ``None`` — непрозрачная картинка (цветовой тип 0).
    :raises ValueError: если вход не ``uint8``, не двумерный или формы не совпали.
    """
    if gray.ndim != 2:
        raise ValueError(f"Ожидался двумерный массив, получено измерений: {gray.ndim}")
    if gray.dtype != np.uint8:
        raise ValueError(f"Ожидался uint8, получено: {gray.dtype}")
    if alpha is not None and alpha.shape != gray.shape:
        raise ValueError(
            f"Альфа и яркость должны совпадать по форме: {alpha.shape} != {gray.shape}"
        )

    height, width = int(gray.shape[0]), int(gray.shape[1])
    # Строка PNG = байт фильтра + пиксели; каналы чередуются **по пикселю**
    # (серый, альфа, серый, альфа…), а не идут двумя блоками: иначе декодер
    # прочитает пары «серый-серый» как один пиксель и картинка «раздвоится».
    if alpha is None:
        scanlines = np.zeros((height, 1 + width), dtype=np.uint8)
        scanlines[:, 1:] = gray
        color_type = _COLOR_TYPE_GRAY
    else:
        scanlines = np.zeros((height, 1 + width * 2), dtype=np.uint8)
        pixels = np.empty((height, width, 2), dtype=np.uint8)
        pixels[:, :, 0] = gray
        pixels[:, :, 1] = alpha
        scanlines[:, 1:] = pixels.reshape(height, width * 2)
        color_type = _COLOR_TYPE_GRAY_ALPHA

    ihdr = struct.pack(
        ">IIBBBBB", width, height, 8, color_type, 0, 0, 0,
    )
    raw = scanlines.tobytes()
    # level=6: картинки срезов отдаются многократно, но кэшируются на диске/в браузере,
    # поэтому выжимать 9-й уровень на каждый запрос не нужно.
    return b"".join((
        PNG_SIGNATURE,
        _chunk(b"IHDR", ihdr),
        _chunk(b"IDAT", zlib.compress(raw, 6)),
        _chunk(b"IEND", b""),
    ))