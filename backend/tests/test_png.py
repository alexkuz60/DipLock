"""Тесты PNG-энкодера срезов МРТ (`app/utils/png.py`).

Проверка «своими руками»: тест разбирает PNG (сигнатура, чанки, CRC, zlib) и
сверяет распакованные строки с исходным массивом. Именно так ловится главная
ошибка формата — блочное расположение каналов вместо попиксельного: браузер в
этом случае рисует «раздвоенную» картинку, а не битый файл.
"""
import struct
import zlib

import numpy as np
import pytest

from app.utils.png import PNG_SIGNATURE, encode_png_gray8, encode_png_rgba8


def _decode_png(data: bytes) -> dict:
    """Разбирает PNG обратно в массив: (width, height, color_type, строки)."""
    assert data.startswith(PNG_SIGNATURE), "нет сигнатуры PNG"

    offset = len(PNG_SIGNATURE)
    chunks: dict[bytes, bytes] = {}
    while offset < len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        tag = data[offset + 4 : offset + 8]
        payload = data[offset + 8 : offset + 8 + length]
        crc = struct.unpack(">I", data[offset + 8 + length : offset + 12 + length])[0]
        assert crc == zlib.crc32(tag + payload) & 0xFFFFFFFF, f"CRC чанка {tag!r} не сходится"
        chunks[tag] = payload
        offset += 12 + length

    assert offset == len(data), "лишние байты после IEND"

    width, height, depth, color_type, _, _, _ = struct.unpack(">IIBBBBB", chunks[b"IHDR"])
    assert depth == 8
    raw = zlib.decompress(chunks[b"IDAT"])
    channels = {0: 1, 4: 2, 6: 4}.get(color_type)
    assert channels is not None, f"неожиданный цветовой тип PNG: {color_type}"
    stride = 1 + width * channels
    assert len(raw) == height * stride, "размер распакованных данных не совпал"

    rows = []
    for index in range(height):
        scanline = raw[index * stride : (index + 1) * stride]
        assert scanline[0] == 0, "ожидался фильтр строки 0 (None)"
        rows.append(np.frombuffer(scanline[1:], dtype=np.uint8).reshape(width, channels))
    return {
        "width": width,
        "height": height,
        "color_type": color_type,
        "pixels": np.stack(rows),
    }


def test_gray_png_roundtrip():
    """Серый PNG (без альфы) читается обратно байт в байт."""
    gray = np.arange(4 * 3, dtype=np.uint8).reshape(4, 3)

    decoded = _decode_png(encode_png_gray8(gray))

    assert decoded["color_type"] == 0
    assert (decoded["width"], decoded["height"]) == (3, 4)
    assert np.array_equal(decoded["pixels"][:, :, 0], gray)


def test_gray_alpha_channels_are_interleaved():
    """Каналы идут парами на пиксель: иначе картинка «раздваивается» при выводе."""
    gray = np.array([[10, 20, 30], [40, 50, 60]], dtype=np.uint8)
    alpha = np.array([[0, 255, 128], [7, 8, 9]], dtype=np.uint8)

    decoded = _decode_png(encode_png_gray8(gray, alpha))

    assert decoded["color_type"] == 4
    assert np.array_equal(decoded["pixels"][:, :, 0], gray), "яркость сдвинута"
    assert np.array_equal(decoded["pixels"][:, :, 1], alpha), "альфа сдвинута"


def test_rgba_png_roundtrip():
    """RGBA-топокарта читается обратно: цвет и альфа на своём месте."""
    rng = np.random.default_rng(3)
    rgba = rng.integers(0, 256, size=(5, 7, 4), dtype=np.uint8)

    decoded = _decode_png(encode_png_rgba8(rgba))

    assert decoded["color_type"] == 6
    assert (decoded["width"], decoded["height"]) == (7, 5)
    assert np.array_equal(decoded["pixels"], rgba), "каналы RGBA сдвинуты"


def test_rgba_channels_are_interleaved():
    """R, G, B, A идут по пикселю (не блоками) — иначе картинка «раздвоится»."""
    rgba = np.array(
        [[[1, 2, 3, 4], [5, 6, 7, 8]], [[9, 10, 11, 12], [13, 14, 15, 16]]],
        dtype=np.uint8,
    )

    pixels = _decode_png(encode_png_rgba8(rgba))["pixels"]

    for channel in range(4):
        assert np.array_equal(pixels[:, :, channel], rgba[:, :, channel]), f"канал {channel} сдвинут"


@pytest.mark.parametrize(
    "gray, alpha, message",
    [
        (np.zeros((2, 2, 2), dtype=np.uint8), None, "двумерный"),
        (np.zeros((2, 2), dtype=np.float32), None, "uint8"),
        (np.zeros((2, 2), dtype=np.uint8), np.zeros((3, 3), dtype=np.uint8), "форме"),
    ],
)
def test_invalid_input_raises(gray, alpha, message):
    """Некорректный вход — понятная ошибка, а не битый файл."""
    with pytest.raises(ValueError, match=message):
        encode_png_gray8(gray, alpha)


@pytest.mark.parametrize(
    "rgba, message",
    [
        (np.zeros((2, 2, 3), dtype=np.uint8), "форм"),
        (np.zeros((2, 2), dtype=np.uint8), "форм"),
        (np.zeros((2, 2, 4), dtype=np.float32), "uint8"),
    ],
)
def test_invalid_rgba_input_raises(rgba, message):
    """Некорректный RGBA-вход — понятная ошибка, а не битый файл."""
    with pytest.raises(ValueError, match=message):
        encode_png_rgba8(rgba)