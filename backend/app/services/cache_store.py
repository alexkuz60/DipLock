"""Единый дисковый кэш: путь, чтение, атомарная запись, очистка (этап 2, A3).

У каждого дискового кэша проекта (пирамида сигналов 2.5, топокарты 3.4, сетки
спектрограмм «ЭЭГ», меш/BA fsaverage, том МРТ 3.2, объёмы атласа 3.9) была
**своя** копия трёх операций: «прочитать файл», «записать во временный файл +
``os.replace``», «``rmtree`` подкаталога». Копии расходились в деталях — где-то
забывалось создание каталога, где-то ``os.replace``, а ``np.savez_compressed``
дописывал ``.npz`` к временному имени и ломал замену. Здесь эти операции лежат
в одном месте:

* ``cache_path(cache_dir, *parts)`` — путь внутри ``settings.cache_dir``;
* ``cache_read(path)`` — байты или ``None`` (файла нет / не читается);
* ``cache_write(path, data, label=...)`` — атомарно (временный файл +
  ``os.replace``); сбой логируется и возвращает ``False``;
* ``cache_clear(cache_dir, *parts)`` — удаляет подкаталог кэша целиком.

Два свойства, которые даёт одна реализация вместо шести:

1. **Кэш — оптимизация, а не источник истины.** Ошибка записи не бросает
   исключение: расчёт обязан продолжиться, а промах кэша — пересчитаться.
2. **Кэш не бывает «наполовину записан».** Читатель видит либо прежнее
   содержимое, либо новое целиком: временный файл публикуется ``os.replace``
   (атомарная операция в пределах файловой системы), а при сбое убирается.

Сайдкар записи (``services/recordings.py``) сюда **не** переведён осознанно:
это не кэш, а носитель дедупа, у него своя семантика отказа (см.
``docs/rules/data-and-caches.md``).
"""
import contextlib
import logging
import os
import shutil

logger = logging.getLogger(__name__)

# Ограничение на попытку самодельного ``rmtree`` корня кэша: части пути
# обязательны, чтобы ``cache_clear(dir)`` не снёс весь ``data/cache``.
_EMPTY_PARTS_ERROR = "cache_clear требует хотя бы одну часть пути внутри cache_dir"


def cache_path(cache_dir: str, *parts: str) -> str:
    """Путь внутри каталога кэша (``cache_dir/signals/<id>/level1.bin``).

    Абсолютных путей в коде быть не должно: корень приходит из ``settings``.
    """
    return os.path.join(str(cache_dir), *parts)


def cache_read(path: str) -> bytes | None:
    """Читает файл кэша; ``None`` — файла нет или он не читается (это промах)."""
    try:
        with open(path, "rb") as fh:
            return fh.read()
    except OSError:
        return None


def cache_write(path: str, data: bytes, label: str = "Кэш") -> bool:
    """Атомарно пишет файл кэша; ``True`` — запись состоялась.

    ``label`` — что писать в логе при сбое («Кэш сигналов», «Кэш топокарт»…):
    текст сообщения обязан называть кэш, иначе по логу не понять, что сломалось.
    """
    tmp = f"{path}.tmp"
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
        return True
    except OSError as exc:
        logger.warning("%s не записан (%s): %s", label, path, exc)
        # Обрывок временного файла не оставляем: следующий прогон прочитал бы
        # его как «объект не той длины» и упал вместо пересчёта.
        with contextlib.suppress(OSError):
            os.remove(tmp)
        return False


def cache_clear(cache_dir: str, *parts: str) -> None:
    """Удаляет подкаталог (или файл) кэша; отсутствие — не ошибка.

    Части обязательны: ``cache_clear(cfg.cache_dir, "signals", recording_id)``
    чистит одну запись, ``cache_clear(cfg.cache_dir, "spectra")`` — весь кэш
    топокарт. Пустой вызов запрещён — иначе опечатка снесла бы весь кэш.
    """
    if not parts:
        raise ValueError(_EMPTY_PARTS_ERROR)
    shutil.rmtree(cache_path(cache_dir, *parts), ignore_errors=True)
