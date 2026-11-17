"""Read-model готовности записей: результаты БД по стадиям (раздел «БД»).

Раздел «БД» (UI) показывает все записи и **степень готовности записанных в БД
результатов расчётов** — с параметрами, с которыми считалось (чистка, нарезка
эпох, полосы, диполи, отчёт). Модуль собирает страницу из источников write-API
4.4 (``docs/rules/results-db.md``):

* ``recordings`` — паспорт записи (зеркало реестра, upsert);
* ``sessions`` (``kind`` = ``preprocess``/``dipoles``/``dipole_refine``/
  ``spectrogram``) — параметры прогонов UI в ``params_json``;
* ``analyses`` + ``analysis_bands`` — прогоны пакета поддиапазонов (полосы);
* ``report_runs`` — прогоны автоотчёта (QC, HTML).

Шаблоны сборки и фильтрации (групповые запросы на страницу, не N+1) — раздел
«Шаблоны сбора готовности» в ``docs/rules/results-db.md``. Инварианты read-API
те же: ``total`` считается до пагинации, ``None`` — «не измерено», а не 0;
показываются **последний** прогон стадии и ``n_runs`` (история остаётся
полной: повторный расчёт — новая строка, §8.4.2). Legacy-сессии без
``recording_id`` в таблицу не входят: у них нет записи в зеркале ``recordings``.
"""
import logging
from typing import Any

from sqlalchemy import exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.db import (
    Analysis,
    AnalysisBand,
    AsyncSessionLocal,
    Dipole,
    DipolePoint,
    EpochRecord,
    RecordingRecord,
    ReportRun,
    Session,
    init_db,
)

logger = logging.getLogger(__name__)

# Сетка стадий готовности: каждая — независимо записываемый результат write-API.
STAGES: tuple[str, ...] = (
    "preprocess", "dipoles", "package", "report", "spectrogram",
)

# ``sessions.kind`` → стадия; legacy (``kind='legacy'``, ``recording_id`` NULL)
# сюда не попадает — отдельно проверяется фильтром по записи.
_SESSION_KIND_STAGE: dict[str, str] = {
    "preprocess": "preprocess",
    "dipoles": "dipoles",
    "dipole_refine": "dipoles",
    "spectrogram": "spectrogram",
}

# Метод дипольного прогона по виду сессии (``dipoles.method`` пишет write-API).
_SESSION_KIND_METHOD: dict[str, str] = {
    "dipoles": "fast_grid",
    "dipole_refine": "bem_fit",
}


def _band_pair(value: Any) -> list[float] | None:
    """``filter_band`` → ``[lo, hi]`` Гц; ``None`` — фильтра нет («без фильтра»)."""
    if not value or len(value) < 2 or value[0] is None or value[1] is None:
        return None
    return [float(value[0]), float(value[1])]


