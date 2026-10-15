"""Стражи документации (Шаг 1 сводного аудита, 15.10.2026).

Дисциплина, которая раньше держалась «по памяти», теперь проверяется автоматически
(правила `docs/rules/docs.md`): размер `AGENTS.md` (п.1), отсутствие закрытого
в `todo.md` (п.8) и существование файлов карты документации (п.7).
"""
import re
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_AGENTS_MD = _REPO / "AGENTS.md"
_TODO_MD = _REPO / "todo.md"

# Правило docs/rules/docs.md: AGENTS.md — вход агента, ≤15 КБ; размер — часть контракта.
_AGENTS_MAX_BYTES = 15 * 1024
# Раздел карты документации: его таблица — единственный источник ссылок на файлы.
_DOC_MAP_HEADING = "## Карта документации"
_PATH_TOKEN = re.compile(r"`([^`]+)`")


def test_agents_md_within_size_budget() -> None:
    """AGENTS.md не выходит за лимит 15 КБ (контракт размера входного файла)."""
    assert _AGENTS_MD.is_file(), "нет AGENTS.md"
    size = _AGENTS_MD.stat().st_size
    assert size <= _AGENTS_MAX_BYTES, (
        f"AGENTS.md занимает {size} байт при лимите {_AGENTS_MAX_BYTES}: "
        "перенесите детали в docs/rules/* (docs/rules/docs.md п.1)"
    )


def test_todo_md_has_no_closed_markers() -> None:
    """В todo.md не остаётся маркеров «ЗАКРЫТ»: они переносятся в docs/history.md."""
    assert _TODO_MD.is_file(), "нет todo.md"
    text = _TODO_MD.read_text(encoding="utf-8")
    offenders = [line.strip() for line in text.splitlines() if "ЗАКРЫТ" in line]
    assert not offenders, (
        "закрытое не перенесено в docs/history.md (docs/rules/docs.md п.8): "
        + " | ".join(offenders[:3])
    )


def test_doc_map_links_exist() -> None:
    """Файлы карты документации AGENTS.md существуют (docs/rules/docs.md п.7)."""
    text = _AGENTS_MD.read_text(encoding="utf-8")
    lines = text.splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if line.startswith(_DOC_MAP_HEADING))
    except StopIteration:
        raise AssertionError(f"в AGENTS.md нет раздела «{_DOC_MAP_HEADING}»") from None
    missing: list[str] = []
    for line in lines[start + 1 :]:
        if line.startswith("## "):
            break
        if not line.startswith("|"):
            continue
        cell = line.split("|")[1]  # первая колонка — «куда смотреть»
        for token in _PATH_TOKEN.findall(cell):
            if "*" in token:
                if not list(_REPO.glob(token)):
                    missing.append(token)
            elif not (_REPO / token).exists():
                missing.append(token)
    assert not missing, f"битые ссылки карты документации AGENTS.md: {missing}"
