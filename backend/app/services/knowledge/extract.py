"""Извлечение текста из документов библиотеки знаний.

Поддержаны PDF с текстовым слоем (``pypdf``), DOCX (``python-docx``), XLSX
(``openpyxl``), изображения (текста нет — документ сохраняется как картинка,
``status="empty"``) и веб-страницы (``httpx`` + stdlib ``HTMLParser``).
Сканы без текстового слоя OCR не проходят — это честный ``empty``, а не
пустая строка в поиске.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path

import httpx

# Расширения → вид документа. Вид хранится в БД и определяет иконку и разбор.
_KIND_BY_SUFFIX = {
    ".pdf": "pdf",
    ".docx": "docx",
    ".doc": "docx",
    ".xlsx": "xlsx",
    ".xls": "xlsx",
    ".csv": "xlsx",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".webp": "image",
    ".gif": "image",
    ".bmp": "image",
    ".tif": "image",
    ".tiff": "image",
    ".txt": "text",
    ".md": "text",
}

# Строка похожа на заголовок: короткая, без точки в конце, нумерованная или
# капсом. Эвристика нужна для PDF, где стилей заголовков нет.
_HEADING_MAX_CHARS = 120
_NUMBERED = re.compile(r"^\s*(?:глава|chapter|раздел|section|part|часть)?\s*\d+(?:\.\d+)*[.)]?\s+\S", re.I)


@dataclass(frozen=True)
class Section:
    """Раздел документа: заголовок, страница и текст."""

    heading: str | None
    page: int | None
    text: str


@dataclass
class ExtractResult:
    """Результат разбора: разделы, число страниц и предупреждения."""

    sections: list[Section] = field(default_factory=list)
    pages: int | None = None
    warnings: list[str] = field(default_factory=list)

    @property
    def text_chars(self) -> int:
        """Суммарная длина извлечённого текста."""
        return sum(len(section.text) for section in self.sections)


def detect_kind(filename: str) -> str:
    """Вид документа по расширению; неизвестное — ``text``."""
    return _KIND_BY_SUFFIX.get(Path(filename).suffix.lower(), "text")


def _looks_like_heading(line: str) -> bool:
    """Эвристика заголовка для PDF без стилей: короткая строка без точки."""
    text = line.strip()
    if not text or len(text) > _HEADING_MAX_CHARS:
        return False
    if text.endswith((".", ",", ";", ":")) and not _NUMBERED.match(text):
        return False
    if _NUMBERED.match(text):
        return True
    letters = [ch for ch in text if ch.isalpha()]
    return bool(letters) and all(ch.isupper() for ch in letters) and len(letters) >= 3


def _split_pdf_page(page: int | None, text: str) -> list[Section]:
    """Делит текст страницы на разделы по эвристике заголовков.

    Заголовок — короткая строка без точки в конце, за которой идёт пустая
    строка (обычная разметка текста и Markdown), либо нумерованная строка,
    либо строка капсом.
    """
    sections: list[Section] = []
    heading: str | None = None
    buffer: list[str] = []
    lines = text.splitlines()

    def flush() -> None:
        body = "\n".join(buffer).strip()
        if body:
            sections.append(Section(heading=heading, page=page, text=body))

    for index, line in enumerate(lines):
        stripped = line.strip()
        next_blank = index + 1 >= len(lines) or not lines[index + 1].strip()
        is_heading = _looks_like_heading(line) or (
            stripped
            and len(stripped) <= 80
            and next_blank
            and not stripped.endswith((".", ",", ";", ":", "!", "?"))
            and len(stripped.split()) <= 10
        )
        if is_heading:
            flush()
            buffer.clear()
            heading = stripped
        else:
            buffer.append(line)
    flush()
    return sections


def extract_pdf(path: Path) -> ExtractResult:
    """Текст PDF постранично; пустой текстовый слой — предупреждение."""
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    result = ExtractResult(pages=len(reader.pages))
    for number, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception as exc:
            result.warnings.append(f"Страница {number}: текст не извлечён ({exc})")
            continue
        result.sections.extend(_split_pdf_page(number, text))
    if not result.sections:
        result.warnings.append("Текстовый слой не найден: скан без OCR не индексируется")
    return result


def extract_docx(path: Path) -> ExtractResult:
    """Абзацы DOCX с заголовками по стилям ``Heading N``."""
    from docx import Document

    document = Document(str(path))
    result = ExtractResult()
    heading: str | None = None
    buffer: list[str] = []

    def flush() -> None:
        body = "\n".join(buffer).strip()
        if body:
            result.sections.append(Section(heading=heading, page=None, text=body))

    for paragraph in document.paragraphs:
        text = paragraph.text.strip()
        if not text:
            continue
        style = (paragraph.style.name if paragraph.style is not None else "") or ""
        if style.lower().startswith("heading") or style.lower() == "title":
            flush()
            buffer.clear()
            heading = text
        else:
            buffer.append(text)
    flush()
    if not result.sections:
        result.warnings.append("В документе нет текста")
    return result


def extract_xlsx(path: Path) -> ExtractResult:
    """Листы XLSX как разделы: строки через табуляцию."""
    from openpyxl import load_workbook

    workbook = load_workbook(str(path), read_only=True, data_only=True)
    result = ExtractResult()
    try:
        for sheet in workbook.worksheets:
            rows: list[str] = []
            for row in sheet.iter_rows(values_only=True):
                cells = ["" if value is None else str(value) for value in row]
                if any(cell.strip() for cell in cells):
                    rows.append("\t".join(cells).rstrip())
            if rows:
                result.sections.append(
                    Section(heading=sheet.title, page=None, text="\n".join(rows)),
                )
    finally:
        workbook.close()
    if not result.sections:
        result.warnings.append("В таблице нет непустых ячеек")
    return result


def extract_text_file(path: Path) -> ExtractResult:
    """Плоский текст или Markdown: разделы по эвристике заголовков."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return ExtractResult(warnings=[f"Файл не прочитан: {exc}"])
    if not text.strip():
        return ExtractResult(warnings=["Файл пуст"])
    return ExtractResult(sections=_split_pdf_page(0, text))


