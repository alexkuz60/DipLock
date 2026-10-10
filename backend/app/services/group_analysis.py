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
import hashlib
import json
import math
import time
from collections import defaultdict
from datetime import datetime
from statistics import median, pstdev
from typing import Any

from sqlalchemy import func, select

from app.core.config import Settings
from app.models.db import (
    Analysis,
    AsyncSessionLocal,
    DipolePoint,
    GroupAnalysis,
    GroupAnalysisMember,
    RecordingRecord,
    ReportNameCount,
    ReportRun,
    init_db,
)
from app.schemas.group import GroupAggregateIn
from app.services.dipole_clusters import cluster_dipoles, cluster_params
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

    # Кластеры диполей (B8, G4): пространственные скопления точек полосы с
    # привязкой к ROI и устойчивостью по записям — чистая функция, без БД
    cluster_points = [
        {
            "recording_id": rid,
            "mni": point.mni_coords,
            "structure": point.anatomical_structure,
            "area": point.brodmann_area,
        }
        for rid, point in flat
    ]
    clusters = cluster_dipoles(cluster_points, cfg)
    cluster_params_out = cluster_params(cfg)
    if total > 0 and not clusters:
        warnings.append(
            f"Кластеров нет: точек в полосе {total}, минимум кластера — "
            f"{cluster_params_out['min_points']} точки (сетка "
            f"{cluster_params_out['voxel_mm']:g} мм); отборы могли оставить "
            "разрозненные точки",
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
        "clusters": clusters,
        "cluster_params": cluster_params_out,
        "notes": list(GROUP_NOTES),
        "warnings": warnings,
        "duration_sec_calc": round(time.perf_counter() - started, 3),
    }



# ------------------------- персист прогонов (G2) ---------------------------

def filters_sig(payload: GroupAggregateIn) -> str:
    """Отпечаток определения прогона: фильтры + состав (SHA-256 короткий).

    Ключ истории §8.4.2: повтор с тем же определением — честная новая строка,
    но в списке видно «такое же уже было».
    """
    canonical = json.dumps(
        {
            "band_key": payload.band_key,
            "gof_min": payload.gof_min,
            "epoch_length_ms": payload.epoch_length_ms,
            "date_from": payload.date_from.isoformat() if payload.date_from else None,
            "date_to": payload.date_to.isoformat() if payload.date_to else None,
            "names": payload.names,
            "top_n": payload.top_n,
            "recording_ids": [
                str(rid) for rid in dict.fromkeys(payload.recording_ids) if rid
            ],
        },
        sort_keys=True, ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]


async def save_group_analysis(
    payload: GroupAggregateIn, cfg: Settings, name: str | None,
) -> dict[str, Any]:
    """Сохраняет прогон (определение) и возвращает его паспорт.

    Валидация — как у живого агрегата: неизвестная полоса и пустая выборка
    не создают строку (``GroupError`` → 400 в роуте).
    """
    catalog = report_band_catalog(cfg)
    if payload.band_key not in catalog:
        raise GroupError(
            f"Неизвестная полоса: {payload.band_key}; доступны: {', '.join(catalog)}",
        )
    participant_ids = list(dict.fromkeys(str(rid) for rid in payload.recording_ids if rid))
    if not participant_ids:
        raise GroupError("Нужна хотя бы одна запись участника (recording_ids пуст)")

    await init_db()
    filters = payload.model_dump(exclude={"recording_ids", "name"})
    sig = filters_sig(payload)
    async with AsyncSessionLocal() as session:
        run = GroupAnalysis(
            name=(name or "").strip()[:128] or None,
            band_key=payload.band_key,
            filters=json.loads(json.dumps(filters, default=str)),
            params_sig=sig,
            created_at=datetime.utcnow(),
            n_sessions_requested=len(participant_ids),
        )
        session.add(run)
        await session.flush()
        for position, rid in enumerate(participant_ids):
            session.add(GroupAnalysisMember(
                group_analysis_id=run.id, recording_id=rid, position=position,
            ))
        await session.commit()
        return _summary_row(run, alive=len(participant_ids))


async def _run_row(run_id: int) -> tuple[GroupAnalysis | None, list[str]]:
    """Строка прогона и её участники в порядке выбора; ``None`` — нет/удалён."""
    await init_db()
    async with AsyncSessionLocal() as session:
        run = await session.get(GroupAnalysis, run_id)
        if run is None:
            return None, []
        rows = list((await session.scalars(
            select(GroupAnalysisMember)
            .where(GroupAnalysisMember.group_analysis_id == run_id)
            .order_by(GroupAnalysisMember.position, GroupAnalysisMember.id)
        )).all())
    return run, [str(row.recording_id) for row in rows if row.recording_id]



