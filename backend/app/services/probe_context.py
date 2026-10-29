"""Контекст пробы (срез 4 слоя «признаки»): признаки записи по одной полосе.

Проба — запись-участник выборки (добровольец-испытуемый, условие эксперимента).
Контекст пробы собирает **измеренные признаки** записи в одной полосе из
последнего прогона автоотчёта (``report_runs`` → ``report_band_summaries`` +
``analysis_bands`` того же прогона через ``report_runs.analyses_id``):

* КД — ``kd_passed_share`` (доля точек, прошедших вердикт);
* вращение — ``rotation_ccw_share``/``rotation_cw_share`` (срез 2);
* поток — ``flow_orderliness`` (срез 3) плюс GOF/RIV-медианы полосы.

Инварианты: один источник — **последний** прогон автоотчёта записи (§8.4.2:
история, не UPSERT; выбор — ``ORDER BY created_at DESC``); полосы между собой
не сравнимы (принцип 3 ``docs/rules/dipoles.md``) — контекст всегда одной
полосы; не измерено — честные ``None`` (запись без прогона/полосы попадает в
``warnings``, а не в нули).
"""
from typing import Any

from sqlalchemy import select

from app.models.db import (
    AnalysisBand,
    AsyncSessionLocal,
    RecordingRecord,
    ReportBandSummary,
    ReportRun,
)

# Признаки пробы: имя → описание (валидация правил-гипотез — по этим ключам).
# Все значения — ``float | int | None`` (``None`` — «не измерено»).
PROBE_FEATURES: dict[str, str] = {
    "n_points": "точек расчёта в полосе (одна на эпоху)",
    "kd_passed_share": "доля точек, прошедших КД (n_kd_passed / n_points); None — «не оценено»",
    "rotation_ccw_share": "доля троек траектории с поворотом против часовой (срез 2)",
    "rotation_cw_share": "доля троек траектории с поворотом по часовой (срез 2)",
    "flow_orderliness": "упорядоченность потока R = |Σ dᵢ| / Σ|dᵢ| (срез 3)",
    "median_gof": "медиана GOF внутри полосы",
    "median_riv": "медиана RIV (единственный кросс-полосной фильтр)",
}


def _features(
    summary: ReportBandSummary | None, analysis_band: AnalysisBand | None,
) -> dict[str, float | int | None]:
    """Признаки полосы из строк прогона; ``None`` — «не измерено», не нули."""

    def _num(value: Any) -> float | None:
        return float(value) if value is not None else None

    def _int(value: Any) -> int | None:
        return int(value) if value is not None else None

    kd_share: float | None = None
    if (
        analysis_band is not None
        and analysis_band.n_kd_passed is not None
        and analysis_band.n_points
    ):
        kd_share = float(analysis_band.n_kd_passed) / float(analysis_band.n_points)
    return {
        "n_points": _int(summary.n_points) if summary is not None else None,
        "kd_passed_share": kd_share,
        "rotation_ccw_share": (
            _num(summary.rotation_ccw_share) if summary is not None else None
        ),
        "rotation_cw_share": (
            _num(summary.rotation_cw_share) if summary is not None else None
        ),
        "flow_orderliness": (
            _num(summary.flow_orderliness) if summary is not None else None
        ),
        "median_gof": _num(summary.median_gof) if summary is not None else None,
        "median_riv": _num(summary.median_riv) if summary is not None else None,
    }