def extract_image(path: Path) -> ExtractResult:
    """Изображение: текста нет, документ хранится как картинка."""
    return ExtractResult(
        warnings=["Изображение сохранено без текста: OCR не подключён"],
    )


class _HtmlText(HTMLParser):
    """Сбор текста HTML с заголовками ``h1``–``h6`` и пропуском скриптов."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.sections: list[Section] = []
        self._heading: str | None = None
        self._buffer: list[str] = []
        self._heading_buffer: list[str] | None = None
        self._skip = 0
        self.title: str | None = None
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript"}:
            self._skip += 1
        elif tag == "title":
            self._in_title = True
        elif tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._flush()
            self._heading_buffer = []
        elif tag in {"p", "div", "br", "li", "tr"}:
            self._buffer.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript"} and self._skip:
            self._skip -= 1
        elif tag == "title":
            self._in_title = False
        elif tag in {"h1", "h2", "h3", "h4", "h5", "h6"} and self._heading_buffer is not None:
            heading = " ".join("".join(self._heading_buffer).split())
            self._heading_buffer = None
            if heading:
                self._heading = heading

    def handle_data(self, data: str) -> None:
        if self._skip:
            return
        if self._in_title:
            self.title = (self.title or "") + data
            return
        if self._heading_buffer is not None:
            self._heading_buffer.append(data)
        else:
            self._buffer.append(data)

    def _flush(self) -> None:
        body = " ".join("".join(self._buffer).split())
        if body:
            self.sections.append(Section(heading=self._heading, page=None, text=body))
        self._buffer = []

    def close(self) -> None:
        super().close()
        self._flush()


def extract_web(url: str, *, client: httpx.Client | None = None) -> tuple[ExtractResult, str | None]:
    """Текст веб-страницы: разделы по заголовкам, заголовок страницы отдельно."""
    own = client is None
    http = client or httpx.Client(timeout=20.0, follow_redirects=True)
    try:
        response = http.get(url, headers={"User-Agent": "DipLock/0.1 (+knowledge)"})
        response.raise_for_status()
        content_type = response.headers.get("content-type", "")
        if "html" not in content_type and "text" not in content_type:
            return ExtractResult(warnings=[f"Не текстовая страница: {content_type}"]), None
        parser = _HtmlText()
        parser.feed(response.text)
        parser.close()
        title = " ".join((parser.title or "").split()) or None
        result = ExtractResult(sections=parser.sections)
        if not result.sections:
            result.warnings.append("На странице не найден текст")
        return result, title
    finally:
        if own:
            http.close()


def extract(path: Path, kind: str) -> ExtractResult:
    """Разбор по виду документа; неизвестный вид — плоский текст."""
    if kind == "pdf":
        return extract_pdf(path)
    if kind == "docx":
        return extract_docx(path)
    if kind == "xlsx":
        return extract_xlsx(path)
    if kind == "image":
        return extract_image(path)
    return extract_text_file(path)
