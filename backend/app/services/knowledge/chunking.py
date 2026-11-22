"""Нарезка разделов документа на фрагменты — единицы поиска и цитирования.

Фрагмент не пересекает границу раздела: заголовок и страница остаются
точными, а перекрытие держит контекст на стыке абзацев внутри раздела.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.services.knowledge.extract import Section


@dataclass(frozen=True)
class Chunk:
    """Фрагмент: порядковый номер, заголовок, страницы и текст."""

    ordinal: int
    heading: str | None
    page_from: int | None
    page_to: int | None
    text: str


def _split_text(text: str, size: int, overlap: int) -> list[str]:
    """Режет текст на куски по ``size`` символов с перекрытием ``overlap``.

    Границы по возможности ставятся на перевод строки или пробел: рвать слово
    пополам хуже, чем отступить на десяток символов.
    """
    if size <= 0:
        return [text]
    pieces: list[str] = []
    start = 0
    length = len(text)
    while start < length:
        end = min(start + size, length)
        if end < length:
            window = text.rfind("\n", start + size // 2, end)
            if window == -1:
                window = text.rfind(" ", start + size // 2, end)
            if window != -1:
                end = window
        piece = text[start:end].strip()
        if piece:
            pieces.append(piece)
        if end >= length:
            break
        start = max(end - overlap, start + 1)
    return pieces


def chunk_sections(
    sections: list[Section],
    *,
    size: int,
    overlap: int,
) -> list[Chunk]:
    """Фрагменты по разделам: пустые куски отбрасываются, номера сквозные."""
    chunks: list[Chunk] = []
    ordinal = 0
    for section in sections:
        for piece in _split_text(section.text, size, overlap):
            chunks.append(
                Chunk(
                    ordinal=ordinal,
                    heading=section.heading,
                    page_from=section.page,
                    page_to=section.page,
                    text=piece,
                ),
            )
            ordinal += 1
    return chunks
