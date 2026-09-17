"""Тесты единого модуля кэша (A3): путь, чтение, атомарная запись, очистка.

До этапа 2 эту логику повторяли шесть сервисов, и копии расходились. Здесь
фиксируются два свойства, ради которых модуль и появился: сбой записи не
бросает исключение и не оставляет обломков, а очистка ограничена своим
подкаталогом (никаких «rmtree всего кэша» из-за опечатки).
"""
import os

import pytest

from app.services.cache_store import cache_clear, cache_path, cache_read, cache_write


def test_cache_path_lives_under_cache_dir(tmp_path):
    assert cache_path(str(tmp_path), "signals", "abc", "level1.bin") == os.path.join(
        str(tmp_path), "signals", "abc", "level1.bin"
    )


def test_cache_read_of_missing_file_is_a_miss(tmp_path):
    """Промах кэша — это ``None``, а не исключение: вызывающий пересчитывает."""
    assert cache_read(cache_path(str(tmp_path), "signals", "нет.bin")) is None


def test_cache_write_creates_dirs_and_reads_back(tmp_path):
    path = cache_path(str(tmp_path), "signals", "abc", "level1.bin")

    assert cache_write(path, b"payload") is True

    assert cache_read(path) == b"payload"
    # Временный файл публикуется `os.replace`, а не остаётся рядом с кэшем
    assert not os.path.exists(f"{path}.tmp")


def test_cache_write_failure_is_reported_not_raised(tmp_path, monkeypatch, caplog):
    """Сбой записи кэша не должен ломать расчёт: ``False`` в ответе и чистый tmp."""
    path = cache_path(str(tmp_path), "signals", "level1.bin")

    def broken_replace(*args, **kwargs):
        raise OSError("диск заполнен")

    monkeypatch.setattr(os, "replace", broken_replace)

    with caplog.at_level("WARNING"):
        assert cache_write(path, b"payload", label="Кэш сигналов") is False

    assert not os.path.exists(path)
    assert not os.path.exists(f"{path}.tmp")
    assert "Кэш сигналов не записан" in caplog.text


def test_cache_clear_removes_one_recording_and_keeps_the_other(tmp_path):
    root = str(tmp_path)
    keep = cache_path(root, "signals", "keep", "level1.bin")
    drop = cache_path(root, "signals", "drop", "level1.bin")
    cache_write(keep, b"keep")
    cache_write(drop, b"drop")

    cache_clear(root, "signals", "drop")

    assert cache_read(keep) == b"keep"
    assert not os.path.exists(drop)
    assert not os.path.isdir(cache_path(root, "signals", "drop"))


def test_cache_clear_of_whole_kind_keeps_other_kinds(tmp_path):
    """`cache_clear(dir, "spectra")` чистит только топокарты, не соседние кэши."""
    root = str(tmp_path)
    topomap = cache_path(root, "spectra", "abc", "alpha.png")
    grid = cache_path(root, "spectrograms", "abc", "sig.bin")
    cache_write(topomap, b"png")
    cache_write(grid, b"grid")

    cache_clear(root, "spectra")

    assert not os.path.exists(topomap)
    assert cache_read(grid) == b"grid"


def test_cache_clear_without_parts_is_refused(tmp_path):
    """Опечатка не должна сносить весь `data/cache` — части пути обязательны."""
    with pytest.raises(ValueError, match="cache_clear"):
        cache_clear(str(tmp_path))
