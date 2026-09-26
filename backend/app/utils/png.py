"""Минимальный PNG-энкодер: 8 бит, серый (+альфа) и RGBA.

Зачем свой: срезы МРТ рисуются в SVG как ``<image href="…png">``, то есть
картинкой. Браузер сам кэширует их по URL, а формат в нужной нам части прост
(сигнатура + IHDR + IDAT + IEND, фильтр строки 0, zlib). Тянуть ради этого
Pillow (новая зависимость в бэкенде) смысла нет — энкодер занимает строки,
а корректность проверяется тестом-декодером (`tests/test_png.py`).

Два формата: **серый + альфа** — срезы МРТ (вне маски мозга пиксель
прозрачный, фон фигуры просвечивает), **RGBA** — топокарты (`app/services/spectral.py`): цвет там делает matplotlib
(палитра MNE), а пишется он здесь.
"""
import struct
import zlib

import numpy as np

# 8-байтовая сигнатура PNG (RFC 2083)
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

# Цветовой тип PNG: 0 — оттенки серого, 4 — серый + альфа, 6 — RGBA
_COLOR_TYPE_GRAY = 0
_COLOR_TYPE_GRAY_ALPHA = 4
_COLOR_TYPE_RGBA = 6

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


def encode_png_gray8(gray: np.ndarray, alpha: np.ndarray | None = None) -> bytes:
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

    return _png_bytes(width, height, color_type, scanlines)


def encode_png_rgba8(rgba: np.ndarray) -> bytes:
    """PNG из массива ``uint8`` формы (height, width, 4): цвет и альфа по пикселю.

    Нужен топокартам: цвет считает matplotlib (палитра ``mne.viz.plot_topomap``),
    а отдаётся картинка тем же форматом «сигнатура + IHDR + IDAT + IEND», что и
    срезы, — Pillow не нужен. Каналы чередуются **по пикселю** (R, G, B, A, …).

    :param rgba: цвета 0…255, строки — сверху вниз, последняя ось — R, G, B, A.
    :raises ValueError: если вход не ``uint8`` или форма не (height, width, 4).
    """
    if rgba.ndim != 3 or rgba.shape[2] != 4:
        raise ValueError(
            f"Ожидался массив формы (height, width, 4), получено: {rgba.shape}"
        )
    if rgba.dtype != np.uint8:
        raise ValueError(f"Ожидался uint8, получено: {rgba.dtype}")

    height, width = int(rgba.shape[0]), int(rgba.shape[1])
    scanlines = np.zeros((height, 1 + width * 4), dtype=np.uint8)
    scanlines[:, 1:] = rgba.reshape(height, width * 4)
    return _png_bytes(width, height, _COLOR_TYPE_RGBA, scanlines)


def _png_bytes(width: int, height: int, color_type: int, scanlines: np.ndarray) -> bytes:
    """Собирает PNG: IHDR + IDAT + IEND; ``scanlines`` — строки с байтом фильтра."""
    ihdr = struct.pack(
        ">IIBBBBB", width, height, 8, color_type, 0, 0, 0,
    )
    raw = scanlines.tobytes()
    # level=6: картинки отдаются многократно, но кэшируются на диске/в браузере,
    # поэтому выжимать 9-й уровень на каждый запрос не нужно.
    return b"".join((
        PNG_SIGNATURE,
        _chunk(b"IHDR", ihdr),
        _chunk(b"IDAT", zlib.compress(raw, 6)),
        _chunk(b"IEND", b""),
    ))