def _session_stage_params(
    row: Session,
    *,
    epoch_counts: tuple[int, int] | None = None,
    n_dipoles: int | None = None,
) -> dict[str, Any]:
    """Курируемая сводка параметров прогона ``sessions`` (``params_json`` → словарь).

    Свободный JSON разных dataclass'ов задач схлопывается в **стабильный**
    словарь полей контракта: чего в прогоне не было — ``None`` («не измерено»).
    Уточнение диполя хранит параметры скана вложенными (``params_json.scan``) —
    они раскрываются теми же ключами.
    """
    raw: dict[str, Any] = dict(row.params_json or {})
    scan = raw.get("scan")
    if isinstance(scan, dict):
        raw = {**scan, **{key: value for key, value in raw.items() if key != "scan"}}
    params: dict[str, Any] = {
        "filter_band_hz": _band_pair(raw.get("filter_band")),
        "notch_hz": raw.get("notch_hz"),
        "notch_harmonics": raw.get("notch_harmonics"),
        "reference": raw.get("reference"),
        "reference_channels": raw.get("reference_channels"),
        "clean_method": raw.get("clean_method"),
        "ica_n_components": raw.get("ica_n_components"),
        "interpolate_bads": raw.get("interpolate_bads"),
        "bad_channels": raw.get("bad_channels"),
        "z_threshold": raw.get("z_threshold"),
        "pp_threshold_uv": raw.get("pp_threshold_uv"),
        "flat_line_uv": raw.get("flat_line_uv"),
        "flat_line_ms": raw.get("flat_line_ms"),
        "epoch_length_ms": raw.get("epoch_length_ms", row.epoch_length_ms),
        "epoch_mode": raw.get("epoch_mode"),
        "event_id": raw.get("event_id"),
        "epoch_pre_ms": raw.get("epoch_pre_ms"),
        "epoch_post_ms": raw.get("epoch_post_ms"),
        "grid_mm": raw.get("grid_mm"),
        "method": _SESSION_KIND_METHOD.get(str(row.kind or "")),
        "freq_band": row.freq_band,
        "channel": raw.get("channel"),
        "window_ms": raw.get("window_ms"),
        "overlap_pct": raw.get("overlap_pct"),
        "fmax_hz": raw.get("fmax_hz"),
    }
    if epoch_counts is not None:
        n_total, n_rejected = epoch_counts
        params["n_epochs_total"] = n_total
        params["n_epochs_rejected"] = n_rejected
        params["n_epochs_used"] = n_total - n_rejected
    if n_dipoles is not None:
        params["n_dipoles"] = n_dipoles
    return params


def _analysis_params(
    row: Analysis, bands: list[dict[str, Any]], n_points: int | None,
) -> dict[str, Any]:
    """Сводка параметров прогона пакета (``analyses`` + ``analysis_bands``)."""
    return {
        "grid_mm": row.grid_mm,
        "epoch_length_ms": row.epoch_length_ms,
        "reference": row.reference,
        "n_epochs_total": row.n_epochs_total,
        "n_epochs_used": row.n_epochs_used,
        "method": row.kind,
        "freq_band": None,
        "bands": bands,
        "n_dipoles": n_points,
    }


def _report_params(row: ReportRun, bands: list[dict[str, Any]]) -> dict[str, Any]:
    """Сводка параметров прогона автоотчёта (``report_runs`` + полосы пакета)."""
    return {
        "qc_status": row.qc_status,
        "good_data_percent": row.good_data_percent,
        "n_epochs_total": row.n_epochs_total,
        "n_epochs_used": row.n_epochs_used,
        "n_epochs_rejected": row.n_epochs_rejected,
        "html_path": row.html_path,
        "bands": bands,
    }


def _band_payload(band: AnalysisBand) -> dict[str, Any]:
    """Строка ``analysis_bands`` под ``AnalysisBandOut`` (NULL не достраивается)."""
    return {
        "band_key": band.band_key,
        "band_hz_lo": band.band_hz_lo,
        "band_hz_hi": band.band_hz_hi,
        "state": band.state,
        "n_points": band.n_points,
        "n_kd_passed": band.n_kd_passed,
        "n_errors": band.n_errors,
        "moment_max_nam": band.moment_max_nam,
    }


async def _epoch_counts(
    session: AsyncSession, session_ids: list[str],
) -> dict[str, tuple[int, int]]:
    """``session_id → (нарезано, отбраковано)`` — один групповой запрос (шаблон C)."""
    if not session_ids:
        return {}
    rows: Any = await session.execute(
        select(
            EpochRecord.session_id,
            func.count(),
            func.coalesce(func.sum(EpochRecord.has_artifact), 0),
        )
        .where(EpochRecord.session_id.in_(session_ids))
        .group_by(EpochRecord.session_id)
    )
    return {
        str(row_id): (int(n_total), int(n_rejected))
        for row_id, n_total, n_rejected in rows.all()
    }


