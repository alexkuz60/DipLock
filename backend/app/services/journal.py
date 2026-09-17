"""Журнал шагов: пошаговые замеры пайплайнов (этап 5, A5).

До этого модуля время измерялось в **несвязанных** местах: ``duration_sec_calc``
внутри расчётов (6 копий), ``Job.elapsed_sec`` (длительность всей задачи),
``duration_sec`` в ответе ``/analyze``. Пошаговых длительностей не было, поэтому
вопрос «почему 8 секунд» решался повторным запуском с логами.

Формат строки согласован в `docs/data_map.md` §9 и живёт здесь:

```
ts | job_id | pipeline | step | params_key | bytes_in | bytes_out | ms | cache_hit | epochs | note
```

Три свойства журнала:

1. **Строка на шаг, а не на запрос.** ``step()`` пишет одну строку при выходе из
   блока (в т.ч. при исключении — с ``error=…`` в ``note``), ``record()`` — когда
   шаг уже измерен вызывающим (например, сумма по эпохам внутри цикла).
2. **Измерение не может сломать расчёт.** Сбой записи логируется и гасится:
   журнал — диагностика, а не часть контракта (`cache_store` держит то же
   правило для кэшей).
3. **``job_id`` не передаётся в сервисы руками.** Его кладёт ``job_scope``
   (``job_manager``), а ``step()``/``record()`` читают из ``ContextVar``: контекст
   доезжает до потока задачи через ``asyncio.to_thread`` (он копирует контекст).
   Синхронный вызов (``/analyze``, тесты) пишет прочерк.

Носитель — ``data/cache/journal.jsonl`` (под ``settings.cache_dir``: тот же
каталог-артефакт, что и кэши, и он не коммитится). Файл дописывается под локом
(шаги идут из нескольких потоков job-очереди), перед записью проверяется
``JOURNAL_MAX_BYTES``: старое поколение уезжает в ``journal.jsonl.1``, поэтому
диск не растёт без предела — всегда не больше двух файлов.

В файле «прочерк» пишется как ``"-"`` (так его читает человек), а в API-схеме
``JournalEntry`` он превращается в ``null``: правило «неизмеренное — ``null``,
UI рисует «—»» (`docs/rules/api-jobs.md` п.5).
"""
import json
import logging
import os
import threading
import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Iterator, List, Optional

from app.core.config import Settings, settings
from app.services.cache_store import cache_path

logger = logging.getLogger(__name__)

# Имена файлов журнала: текущий и одно предыдущее поколение (ротация).
JOURNAL_FILENAME = "journal.jsonl"
JOURNAL_ROTATED_FILENAME = f"{JOURNAL_FILENAME}.1"

# Сколько байт «хвоста» файла читает ``read_journal``: журнал читают ради
# последних шагов, а не ради всей истории за месяц.
READ_MAX_BYTES = 1_000_000

# Прочерк для «поля нет» — и в файле, и в разборе.
DASH = "-"

# ``job_id`` текущей задачи: заполняет ``job_scope`` (job_manager), читают
# ``step``/``record``. Сервисы не обязаны знать про задачи.
_JOB_ID: ContextVar[Optional[str]] = ContextVar("diplock_job_id", default=None)
_LOCK = threading.Lock()


def journal_path(cfg: Optional[Settings] = None) -> str:
    """Путь файла журнала (текущее поколение) под каталогом кэша."""
    return cache_path(str((cfg or settings).cache_dir), JOURNAL_FILENAME)


def current_job_id() -> str:
    """``job_id`` текущей задачи или прочерк (синхронный вызов, тесты)."""
    return _JOB_ID.get() or DASH


@contextmanager
def job_scope(job_id: str) -> Iterator[None]:
    """Помечает шаги внутри блока идентификатором задачи.

    Вызывается в ``job_manager._execute`` вокруг ``asyncio.to_thread``: контекст
    копируется в поток, поэтому сервисы пишут ``job_id`` без параметров.
    """
    token = _JOB_ID.set(job_id)
    try:
        yield
    finally:
        _JOB_ID.reset(token)


@dataclass
class _Step:
    """Измеряемый шаг: поля можно дополнить внутри блока (``bytes_out``, ``note``)."""

    pipeline: str
    step: str
    params_key: Optional[str] = None
    bytes_in: Optional[int] = None
    bytes_out: Optional[int] = None
    cache_hit: Optional[bool] = None
    epochs: Optional[int] = None
    note: str = ""

    def fields(self) -> Dict[str, Any]:
        """Поля строки журнала (``ms`` подставляет измерение, ``job_id`` — контекст)."""
        return {
            "pipeline": self.pipeline,
            "step": self.step,
            "params_key": self.params_key,
            "bytes_in": self.bytes_in,
            "bytes_out": self.bytes_out,
            "cache_hit": self.cache_hit,
            "epochs": self.epochs,
            "note": self.note,
        }


def _append(entry: Dict[str, Any], cfg: Settings) -> None:
    """Дописывает строку в файл журнала (ротация по размеру, сбой гасится)."""
    path = journal_path(cfg)
    try:
        with _LOCK:
            limit = int(cfg.journal_max_bytes)
            if limit > 0 and os.path.exists(path) and os.path.getsize(path) >= limit:
                os.replace(path, f"{path}.1")
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except (OSError, TypeError) as exc:  # noqa: BLE001 — журнал не ломает расчёт
        logger.warning("Журнал шагов не записан (%s): %s", path, exc)


