"""Групповой анализ (остаток 4.7, Фаза 5): агрегаты «BA × сессии» по выборке.

Читает кирпичи ``dipole_points`` (B6) последнего подходящего прогона
``analyses`` каждой выбранной записи и складывает их в групповой срез:
строки «структура/поле Бродмана» × колонки-записи — форма, родная для
тепловой карты §3.5 ``docs/ui/table.md``.

Правила чтения чисел:

* **всё внутри одной полосы** ``band_key``: GOF и амплитуда момента между
  полосами не сравнимы (принцип 3 ``docs/rules/dipoles.md``) — фильтр полосы
  обязателен и входит в каждый агрегат;
* **два знаменателя share**: строка — доля от всех точек выборки в полосе,
  ячейка — доля от точек **своей** записи (между записями с разным числом
  эпох сравнима только она);
* **история прогонов не UPSERT** (§8.4.2 ``docs/data-blocks.md``): берётся
  последний прогон, прошедший фильтры, его ``created_at`` виден в колонке;
* запись без пакетного прогона — не ошибка, а честное предупреждение:
  групповой анализ читает то, что реально посчитано.

Перекрёстная проверка: счётчики ``report_name_counts`` того же прогона
сверяются с точками — расхождение уходит в ``warnings`` (одна истина на
прогон, §8, вариант (а)).
"""
import math
import time
from collections import defaultdict
from statistics import median, pstdev
from typing import Any

from sqlalchemy import select

from app.core.config import Settings
from app.models.db import (
    Analysis,
    AsyncSessionLocal,
    DipolePoint,
    RecordingRecord,
    ReportNameCount,
    ReportRun,
    init_db,
)
from app.schemas.group import GroupAggregateIn
from app.services.report import report_band_catalog
from app.services.roi import hemisphere_of

# Каветы интерпретации — показываются UI без правок (как CompareResult.notes)
GROUP_NOTES: tuple[str, ...] = (
    "GOF и амплитуда момента считаются только внутри своей полосы — между "
    "полосами они не сравнимы (узкая полоса завышает R², принцип 3).",
    "share строки — доля от всех точек выборки в полосе; доля ячейки — от "
    "точек своей записи: только она сравнима между записями с разным числом эпох.",
    "Источник — пакет диполей автоотчёта: последний прогон каждой записи, "
    "прошедший фильтры (история пересчётов хранится отдельными строками).",
)


class GroupError(ValueError):
    """Некорректный запрос группового агрегата (400 с текстом для UI)."""


def _mean(values: list[float]) -> float | None:
    """Среднее; ``None`` — значений нет (не выдумываем ноль)."""
    return sum(values) / len(values) if values else None


def _std(values: list[float]) -> float | None:
    """Популяционная СТОД; ``None`` — меньше двух значений (pstdev требует N≥2)."""
    return float(pstdev(values)) if len(values) >= 2 else None


def _median(values: list[float]) -> float | None:
    """Медиана; ``None`` — значений нет."""
    return float(median(values)) if values else None


async def _filenames(recording_ids: list[str]) -> dict[str, str | None]:
    """``recording_id → имя файла`` из таблицы recordings (одним запросом)."""
    if not recording_ids:
        return {}
    async with AsyncSessionLocal() as session:
        rows: list[Any] = list((await session.execute(
            select(RecordingRecord.recording_id, RecordingRecord.filename).where(
                RecordingRecord.recording_id.in_(recording_ids)
            )
        )).all())
    return {str(rid): (str(name) if name is not None else None) for rid, name in rows}


def _pass_analysis_filters(analysis: Analysis, payload: GroupAggregateIn) -> bool:
    """Прогон подходит под фильтры «длина эпохи» и «дата» (отбор до выбора последнего)."""
    if payload.epoch_length_ms is not None:
        length = analysis.epoch_length_ms
        if length is None or not math.isclose(
            float(length), payload.epoch_length_ms, abs_tol=0.01,
        ):
            return False
    created = analysis.created_at
    if payload.date_from is not None and (created is None or created < payload.date_from):
        return False
    return not (
        payload.date_to is not None and (created is None or created > payload.date_to)
    )


async def _latest_analyses(
    recording_ids: list[str], payload: GroupAggregateIn,
) -> dict[str, Analysis]:
    """``recording_id → последний подходящий прогон`` (§8.4.2: история, не UPSERT)."""
    async with AsyncSessionLocal() as session:
        rows = list((await session.scalars(
            select(Analysis)
            .where(Analysis.recording_id.in_(recording_ids))
            .order_by(Analysis.created_at.desc(), Analysis.id.desc())
        )).all())
    latest: dict[str, Analysis] = {}
    for analysis in rows:  # уже отсортированы «новые сверху»
        rid = str(analysis.recording_id)
        if rid in latest:
            continue  # первый подходящий на запись = самый свежий
        if _pass_analysis_filters(analysis, payload):
            latest[rid] = analysis
    return latest