async def _dipole_counts(
    session: AsyncSession, session_ids: list[str],
) -> dict[str, int]:
    """``session_id → строк dipoles`` — один групповой запрос."""
    if not session_ids:
        return {}
    rows: Any = await session.execute(
        select(Dipole.session_id, func.count())
        .where(Dipole.session_id.in_(session_ids))
        .group_by(Dipole.session_id)
    )
    return {str(row_id): int(n_rows) for row_id, n_rows in rows.all()}


async def _point_counts(
    session: AsyncSession, analysis_ids: list[int],
) -> dict[int, int]:
    """``analysis_id → точек пакета`` — один групповой запрос."""
    if not analysis_ids:
        return {}
    rows: Any = await session.execute(
        select(DipolePoint.analysis_id, func.count())
        .where(DipolePoint.analysis_id.in_(analysis_ids))
        .group_by(DipolePoint.analysis_id)
    )
    return {int(row_id): int(n_rows) for row_id, n_rows in rows.all()}


async def _bands_by_analysis(
    session: AsyncSession, analysis_ids: list[int],
) -> dict[int, list[dict[str, Any]]]:
    """``analysis_id → полосы пакета`` — один запрос на все прогоны страницы."""
    if not analysis_ids:
        return {}
    bands = list((await session.scalars(
        select(AnalysisBand)
        .where(AnalysisBand.analysis_id.in_(analysis_ids))
        .order_by(AnalysisBand.analysis_id, AnalysisBand.id)
    )).all())
    grouped: dict[int, list[dict[str, Any]]] = {}
    for band in bands:
        grouped.setdefault(int(band.analysis_id), []).append(_band_payload(band))
    return grouped


def _has_results() -> Any:
    """``EXISTS``-шаблон фильтра «только обработанные» (шаблон D, results-db)."""
    return or_(
        exists(select(Session.id).where(Session.recording_id == RecordingRecord.recording_id)),
        exists(select(Analysis.id).where(Analysis.recording_id == RecordingRecord.recording_id)),
        exists(select(ReportRun.id).where(ReportRun.recording_id == RecordingRecord.recording_id)),
    )


def _recording_payload(row: RecordingRecord) -> dict[str, Any]:
    """Паспорт записи (``RecordingReadinessOut``): зеркало ``recordings`` как есть."""
    return {
        "recording_id": str(row.recording_id),
        "filename": row.filename,
        "patient_alias": row.patient_alias,
        "n_channels": row.n_channels,
        "sfreq": row.sfreq,
        "duration_sec": row.duration_sec,
        "created_at": row.created_at,
        "accessed_at": row.accessed_at,
    }


async def _session_runs(
    session: AsyncSession, recording_ids: list[str],
) -> dict[str, list[Session]]:
    """Все сессии записей, новые сверху (история стадий preprocess/dipoles/…)."""
    if not recording_ids:
        return {}
    rows = list((await session.scalars(
        select(Session)
        .where(Session.recording_id.in_(recording_ids))
        .order_by(Session.created_at.desc(), Session.id.desc())
    )).all())
    grouped: dict[str, list[Session]] = {}
    for row in rows:
        grouped.setdefault(str(row.recording_id), []).append(row)
    return grouped


async def _analysis_runs(
    session: AsyncSession, recording_ids: list[str],
) -> dict[str, list[Analysis]]:
    """Все прогоны пакета записей, новые сверху."""
    if not recording_ids:
        return {}
    rows = list((await session.scalars(
        select(Analysis)
        .where(Analysis.recording_id.in_(recording_ids))
        .order_by(Analysis.created_at.desc(), Analysis.id.desc())
    )).all())
    grouped: dict[str, list[Analysis]] = {}
    for row in rows:
        grouped.setdefault(str(row.recording_id), []).append(row)
    return grouped