def _summary_row(run: GroupAnalysis, *, alive: int) -> dict[str, Any]:
    """Паспорт прогона для списка/деталей (``GroupAnalysisSummaryOut``)."""
    return {
        "id": int(run.id),
        "name": run.name,
        "band_key": run.band_key,
        "created_at": run.created_at,
        "n_sessions_requested": int(run.n_sessions_requested or 0),
        "n_members_alive": alive,
        "params_sig": run.params_sig,
    }


async def list_group_analyses(limit: int = 50, offset: int = 0) -> dict[str, Any]:
    """История прогонов: страница ``group_analyses`` + живые участники одним запросом.

    ``total`` — до пагинации (инвариант read ``docs/rules/results-db.md``);
    счётчик живых членов — групповой ``GROUP BY`` по прогонам страницы (не N+1).
    """
    await init_db()
    async with AsyncSessionLocal() as session:
        total = int(await session.scalar(select(func.count()).select_from(GroupAnalysis)) or 0)
        runs = list((await session.scalars(
            select(GroupAnalysis)
            .order_by(GroupAnalysis.created_at.desc(), GroupAnalysis.id.desc())
            .limit(limit).offset(offset)
        )).all())
        run_ids = [int(run.id) for run in runs]
        alive: dict[int, int] = {}
        if run_ids:
            counts = (await session.execute(
                select(GroupAnalysisMember.group_analysis_id, func.count())
                .where(GroupAnalysisMember.group_analysis_id.in_(run_ids))
                .group_by(GroupAnalysisMember.group_analysis_id)
            )).all()
            alive = {int(rid): int(count) for rid, count in counts}
    return {
        "total": total,
        "items": [_summary_row(run, alive=alive.get(int(run.id), 0)) for run in runs],
    }


async def get_group_analysis(
    run_id: int, cfg: Settings,
) -> dict[str, Any] | None:
    """Паспорт прогона + **свежий** пересчёт агрегата по живой БД; ``None`` — нет.

    Состав берётся из ``group_analysis_members``, фильтры — из снимка
    ``group_analyses.filters``; участники, чьи записи уже удалены, честно
    уходят в ``warnings`` агрегата («нет прогона»), а не теряются молча.
    """
    run, member_ids = await _run_row(run_id)
    if run is None:
        return None
    filters = dict(run.filters or {})
    payload = GroupAggregateIn(
        recording_ids=member_ids,
        band_key=str(filters.get("band_key") or run.band_key or ""),
        gof_min=filters.get("gof_min"),
        epoch_length_ms=filters.get("epoch_length_ms"),
        date_from=_iso(filters.get("date_from")),
        date_to=_iso(filters.get("date_to")),
        names=filters.get("names"),
        top_n=int(filters.get("top_n") or 12),
    )
    aggregate = await aggregate_group(payload, cfg)
    requested = int(run.n_sessions_requested or len(member_ids))
    if len(member_ids) < requested:
        aggregate["warnings"].insert(0, (
            f"Участников в БД {len(member_ids)} из {requested} сохранённых: "
            "записи удалялись после сохранения прогона (§8.4.3)"
        ))
    return {"run": _summary_row(run, alive=len(member_ids)), "aggregate": aggregate}


async def list_research_groups(recording_ids: list[str]) -> list[dict[str, Any]]:
    """Группы, чей весь живой состав входит в дело; вычислений при листинге нет."""
    await init_db()
    async with AsyncSessionLocal() as session:
        runs = (await session.scalars(select(GroupAnalysis))).all()
        members = (await session.scalars(select(GroupAnalysisMember).order_by(
            GroupAnalysisMember.position, GroupAnalysisMember.id,
        ))).all()
    groups: dict[int, list[str]] = defaultdict(list)
    for member in members:
        groups[int(member.group_analysis_id)].append(str(member.recording_id))
    allowed = set(recording_ids)
    return [{
        "kind": "group", "id": str(run.id), "title": f"Группа · {run.name or run.id}",
        "recording_ids": groups[int(run.id)], "created_at": run.created_at,
        "available": True,
        "warnings": ["Числа будут зафиксированы по текущим пакетам при добавлении материала"],
    } for run in runs if groups[int(run.id)] and set(groups[int(run.id)]) <= allowed]


async def research_group_members(run_id: int) -> list[str] | None:
    """Проверяемый состав до чтения агрегата, без прямого SQL из Консилиума."""
    run, members = await _run_row(run_id)
    return members if run is not None else None


def _iso(value: Any) -> datetime | None:
    """JSON-дата снимка → ``datetime``; мусор — честный ``None``."""
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None
    return None