async def _load_points(
    analysis_ids: list[int], payload: GroupAggregateIn,
) -> dict[int, list[DipolePoint]]:
    """``analysis_id → точки полосы после отбора по GOF`` (одним запросом)."""
    if not analysis_ids:
        return {}
    conditions = [
        DipolePoint.analysis_id.in_(analysis_ids),
        DipolePoint.band_key == payload.band_key,
    ]
    if payload.gof_min is not None:
        conditions.append(DipolePoint.gof >= payload.gof_min)
    async with AsyncSessionLocal() as session:
        rows = list((await session.scalars(
            select(DipolePoint).where(*conditions).order_by(DipolePoint.id)
        )).all())
    grouped: dict[int, list[DipolePoint]] = defaultdict(list)
    for point in rows:
        grouped[int(point.analysis_id)].append(point)
    return dict(grouped)


async def _cross_check_counts(
    analysis_ids: list[int], points: dict[int, list[DipolePoint]], band_key: str,
    *, gof_min: float | None,
) -> list[str]:
    """Перекрёстная сверка счётчиков ``report_name_counts`` с точками (§8, вариант (а)).

    Сверяется полный счёт отчёта по полосе — поэтому при отборе точек по
    ``gof_min`` проверка пропускается (счётчики считались без отбора, ложное
    расхождение никому не нужно).
    """
    if not analysis_ids or gof_min is not None:
        return []
    async with AsyncSessionLocal() as session:
        # Один запрос: (счётчик отчёта → его прогон) — join по FK §8, вариант (а)
        pairs: list[Any] = list((await session.execute(
            select(ReportRun.analyses_id, ReportNameCount)
            .join(ReportNameCount, ReportNameCount.report_run_id == ReportRun.id)
            .where(
                ReportRun.analyses_id.in_(analysis_ids),
                ReportNameCount.band_key == band_key,
            )
        )).all())
    if not pairs:
        return []  # отчёт не создавал строк (или чужая полоса) — сверять нечего
    warnings: list[str] = []
    counts_by_analysis: dict[int, dict[tuple[str, str], int]] = defaultdict(
        lambda: defaultdict(int),
    )
    for analysis_id, row in pairs:
        if analysis_id is None:
            continue
        key = (str(row.kind or ""), str(row.name or ""))
        counts_by_analysis[int(analysis_id)][key] += int(row.count or 0)
    for analysis_id, reported in counts_by_analysis.items():
        mine: dict[tuple[str, str], int] = defaultdict(int)
        for point in points.get(analysis_id, ()):
            structure = point.anatomical_structure
            area = point.brodmann_area
            if structure:
                mine[("structure", str(structure))] += 1
            if area:
                mine[("brodmann", str(area))] += 1
        for key, reported_count in sorted(reported.items()):
            my_count = mine.get(key, 0)
            if my_count != reported_count:
                warnings.append(
                    f"Счётчики отчёта разошлись с точками: «{key[1]}» ({key[0]}): "
                    f"в отчёте {reported_count}, в точках {my_count} — "
                    "отчёт и прогон могли быть созданы разными задачами",
                )
    return warnings[:10]  # поток предупреждений не должен затопить UI


def _build_rows(
    kind: str,
    point_rows: list[tuple[str, list[tuple[str, DipolePoint]]]],
    total: int,
    participant_ids: list[str],
    session_totals: dict[str, int],
    payload: GroupAggregateIn,
) -> tuple[list[dict[str, Any]], int]:
    """Словарь строк «имя → агрегат + ячейки записей»; ``(строки, всего имён)``.

    ``point_rows`` — ``(имя, [(recording_id, точка), ...])`` для одного словаря;
    сортировка — по убыванию числа точек, топ-``top_n`` (как ``TOP_ROI`` отчёта),
    фильтр ``names`` сужает вывод, но не знаменатель ``share`` строки.
    ``session_totals`` — ``recording_id → точек записи в полосе``: знаменатель
    доли ячейки (доля от своих точек — единственная сравнимая между записями).
    """
    del kind  # словарь различается уже составом point_rows
    totals: dict[str, int] = defaultdict(int)
    by_name_session: dict[str, dict[str, list[DipolePoint]]] = defaultdict(
        lambda: defaultdict(list),
    )
    gofs: dict[str, list[float]] = defaultdict(list)
    amps: dict[str, list[float]] = defaultdict(list)
    for name, entries in point_rows:
        for rid, point in entries:
            totals[name] += 1
            by_name_session[name][rid].append(point)
            if point.gof is not None:
                gofs[name].append(float(point.gof))
            if point.amplitude_nam is not None:
                amps[name].append(float(point.amplitude_nam))
    all_names = sorted(totals, key=lambda name: (-totals[name], name))
    visible = [name for name in all_names if payload.names is None or name in payload.names]
    rows: list[dict[str, Any]] = []
    for name in visible[: payload.top_n]:
        session_points = by_name_session[name]
        cells = []
        for rid in participant_ids:
            count = len(session_points.get(rid, ()))
            own = session_totals.get(str(rid), 0)
            cells.append({
                "recording_id": str(rid),
                "count": count,
                "share": (count / own) if own else 0.0,
            })
        rows.append({
            "name": name,
            "hemisphere": hemisphere_of(name),
            "count": totals[name],
            "share": (totals[name] / total) if total else 0.0,
            "mean_gof": _mean(gofs[name]),
            "median_gof": _median(gofs[name]),
            "std_gof": _std(gofs[name]),
            "mean_amplitude_nam": _mean(amps[name]),
            "std_amplitude_nam": _std(amps[name]),
            "n_sessions": sum(1 for pts in session_points.values() if pts),
            "cells": cells,
        })
    return rows, len(all_names)