async def _report_runs(
    session: AsyncSession, recording_ids: list[str],
) -> dict[str, list[ReportRun]]:
    """Все прогоны автоотчёта записей, новые сверху."""
    if not recording_ids:
        return {}
    rows = list((await session.scalars(
        select(ReportRun)
        .where(ReportRun.recording_id.in_(recording_ids))
        .order_by(ReportRun.created_at.desc(), ReportRun.id.desc())
    )).all())
    grouped: dict[str, list[ReportRun]] = {}
    for row in rows:
        grouped.setdefault(str(row.recording_id), []).append(row)
    return grouped


def _stage_summary(
    stage: str, runs: list[dict[str, Any]], *, full_history: bool,
) -> dict[str, Any]:
    """Сводка стадии: последний прогон параметрами + ``n_runs`` (история полна)."""
    latest = runs[0] if runs else None  # список уже «новые сверху»
    return {
        "stage": stage,
        "state": "ready" if latest is not None else "none",
        "n_runs": len(runs),
        "last_run_at": latest["created_at"] if latest is not None else None,
        "job_id": latest["job_id"] if latest is not None else None,
        "params_sig": latest["params_sig"] if latest is not None else None,
        "params": latest["params"] if latest is not None else None,
        "runs": runs if full_history else [],
    }


def _readiness_counts(stages: list[dict[str, Any]]) -> tuple[int, int]:
    """``(готово, всего)`` — степень готовности записи (стадии с результатами)."""
    ready = sum(1 for stage in stages if stage["state"] == "ready")
    return ready, len(stages)


async def _stages_for(
    session: AsyncSession, recording_ids: list[str], *, full_history: bool,
) -> dict[str, list[dict[str, Any]]]:
    """``recording_id → [сводка стадии × STAGES]`` — сборка из четырёх источников.

    ``full_history=False`` (страница) в каждой стадии несёт только последний
    прогон (``runs`` пуст); ``True`` (карточка) — всю историю прогонов. Все
    запросы — групповые по списку записей (шаблоны A–C
    ``docs/rules/results-db.md``), не N+1.
    """
    sessions = await _session_runs(session, recording_ids)
    analyses = await _analysis_runs(session, recording_ids)
    reports = await _report_runs(session, recording_ids)

    preprocess_ids = [
        str(row.id)
        for rows in sessions.values()
        for row in rows
        if (row.kind or "") == "preprocess"
    ]
    dipole_ids = [
        str(row.id)
        for rows in sessions.values()
        for row in rows
        if (row.kind or "") in ("dipoles", "dipole_refine")
    ]
    analysis_ids = [int(row.id) for rows in analyses.values() for row in rows]
    report_analysis_ids = [
        int(row.analyses_id)
        for rows in reports.values()
        for row in rows
        if row.analyses_id is not None
    ]
    epochs = await _epoch_counts(session, preprocess_ids)
    dipoles = await _dipole_counts(session, dipole_ids)
    points = await _point_counts(session, analysis_ids + report_analysis_ids)
    bands = await _bands_by_analysis(session, analysis_ids + report_analysis_ids)

    result: dict[str, list[dict[str, Any]]] = {}
    for recording_id in recording_ids:
        stage_runs: dict[str, list[dict[str, Any]]] = {key: [] for key in STAGES}
        for session_row in sessions.get(recording_id, []):
            stage = _SESSION_KIND_STAGE.get(str(session_row.kind or ""))
            if stage is None:
                continue  # legacy-виды без стадии готовности
            stage_runs[stage].append({
                "job_id": session_row.job_id,
                "created_at": session_row.created_at,
                "params_sig": None,
                "params": _session_stage_params(
                    session_row,
                    epoch_counts=(
                        epochs.get(str(session_row.id)) if stage == "preprocess" else None
                    ),
                    n_dipoles=(
                        dipoles.get(str(session_row.id)) if stage == "dipoles" else None
                    ),
                ),
            })
        for analysis_row in analyses.get(recording_id, []):
            stage_runs["package"].append({
                "job_id": analysis_row.job_id,
                "created_at": analysis_row.created_at,
                "params_sig": analysis_row.params_sig,
                "params": _analysis_params(
                    analysis_row,
                    bands.get(int(analysis_row.id), []),
                    points.get(int(analysis_row.id)),
                ),
            })
        for report_row in reports.get(recording_id, []):
            linked = (
                bands.get(int(report_row.analyses_id), [])
                if report_row.analyses_id is not None
                else []
            )
            stage_runs["report"].append({
                "job_id": report_row.job_id,
                "created_at": report_row.created_at,
                "params_sig": report_row.params_sig,
                "params": _report_params(report_row, linked),
            })
        result[recording_id] = [
            _stage_summary(stage, stage_runs[stage], full_history=full_history)
            for stage in STAGES
        ]
    return result