def _line(
    pipeline: str,
    step: str,
    ms: float,
    *,
    params_key: Optional[str] = None,
    bytes_in: Optional[int] = None,
    bytes_out: Optional[int] = None,
    cache_hit: Optional[bool] = None,
    epochs: Optional[int] = None,
    note: str = "",
) -> Dict[str, Any]:
    """Собирает строку журнала: порядок полей — как в спецификации формата."""
    return {
        "ts": datetime.now().isoformat(timespec="milliseconds"),
        "job_id": current_job_id(),
        "pipeline": pipeline,
        "step": step,
        "params_key": params_key or DASH,
        "bytes_in": bytes_in,
        "bytes_out": bytes_out,
        "ms": round(float(ms), 3),
        "cache_hit": cache_hit if isinstance(cache_hit, bool) else DASH,
        "epochs": epochs,
        "note": note,
    }


def record(
    pipeline: str,
    step: str,
    *,
    ms: float,
    params_key: Optional[str] = None,
    bytes_in: Optional[int] = None,
    bytes_out: Optional[int] = None,
    cache_hit: Optional[bool] = None,
    epochs: Optional[int] = None,
    note: str = "",
    cfg: Optional[Settings] = None,
) -> None:
    """Пишет строку о шаге, длительность которого измерена вызывающим.

    Нужен там, где шаг — цикл: строка на эпоху засорила бы журнал, поэтому
    сервис копит время и отдаёт сумму одной строкой (``note`` объясняет, что
    это сумма).
    """
    cfg = cfg or settings
    if not cfg.journal_enabled:
        return
    _append(
        _line(
            pipeline, step, ms,
            params_key=params_key, bytes_in=bytes_in, bytes_out=bytes_out,
            cache_hit=cache_hit, epochs=epochs, note=note,
        ),
        cfg,
    )



@contextmanager
def step(
    pipeline: str,
    name: str,
    *,
    params_key: Optional[str] = None,
    bytes_in: Optional[int] = None,
    bytes_out: Optional[int] = None,
    cache_hit: Optional[bool] = None,
    epochs: Optional[int] = None,
    note: str = "",
    cfg: Optional[Settings] = None,
) -> Iterator[_Step]:
    """Измеряет шаг пайплайна и пишет о нём строку журнала.

    Поля можно дополнить внутри блока::

        with journal.step("signals", "build_level", note="level=4") as entry:
            entry.bytes_out = len(blob)

    Исключение не отменяет запись: строка появится с ``error=…`` в ``note`` —
    упавший шаг обязан быть виден в журнале, иначе «почему задача упала»
    выясняется только по тексту ошибки задачи.
    """
    entry = _Step(
        pipeline=pipeline, step=name, params_key=params_key, bytes_in=bytes_in,
        bytes_out=bytes_out, cache_hit=cache_hit, epochs=epochs, note=note,
    )
    started = time.perf_counter()
    try:
        yield entry
    except BaseException as exc:  # noqa: BLE001 — запись нужна и для сбоя шага
        entry.note = f"{entry.note} error={type(exc).__name__}".strip()
        record(ms=(time.perf_counter() - started) * 1000.0, cfg=cfg, **entry.fields())
        raise
    record(ms=(time.perf_counter() - started) * 1000.0, cfg=cfg, **entry.fields())


def _read_lines(path: str) -> List[bytes]:
    """Строки файла (непустые), при большом файле — только «хвост»."""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            if size > READ_MAX_BYTES:
                # Первая строка обрезана seek'ом: её выбрасываем.
                fh.seek(size - READ_MAX_BYTES)
                fh.readline()
            data = fh.read()
    except OSError:
        return []
    return [line for line in data.split(b"\n") if line.strip()]



def _parse(line: bytes) -> Optional[Dict[str, Any]]:
    """Разбирает строку журнала в поля ответа (прочерк → ``None``).

    Битые и чужие строки пропускаются: файл журнала — диагностика, падать из-за
    него на чтении нельзя (в него может писать предыдущая версия приложения).
    """
    try:
        raw = json.loads(line.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(raw, dict) or "pipeline" not in raw or "step" not in raw:
        return None

    def dash(value: Any) -> Any:
        return None if value in (DASH, "", None) else value

    cache_hit = raw.get("cache_hit")
    return {
        "ts": str(raw.get("ts") or ""),
        "job_id": dash(raw.get("job_id")),
        "pipeline": str(raw["pipeline"]),
        "step": str(raw["step"]),
        "params_key": dash(raw.get("params_key")),
        "bytes_in": raw.get("bytes_in"),
        "bytes_out": raw.get("bytes_out"),
        "ms": float(raw.get("ms") or 0.0),
        "cache_hit": cache_hit if isinstance(cache_hit, bool) else None,
        "epochs": raw.get("epochs"),
        "note": str(raw.get("note") or ""),
    }


def read_journal(
    limit: int = 200, pipeline: Optional[str] = None, cfg: Optional[Settings] = None,
) -> List[Dict[str, Any]]:
    """Последние ``limit`` строк журнала (в порядке записи), с фильтром по пайплайну.

    Читает оба поколения файла (ротированное — раньше текущего) и возвращает
    поля в форме API-схемы ``JournalEntry``: в файле прочерк ``"-"``, в ответе —
    ``null`` («неизмеренное»), как и в остальных эндпоинтах.
    """
    base = journal_path(cfg)
    entries: List[Dict[str, Any]] = []
    for path in (f"{base}.1", base):
        for line in _read_lines(path):
            parsed = _parse(line)
            if parsed is None:
                continue
            if pipeline and parsed["pipeline"] != pipeline:
                continue
            entries.append(parsed)
    return entries[-limit:] if limit > 0 else entries


def clear_journal(cfg: Optional[Settings] = None) -> None:
    """Удаляет оба поколения файла журнала (тесты; в UI такого действия нет)."""
    base = journal_path(cfg)
    for path in (f"{base}.1", base):
        try:
            os.remove(path)
        except OSError:
            pass