async def aggregate_group(
    payload: GroupAggregateIn, cfg: Settings,
) -> dict[str, Any]:
    """Групповой срез «BA × сессии»: агрегаты строк × колонки-записи.

    Поднимает схему до head (паттерн ``results_store``), валидирует полосу
    по каталогу ``report_band_catalog`` (``GroupError`` → 400 в роуте) и
    собирает ``GroupAggregateOut``. Тяжёлого расчёта нет — это выборки и
    арифметика, всё в одном потоке события (как ``list_sessions``).
    """
    started = time.perf_counter()
    catalog = report_band_catalog(cfg)
    if payload.band_key not in catalog:
        raise GroupError(
            f"Неизвестная полоса: {payload.band_key}; доступны: {', '.join(catalog)}",
        )
    participant_ids = list(dict.fromkeys(str(rid) for rid in payload.recording_ids if rid))
    if not participant_ids:
        raise GroupError("Нужна хотя бы одна запись участника (recording_ids пуст)")

    await init_db()
    warnings: list[str] = []
    analyses = await _latest_analyses(participant_ids, payload)
    filenames = await _filenames(participant_ids)
    analysis_ids = [int(analysis.id) for analysis in analyses.values()]
    points = await _load_points(analysis_ids, payload)

    participants: list[dict[str, Any]] = []
    session_totals: dict[str, int] = {}
    for rid in participant_ids:
        analysis = analyses.get(rid)
        own = points.get(int(analysis.id), []) if analysis is not None else []
        participants.append({
            "recording_id": rid,
            "filename": filenames.get(rid),
            "analysis_id": int(analysis.id) if analysis is not None else None,
            "analysis_kind": str(analysis.kind) if analysis is not None else None,
            "analysis_created_at": analysis.created_at if analysis is not None else None,
            "n_points": len(own),
        })
        session_totals[rid] = len(own)
        label = filenames.get(rid) or rid
        if analysis is None:
            warnings.append(
                f"«{label}»: нет прогона диполей, подходящего под фильтры — "
                "запись не участвует в агрегатах",
            )
        elif not own:
            warnings.append(
                f"«{label}»: в полосе «{payload.band_key}» нет точек "
                "(прогон есть, но полоса не считалась или отсеяна фильтром GOF)",
            )
    warnings.extend(await _cross_check_counts(
        analysis_ids, points, payload.band_key, gof_min=payload.gof_min,
    ))

    # Точки группы в порядке участников — вход обоих словарей
    flat: list[tuple[str, DipolePoint]] = []
    for rid in participant_ids:
        analysis = analyses.get(rid)
        if analysis is None:
            continue
        for point in points.get(int(analysis.id), ()):
            flat.append((rid, point))

    def _collect(attribute: str) -> list[tuple[str, list[tuple[str, DipolePoint]]]]:
        by_name: dict[str, list[tuple[str, DipolePoint]]] = defaultdict(list)
        for rid, point in flat:
            name = getattr(point, attribute)
            if name:
                by_name[str(name)].append((rid, point))
        return sorted(
            by_name.items(), key=lambda item: (-len(item[1]), item[0]),
        )

    total = len(flat)
    structures, n_structure_names = _build_rows(
        "structure", _collect("anatomical_structure"), total,
        participant_ids, session_totals, payload,
    )
    brodmann, n_brodmann_names = _build_rows(
        "brodmann", _collect("brodmann_area"), total,
        participant_ids, session_totals, payload,
    )
    if not participant_ids or total == 0:
        warnings.append(
            "По выбранным записям нет точек в этой полосе — агрегаты пусты "
            "(запустите автоотчёт для участников или снимите фильтры)",
        )

    lo, hi = catalog[payload.band_key]
    return {
        "filters": {
            "band_key": payload.band_key,
            "band_hz": [float(lo), float(hi)],
            "gof_min": payload.gof_min,
            "epoch_length_ms": payload.epoch_length_ms,
            "date_from": payload.date_from,
            "date_to": payload.date_to,
            "names": payload.names,
            "top_n": payload.top_n,
        },
        "participants": participants,
        "n_points_total": total,
        "structures": structures,
        "brodmann": brodmann,
        "n_structure_names": n_structure_names,
        "n_brodmann_names": n_brodmann_names,
        "notes": list(GROUP_NOTES),
        "warnings": warnings,
        "duration_sec_calc": round(time.perf_counter() - started, 3),
    }