async def list_recordings_readiness(
    *,
    only_processed: bool = False,
    patient_alias: str | None = None,
    search: str | None = None,
    sort: str = "created",
    limit: int,
    offset: int,
) -> tuple[int, list[dict[str, Any]]]:
    """Страница готовности записей: ``(total, строки под RecordingReadinessOut)``.

    Фильтры (шаблоны D–E ``docs/rules/results-db.md``): ``only_processed`` —
    только записи с записанными результатами (``EXISTS`` по детям),
    ``patient_alias`` — точное совпадение псевдонима, ``search`` — подстрока
    файла/псевдонима. Сортировка (шаблон F) — ``created`` (новые сверху),
    ``name`` (по имени файла), ``readiness`` (по готовности, затем новые сверху).

    Пагинация — срез строк ``recordings`` **до** сборки стадий: ``_stages_for``
    работает только со страницей, стоимость ответа привязана к размеру
    страницы, а не к накопленной истории прогонов. Ключ ``readiness``
    производный (готовность собирается из детей) — он считается узкими
    EXISTS-признаками (``_ready_counts``, без сборки стадий), после чего набор
    id сортируется устойчивой двойной сортировкой (новые сверху → по готовности)
    и режется ``offset:limit``; ``total`` честный при любой сортировке.
    """
    await init_db()
    async with AsyncSessionLocal() as session:
        conditions: list[Any] = []
        if only_processed:
            conditions.append(_has_results())
        if patient_alias is not None:
            conditions.append(RecordingRecord.patient_alias == patient_alias)
        if search:
            pattern = f"%{search}%"
            conditions.append(or_(
                RecordingRecord.filename.ilike(pattern),
                RecordingRecord.patient_alias.ilike(pattern),
            ))
        total = int(
            (await session.execute(
                select(func.count()).select_from(RecordingRecord).where(*conditions)
            )).scalar() or 0
        )
        rows = await _page_rows(
            session, conditions, sort=sort, limit=limit, offset=offset,
        )
        stages_by_recording = await _stages_for(
            session, [str(row.recording_id) for row in rows], full_history=False,
        )
        items: list[dict[str, Any]] = []
        for row in rows:
            recording_id = str(row.recording_id)
            stages = stages_by_recording.get(recording_id, [])
            ready, total_stages = _readiness_counts(stages)
            items.append({
                **_recording_payload(row),
                "readiness_ready": ready,
                "readiness_total": total_stages,
                "stages": stages,
            })
        return total, items


