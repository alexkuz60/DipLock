"""Схемы журнала шагов (этап 5, A5) — контракт ``GET /journal``.

Формат строки — `docs/data_map.md` §9. В файле «прочерк» пишется как ``"-"``
(человекочитаемо), в ответе он превращается в ``null``: правило п.5
`docs/rules/api-jobs.md` («неизмеренное — ``null``, UI рисует «—»»).
"""
from typing import List, Optional

from pydantic import BaseModel, Field


class JournalEntry(BaseModel):
    """Одна строка журнала: один измеренный шаг одного пайплайна."""

    ts: str = Field(description="Момент завершения шага, ISO-8601 с миллисекундами")
    job_id: Optional[str] = Field(
        default=None, description="Задача, внутри которой шёл шаг (null — синхронный вызов)"
    )
    pipeline: str = Field(description="Пайплайн: spectrum, dipoles, signals, asset-surface, …")
    step: str = Field(description="Имя шага внутри пайплайна: load_edf, psd, stft, grid_scan, …")
    params_key: Optional[str] = Field(
        default=None, description="Сигнатура, по которой кэшируется результат шага (null — нет кэша)"
    )
    bytes_in: Optional[int] = Field(default=None, description="Объём входа шага, байт")
    bytes_out: Optional[int] = Field(default=None, description="Объём выхода шага, байт")
    ms: float = Field(default=0.0, description="Длительность шага, мс")
    cache_hit: Optional[bool] = Field(
        default=None, description="Попадание в кэш (null — шаг не кэшируется)"
    )
    epochs: Optional[int] = Field(default=None, description="Число эпох, к которым относится шаг")
    note: str = Field(default="", description="Короткий контекст: level=4, grid=7mm, error=…")


class JournalOut(BaseModel):
    """Хвост журнала шагов: последние ``limit`` строк (в порядке записи)."""

    enabled: bool = Field(description="Пишется ли журнал сейчас (JOURNAL_ENABLED)")
    journal_path: str = Field(description="Путь файла журнала (внутри CACHE_DIR)")
    entries: List[JournalEntry] = Field(default_factory=list, description="Строки, новые — в конце")