async def _load_probes(
    recording_ids: list[str], band_keys: list[str],
) -> dict[str, dict[str, Any]]:
    """``recording_id → {filename, report_run_id, report_created_at, bands}``.

    Один проход запросов: **последний** прогон автоотчёта каждой записи
    (§8.4.2: история, не UPSERT) + его строки полос (``report_band_summaries``
    и ``analysis_bands`` для КД). ``bands`` — ``band_key → признаки`` только
    по реально измеренным полосам.
    """
    ids = list(dict.fromkeys(str(rid) for rid in recording_ids))
    if not ids:
        return {}
    async with AsyncSessionLocal() as session:
        runs = list((await session.scalars(
            select(ReportRun)
            .where(ReportRun.recording_id.in_(ids))
            .order_by(ReportRun.created_at.desc(), ReportRun.id.desc())
        )).all())
        latest: dict[str, ReportRun] = {}
        for run in runs:
            rid = str(run.recording_id)
            if rid not in latest:
                latest[rid] = run
        run_ids = [int(run.id) for run in latest.values()]
        summaries: dict[tuple[int, str], ReportBandSummary] = {}
        if run_ids:
            for row in (await session.scalars(
                select(ReportBandSummary).where(
                    ReportBandSummary.report_run_id.in_(run_ids),
                    ReportBandSummary.band_key.in_(band_keys),
                )
            )).all():
                summaries[(int(row.report_run_id), str(row.band_key))] = row
        analysis_ids = [
            int(run.analyses_id) for run in latest.values() if run.analyses_id is not None
        ]
        analysis_bands: dict[tuple[int, str], AnalysisBand] = {}
        if analysis_ids:
            for row in (await session.scalars(
                select(AnalysisBand).where(
                    AnalysisBand.analysis_id.in_(analysis_ids),
                    AnalysisBand.band_key.in_(band_keys),
                )
            )).all():
                analysis_bands[(int(row.analysis_id), str(row.band_key))] = row
        filenames = {
            str(rid): (str(name) if name is not None else None)
            for rid, name in (await session.execute(
                select(RecordingRecord.recording_id, RecordingRecord.filename)
                .where(RecordingRecord.recording_id.in_(ids))
            )).all()
        }

    probes: dict[str, dict[str, Any]] = {}
    for rid in ids:
        run = latest.get(rid)
        bands: dict[str, dict[str, float | int | None]] = {}
        if run is not None:
            for band_key in band_keys:
                summary = summaries.get((int(run.id), band_key))
                if summary is None:
                    continue
                analysis_band = (
                    analysis_bands.get((int(run.analyses_id), band_key))
                    if run.analyses_id is not None
                    else None
                )
                bands[band_key] = _features(summary, analysis_band)
        probes[rid] = {
            "filename": filenames.get(rid),
            "report_run_id": int(run.id) if run is not None else None,
            "report_created_at": run.created_at if run is not None else None,
            "bands": bands,
        }
    return probes


async def probe_contexts(
    recording_ids: list[str], band_key: str,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Контексты проб выборки в одной полосе + честные предупреждения.

    Возвращает ``(rows, warnings)``: ``rows`` — по одной строке на запись
    (``recording_id``, ``filename``, ``report_run_id``, ``report_created_at``,
    ``features``, ``measured``), ``warnings`` — записи без прогона автоотчёта
    или без этой полосы в прогоне (``measured=False``, признаки ``None``).
    Дубли ``recording_ids`` снимаются с сохранением порядка выбора.
    """
    ids = list(dict.fromkeys(str(rid) for rid in recording_ids))
    if not ids:
        return [], ["Выборка пуста: ни одной записи не передано"]
    probes = await _load_probes(ids, [band_key])

    rows: list[dict[str, Any]] = []
    warnings: list[str] = []
    for rid in ids:
        probe = probes[rid]
        features = probe["bands"].get(band_key)
        measured = features is not None
        if probe["report_run_id"] is None:
            warnings.append(f"Запись {rid}: прогонов автоотчёта нет — признаки не измерены")
        elif not measured:
            warnings.append(
                f"Запись {rid}: в последнем прогоне нет полосы «{band_key}» — признаки не измерены"
            )
        rows.append({
            "recording_id": rid,
            "filename": probe["filename"],
            "report_run_id": probe["report_run_id"],
            "report_created_at": probe["report_created_at"],
            "features": features if features is not None else _features(None, None),
            "measured": measured,
        })
    return rows, warnings


async def probe_features_by_band(
    recording_ids: list[str], band_keys: list[str],
) -> dict[str, dict[str, dict[str, float | int | None]]]:
    """Признаки проб по нескольким полосам сразу (срез 5: дельты сравнения).

    Возвращает ``recording_id → band_key → признаки`` **только** по измеренным
    полосам (нет прогона/полосы — ключ отсутствует, а не нули). Потребитель —
    ``compare.py``: дельты признаков слоя B − A для пары записей.
    """
    ids = list(dict.fromkeys(str(rid) for rid in recording_ids))
    if not ids:
        return {}
    probes = await _load_probes(ids, list(band_keys))
    return {rid: dict(probe["bands"]) for rid, probe in probes.items()}