async def _page_rows(
    session: AsyncSession, conditions: list[Any], *, sort: str, limit: int, offset: int,
) -> list[RecordingRecord]:
    """Страница строк ``recordings`` в порядке сортировки (шаблон F), без стадий.

    ``created``/``name`` — SQL ``ORDER BY`` + ``LIMIT/OFFSET``; ``readiness`` —
    производный ключ: сначала готовность по всему отбору узкими признаками
    (``_ready_counts``), затем устойчивая двойная сортировка id (новые сверху →
    по готовности) и срез страницы.
    """
    if sort == "readiness":
        ready_counts = await _ready_counts(session, conditions)
        # list() + аннотация: SQLAlchemy >= 2.1 (var-annotated в CI).
        id_rows: list[str] = list((await session.scalars(
            select(RecordingRecord.recording_id)
            .where(*conditions)
            .order_by(RecordingRecord.created_at.desc(), RecordingRecord.recording_id)
        )).all())
        ordered = sorted(id_rows, key=lambda rid: -ready_counts.get(str(rid), 0))
        page_ids = ordered[offset:offset + limit]
        if not page_ids:
            return []
        page_rows: list[RecordingRecord] = list((await session.scalars(
            select(RecordingRecord).where(RecordingRecord.recording_id.in_(page_ids))
        )).all())
        by_id = {str(row.recording_id): row for row in page_rows}
        return [by_id[rid] for rid in page_ids if rid in by_id]
    if sort == "name":
        # Без учёта регистра, запись без имени — по id (nullif: пустое имя = NULL).
        name_key = func.lower(func.coalesce(
            func.nullif(RecordingRecord.filename, ""), RecordingRecord.recording_id,
        ))
        order_by: list[Any] = [name_key, RecordingRecord.recording_id]
    else:  # created: «новые сверху» — порядок ORDER BY выборки
        order_by = [RecordingRecord.created_at.desc(), RecordingRecord.recording_id]
    return list((await session.scalars(
        select(RecordingRecord)
        .where(*conditions)
        .order_by(*order_by)
        .limit(limit)
        .offset(offset)
    )).all())


async def _ready_counts(
    session: AsyncSession, conditions: list[Any],
) -> dict[str, int]:
    """``recording_id → готовых стадий`` — узкий запрос пяти EXISTS-признаков.

    Стадия «готова», если есть хотя бы один её прогон — та же семантика, что и
    у ``_readiness_counts`` по сводкам стадий, но без сборки стадий и их
    параметров (нужно только сортировке ``readiness``, шаблон D). Порядок
    признаков повторяет ``STAGES``: preprocess, dipoles, package, report,
    spectrogram.
    """
    rows: Any = await session.execute(
        select(
            RecordingRecord.recording_id,
            exists(select(Session.id).where(
                Session.recording_id == RecordingRecord.recording_id,
                Session.kind == "preprocess",
            )),
            exists(select(Session.id).where(
                Session.recording_id == RecordingRecord.recording_id,
                Session.kind.in_(("dipoles", "dipole_refine")),
            )),
            exists(select(Analysis.id).where(
                Analysis.recording_id == RecordingRecord.recording_id,
            )),
            exists(select(ReportRun.id).where(
                ReportRun.recording_id == RecordingRecord.recording_id,
            )),
            exists(select(Session.id).where(
                Session.recording_id == RecordingRecord.recording_id,
                Session.kind == "spectrogram",
            )),
        ).where(*conditions)
    )
    return {
        str(recording_id): sum(1 for flag in flags if flag)
        for recording_id, *flags in rows.all()
    }


async def get_recording_readiness(recording_id: str) -> dict[str, Any] | None:
    """Карточка готовности записи: стадии с полной историей прогонов; ``None`` — нет.

    Строки без записи в зеркале ``recordings`` (legacy-загрузки до 4.4) карточки
    не имеют: их результаты не привязаны к записи в БД.
    """
    await init_db()
    async with AsyncSessionLocal() as session:
        row = await session.get(RecordingRecord, recording_id)
        if row is None:
            return None
        stages_by_recording = await _stages_for(
            session, [recording_id], full_history=True,
        )
        stages = stages_by_recording.get(recording_id, [])
        ready, total_stages = _readiness_counts(stages)
        return {
            **_recording_payload(row),
            "readiness_ready": ready,
            "readiness_total": total_stages,
            "stages": stages,
        }