"""Write-API: результаты успешно выполненных задач в таблицы БД (4.4, шаги ② и ③).

Задача, дошедшая до ``succeeded``, оставляет строку — колбэк ``on_success``
``job_manager`` (его ошибки логируются и не валят задачу: расчёт важнее БД,
как у ``save_analysis_to_db``). Состав:

* **шаг ②** — UI-разделы в ``sessions``/``epochs``/``dipoles`` (остаток F21):
  ``preprocess`` (стадия ``epochs`` — сетка и отбраковка), ``dipoles``
  (быстрый расчёт), ``dipole_refine`` (точный фитинг), ``spectrogram``
  (строка прогона без дочерних строк). ``spectrum``/``evoked`` не пишутся —
  их агрегаты живут в кэшах и отчёте (осознанный предел 4.4);
* **шаг ③** — прогон автоотчёта: ``analyses`` + ``analysis_bands`` +
  ``dipole_points`` (кирпичи B7/B6) и ``report_runs`` + ``report_band_summaries``
  + ``report_name_counts`` + ``report_dynamics`` (B13; §8.3
  ``docs/data-blocks.md``).

Инварианты:

* **история, не UPSERT** (§8.4.2): повторный расчёт с тем же отпечатком —
  честная новая строка;
* **TTL строки = TTL записи** (§8.4.3): дочерние строки удаляются каскадно
  вместе с ``recording`` (``recording_store``);
* **полный счёт имён** (§8.4.4): в ``report_name_counts`` идут все имена словаря,
  а не топ-N HTML; полный счёт и точки пакета в результате задачи **не нужны**
  (UI показывает агрегаты) — write-API потребляет их и выкидывает до записи
  файла задачи: ключи ``_package_points`` и ``name_counts``.
"""
import json
import logging
import os
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import asdict, is_dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import case, func, select

from app.core.config import settings
from app.models.db import (
    Analysis,
    AnalysisBand,
    AsyncSessionLocal,
    Dipole,
    DipolePoint,
    EpochRecord,
    ReportBandSummary,
    ReportDynamics,
    ReportNameCount,
    ReportRun,
    Session,
    init_db,
)
from app.services.cache_store import cache_path
from app.services.recordings import Recording

logger = logging.getLogger(__name__)

# Виды задач, чей результат пишется (см. докстринг модуля).
PERSIST_KINDS: tuple[str, ...] = (
    "preprocess", "dipoles", "dipole_refine", "spectrogram", "report",
)


def _params_json(params: Any) -> dict[str, Any] | None:
    """Параметры задачи → JSON-объект (dataclass → dict, вложенные — списки)."""
    if params is None or not is_dataclass(params) or isinstance(params, type):
        return None
    return json.loads(json.dumps(asdict(params), default=str))


def _band_str(band: Any) -> str | None:
    """Границы полосы → подпись для ``sessions.freq_band`` (``0.5-2``)."""
    if not band or len(band) < 2:
        return None
    return f"{float(band[0]):g}-{float(band[1]):g}"


def _point_mni(point: dict[str, Any]) -> tuple[float | None, float | None, float | None]:
    """MNI-координаты точки: None по отдельности, если наводки не было."""
    mni = point.get("mni_coords")
    if not mni or len(mni) < 3:
        return None, None, None
    return float(mni[0]), float(mni[1]), float(mni[2])


def _session_row(
    recording: Recording,
    kind: str,
    job_id: str,
    params: Any,
    *,
    epoch_length_ms: float | None = None,
    freq_band: str | None = None,
    sfreq: float | None = None,
) -> Session:
    """Строка ``sessions`` прогона UI-раздела: паспорт записи + параметры."""
    meta = recording.meta
    return Session(
        id=str(uuid.uuid4()),
        recording_id=recording.recording_id,
        filename=recording.filename,
        n_channels=meta.get("n_channels"),
        sfreq=sfreq if sfreq is not None else meta.get("sfreq"),
        duration_sec=meta.get("duration_sec"),
        epoch_length_ms=epoch_length_ms,
        freq_band=freq_band,
        kind=kind,
        job_id=job_id,
        params_json=_params_json(params),
        created_at=datetime.utcnow(),
    )


async def _persist_preprocess(
    session: Any, recording: Recording, params: Any,
    result: dict[str, Any], job_id: str,
) -> None:
    """Шаг ②: стадия ``epochs`` → строка прогона + сетка эпох с отбраковкой.

    Мощности полос эта стадия не считает (PSD — legacy ``/analyze``), поэтому
    колонки мощностей остаются NULL: честное «не измерено», а не нули.
    """
    if getattr(params, "stage", None) != "epochs":
        return  # строку прогона оставляет только стадия, порождающая эпохи
    epoch_length_ms = float(result.get("epoch_length_ms") or 0.0)
    row = _session_row(
        recording, "preprocess", job_id, params,
        epoch_length_ms=epoch_length_ms,
        freq_band=_band_str(getattr(params, "filter_band", None)),
        sfreq=result.get("sfreq"),
    )
    session.add(row)
    await session.flush()

    rejected = set(result.get("rejected_epochs") or [])
    starts = result.get("epoch_starts_sec")
    n_total = int(result.get("n_epochs_total") or 0)
    for index in range(n_total):
        if starts is not None and index < len(starts):
            start = float(starts[index])
        else:  # регулярная сетка: начало окна = индекс × длина
            start = index * epoch_length_ms / 1000.0
        session.add(EpochRecord(
            session_id=row.id,
            epoch_index=index,
            start_time_sec=start,
            duration_ms=epoch_length_ms,
            has_artifact=1 if index in rejected else 0,
        ))


async def _persist_dipole_scan(
    session: Any, recording: Recording, params: Any,
    result: dict[str, Any], job_id: str,
) -> None:
    """Шаг ②: быстрый расчёт → прогон + эпохи по точкам + строки диполей."""
    freq_band = _band_str(result.get("filter_band_hz"))
    epoch_length_ms = float(
        result.get("epoch_length_ms") or getattr(params, "epoch_length_ms", 0.0) or 0.0
    )
    row = _session_row(
        recording, "dipoles", job_id, params,
        epoch_length_ms=epoch_length_ms,
        freq_band=freq_band,
        sfreq=result.get("sfreq"),
    )
    session.add(row)
    await session.flush()

    points = list(result.get("points") or [])
    epoch_rows: dict[int, EpochRecord] = {}
    for point in points:
        index = int(point.get("epoch_index", -1))
        if index in epoch_rows:
            continue  # одна точка на эпоху; дубль в результате — не двойная строка
        epoch_row = EpochRecord(
            session_id=row.id,
            epoch_index=index,
            start_time_sec=None,  # сетка нарезки в результате не перечисляется
            duration_ms=epoch_length_ms,
            has_artifact=0,  # точка есть только у прошедшей reject эпохи
        )
        session.add(epoch_row)
        epoch_rows[index] = epoch_row
    await session.flush()  # id эпох выдаёт БД — FK должен быть настоящим (F21)

    for point in points:
        index = int(point.get("epoch_index", -1))
        mni_x, mni_y, mni_z = _point_mni(point)
        dipole_epoch = epoch_rows.get(index)
        session.add(Dipole(
            session_id=row.id,
            epoch_id=dipole_epoch.id if dipole_epoch is not None else None,
            time_ms=point.get("time_ms"),
            mni_x=mni_x,
            mni_y=mni_y,
            mni_z=mni_z,
            amplitude_nam=point.get("amplitude_nam"),
            gof=point.get("gof"),
            anatomical_roi=point.get("anatomical_structure"),
            brodmann_area=point.get("brodmann_area"),
            freq_band=freq_band,
            method=result.get("method") or "fast_grid",
        ))


async def _persist_dipole_refine(
    session: Any, recording: Recording, params: Any,
    result: dict[str, Any], job_id: str,
) -> None:
    """Шаг ②: точный фитинг → своя строка прогона + одна эпоха + одна точка.

    «Было/стало» не теряется: уточнение — отдельная строка ``method='bem_fit'``
    (и отдельный прогон с ``params_json.epoch_index``), а не правка точки
    быстрого расчёта — история не UPSERT (§8.4.2).
    """
    scan = getattr(params, "scan", None)
    freq_band = _band_str(getattr(scan, "filter_band", None))
    epoch_length_ms = float(getattr(scan, "epoch_length_ms", 0.0) or 0.0)
    row = _session_row(
        recording, "dipole_refine", job_id, params,
        epoch_length_ms=epoch_length_ms,
        freq_band=freq_band,
    )
    session.add(row)
    await session.flush()

    epoch_index = int(getattr(params, "epoch_index", -1))
    epoch_row = EpochRecord(
        session_id=row.id,
        epoch_index=epoch_index,
        start_time_sec=None,
        duration_ms=epoch_length_ms,
        has_artifact=0,
    )
    session.add(epoch_row)
    await session.flush()

    point = dict(result.get("point") or {})
    point.setdefault("time_ms", result.get("time_ms"))
    mni_x, mni_y, mni_z = _point_mni(point)
    session.add(Dipole(
        session_id=row.id,
        epoch_id=epoch_row.id,
        time_ms=point.get("time_ms"),
        mni_x=mni_x,
        mni_y=mni_y,
        mni_z=mni_z,
        amplitude_nam=point.get("amplitude_nam"),
        gof=point.get("gof"),
        anatomical_roi=point.get("anatomical_structure"),
        brodmann_area=point.get("brodmann_area"),
        freq_band=freq_band,
        method=result.get("method") or "bem_fit",
    ))


async def _persist_spectrogram(
    session: Any, recording: Recording, params: Any,
    result: dict[str, Any], job_id: str,
) -> None:
    """Шаг ②: спектрограмма → строка прогона (сетка каналов — в кэше, не в БД)."""
    session.add(_session_row(
        recording, "spectrogram", job_id, params,
        freq_band=_band_str(result.get("filter_band_hz")),
        sfreq=result.get("sfreq"),
    ))


def _report_html_path(result: dict[str, Any]) -> str | None:
    """Путь HTML отчёта **относительно** ``cache_dir`` (§8.3: в БД — путь)."""
    recording_id = result.get("recording_id")
    signature = result.get("html_sig")
    if not recording_id or not signature:
        return None
    absolute = cache_path(
        settings.cache_dir, "reports", str(recording_id), f"{signature}.html",
    )
    return os.path.relpath(absolute, settings.cache_dir)


async def _persist_report(
    session: Any, recording: Recording, params: Any,
    result: dict[str, Any], job_id: str,
) -> None:
    """Шаг ③: прогон автоотчёта → ``analyses``/``dipole_points`` + ``report_*``.

    Точки пакета приходят внутренним ключом ``_package_points`` (его кладёт
    ``run_report``), полный счёт имён — ``name_counts`` в агрегатах полос
    (§8.4.4). Оба потребляются здесь (``pop``) и не попадают ни в файл задачи,
    ни в ответ UI — там агрегаты.
    """
    points_by_band: dict[str, list[dict[str, Any]]] = dict(
        result.pop("_package_points", None) or {}
    )
    warnings = list(result.get("warnings") or [])
    qc = dict(result.get("qc") or {})
    preprocess = getattr(params, "preprocess", None)
    analysis = Analysis(
        recording_id=recording.recording_id,
        kind="fast_grid",  # пакет отчёта — быстрый расчёт по полосам
        params_sig=result.get("html_sig"),  # отпечаток = repr(params)+сетка+полосы
        created_at=datetime.utcnow(),
        job_id=job_id,
        reference=result.get("reference"),
        channels=list(recording.meta.get("channels") or []),
        sfreq=recording.meta.get("sfreq"),
        epoch_length_ms=float(getattr(preprocess, "epoch_length_ms", 0.0) or 0.0)
        if preprocess is not None else None,
        grid_mm=float(getattr(params, "grid_mm", 0.0) or 0.0),
        n_epochs_total=result.get("n_epochs_total"),
        n_epochs_used=result.get("n_epochs_used"),
        warnings=warnings,
        duration_sec_calc=result.get("duration_sec_calc"),
    )
    session.add(analysis)
    await session.flush()

    for summary in result.get("bands") or []:
        band_key = str(summary.get("band_key") or "")
        band_hz = summary.get("band_hz") or [None, None]
        points = list(points_by_band.get(band_key) or [])

        # Базис КД (§2.2 data-blocks): максимум момента — внутри полосы;
        # пороги задаёт методика (concept.md §3, C0) — без них вердикт NULL.
        amplitudes = [
            float(p["amplitude_nam"]) for p in points if p.get("amplitude_nam") is not None
        ]
        moment_max = max(amplitudes) if amplitudes else None
        share = settings.kd_moment_share
        gof_min = settings.kd_gof_min
        evaluated = (
            share is not None and gof_min is not None and moment_max is not None
        )
        kd_basis = {
            "moment_share_x": share,
            "gof_min": gof_min,
            "moment_max_nam": moment_max,
        }

        verdicts: list[int | None] = []
        for point in points:
            amplitude = point.get("amplitude_nam")
            gof = point.get("gof")
            verdict: int | None = None
            if (
                share is not None and gof_min is not None and moment_max is not None
                and amplitude is not None and gof is not None
            ):
                verdict = int(
                    float(amplitude) >= share * moment_max and float(gof) >= gof_min
                )
            verdicts.append(verdict)
        n_kd_passed = sum(v for v in verdicts if v) if evaluated else None

        session.add(AnalysisBand(
            analysis_id=analysis.id,
            band_key=band_key,
            band_hz_lo=band_hz[0],
            band_hz_hi=band_hz[1],
            state="ok" if points else "empty",
            n_points=len(points),
            n_kd_passed=n_kd_passed,
            n_errors=len(summary.get("warnings") or []),
            moment_max_nam=moment_max,
        ))
        for point, verdict in zip(points, verdicts, strict=True):
            session.add(DipolePoint(
                analysis_id=analysis.id,
                band_key=band_key,
                band_hz_lo=band_hz[0],
                band_hz_hi=band_hz[1],
                epoch_index=point.get("epoch_index"),
                peak_time_ms=point.get("time_ms"),
                head_coords=point.get("head_coords"),
                mni_coords=point.get("mni_coords"),
                moment_dir=point.get("moment"),
                amplitude_nam=point.get("amplitude_nam"),
                gof=point.get("gof"),
                anatomical_structure=point.get("anatomical_structure"),
                brodmann_area=point.get("brodmann_area"),
                method="fast_grid",
                kd_passed=verdict,
                kd_basis=kd_basis,
            ))

    run = ReportRun(
        recording_id=recording.recording_id,
        analyses_id=analysis.id,  # вариант (а): одна истина на прогон (§8.3)
        params_sig=result.get("html_sig"),
        created_at=datetime.utcnow(),
        job_id=job_id,
        n_epochs_total=result.get("n_epochs_total"),
        n_epochs_used=result.get("n_epochs_used"),
        n_epochs_rejected=result.get("rejected_epochs"),
        qc_status=qc.get("status"),
        good_data_percent=qc.get("good_data_percent"),
        warnings=warnings,
        duration_sec_calc=result.get("duration_sec_calc"),
        html_path=_report_html_path(result),
        html_version=result.get("report_version"),
    )
    session.add(run)
    await session.flush()

    for summary in result.get("bands") or []:
        band_key = str(summary.get("band_key") or "")
        band_hz = summary.get("band_hz") or [None, None]
        session.add(ReportBandSummary(
            report_run_id=run.id,
            band_key=band_key,
            band_hz_lo=band_hz[0],
            band_hz_hi=band_hz[1],
            n_epochs_used=summary.get("n_epochs_used"),
            n_points=summary.get("n_points"),
            n_no_attribution=summary.get("n_no_attribution"),
            median_gof=summary.get("median_gof"),
            median_riv=summary.get("median_riv"),
        ))
        # Полный счёт имён (§8.4.4): из результата убираем — UI достаточно топов.
        counts = summary.pop("name_counts", None) or {}
        for kind in ("structure", "brodmann"):
            for row in counts.get(kind) or []:
                session.add(ReportNameCount(
                    report_run_id=run.id,
                    band_key=band_key,
                    kind=kind,
                    name=row.get("name"),
                    count=row.get("count"),
                    share=row.get("share"),
                    median_gof=row.get("median_gof"),
                ))
        for row in summary.get("dynamics") or []:
            for bin_index, share_value in enumerate(row.get("shares") or []):
                session.add(ReportDynamics(
                    report_run_id=run.id,
                    band_key=band_key,
                    name=row.get("name"),
                    bin_index=bin_index,
                    share=share_value,
                ))


_PERSISTERS: dict[
    str,
    Callable[[Any, Recording, Any, dict[str, Any], str], Awaitable[None]],
] = {
    "preprocess": _persist_preprocess,
    "dipoles": _persist_dipole_scan,
    "dipole_refine": _persist_dipole_refine,
    "spectrogram": _persist_spectrogram,
    "report": _persist_report,
}


async def persist_recording_result(
    kind: str,
    recording: Recording,
    params: Any,
    result: dict[str, Any],
    job_id: str,
) -> None:
    """Пишет результат задачи в БД (dispatcher; сбой поднимает исключение)."""
    persist = _PERSISTERS.get(kind)
    if persist is None:
        return  # spectrum/evoked не пишутся (предел 4.4) — молча
    await init_db()
    async with AsyncSessionLocal() as session:
        await persist(session, recording, params, result, job_id)
        await session.commit()
    logger.debug("Задача %s (%s): результат записан в БД", job_id, kind)


def on_success_callback(
    kind: str, recording: Recording, params: Any,
) -> Callable[..., Awaitable[None]] | None:
    """``on_success`` для ``job_manager.submit``: пишет строку при успехе.

    ``None`` для видов задач, которые не пишутся. Ошибки записи перехватывает
    сам ``job_manager`` («Постобработка задачи … не выполнена»): задача остаётся
    успешной — расчёт важнее БД.
    """
    if kind not in _PERSISTERS:
        return None

    async def _callback(job: Any, result: dict[str, Any]) -> None:
        await persist_recording_result(kind, recording, params, result, job.job_id)

    return _callback


# ---------- read-API сессий (4.7): чтение sessions/epochs/dipoles ------------
#
# Вход группового анализа Фазы 5: список/паспорт сессий и их дочерние строки
# теми же строками, что write-API. Инварианты read — `docs/rules/results-db.md`:
# 404 на неизвестную сессию (не пустой список), счётчики считаются запросами
# на страницу (не N+1), мощности эпох — честные None «не измерено».


def epoch_powers(row: EpochRecord) -> dict[str, float | None]:
    """Мощности эпохи по ключам ``settings.freq_bands`` (колонка = ключ + ``_power``).

    ``None`` — колонка не измерена (задачи UI пишут сетку без PSD; legacy мог
    не заполнить все полосы) — честный прочерк, а не ноль.
    """
    return {key: getattr(row, f"{key}_power", None) for key in settings.freq_bands}


def _session_summary(
    row: Session, counts: tuple[int, int, int],
) -> dict[str, Any]:
    """Строка списка/паспорта: поля строки + (эпохи, отброшено, диполи)."""
    n_epochs, n_rejected, n_dipoles = counts
    return {
        "id": row.id,
        "recording_id": row.recording_id,
        "kind": row.kind or "legacy",
        "filename": row.filename,
        "n_channels": row.n_channels,
        "sfreq": row.sfreq,
        "duration_sec": row.duration_sec,
        "epoch_length_ms": row.epoch_length_ms,
        "freq_band": row.freq_band,
        "created_at": row.created_at,
        "n_epochs": n_epochs,
        "n_epochs_rejected": n_rejected,
        "n_dipoles": n_dipoles,
    }


async def _children_counts(
    session: Any, ids: list[str],
) -> dict[str, tuple[int, int, int]]:
    """``session_id → (эпохи, отброшено, диполи)`` — три групповых запроса на страницу."""
    if not ids:
        return {}
    epoch_rows = await session.execute(
        select(
            EpochRecord.session_id,
            func.count(),
            func.coalesce(func.sum(case((EpochRecord.has_artifact == 1, 1), else_=0)), 0),
        )
        .where(EpochRecord.session_id.in_(ids))
        .group_by(EpochRecord.session_id)
    )
    dipole_rows = await session.execute(
        select(Dipole.session_id, func.count())
        .where(Dipole.session_id.in_(ids))
        .group_by(Dipole.session_id)
    )
    counts: dict[str, tuple[int, int, int]] = {
        row_id: (int(n_epochs), int(n_rejected), 0)
        for row_id, n_epochs, n_rejected in epoch_rows.all()
    }
    for row_id, n_dipoles in dipole_rows.all():
        n_epochs, n_rejected, _ = counts.get(row_id, (0, 0, 0))
        counts[row_id] = (n_epochs, n_rejected, int(n_dipoles))
    return counts


async def list_sessions(
    *,
    recording_id: str | None = None,
    kind: str | None = None,
    limit: int,
    offset: int,
) -> tuple[int, list[dict[str, Any]]]:
    """Страница сессий с агрегатами детей: ``(total, строки под SessionSummaryOut)``.

    Сортировка — новые сверху (``created_at DESC``), ``total`` считается до
    ``limit/offset`` — пагинация не прячет общий размер.
    """
    await init_db()
    async with AsyncSessionLocal() as session:
        conditions: list[Any] = []
        if recording_id is not None:
            conditions.append(Session.recording_id == recording_id)
        if kind is not None:
            conditions.append(Session.kind == kind)
        total = int(
            (await session.execute(
                select(func.count()).select_from(Session).where(*conditions)
            )).scalar() or 0
        )
        rows = list((await session.scalars(
            select(Session)
            .where(*conditions)
            .order_by(Session.created_at.desc(), Session.id)
            .limit(limit)
            .offset(offset)
        )).all())
        counts = await _children_counts(session, [str(row.id) for row in rows])
        return total, [
            _session_summary(row, counts.get(str(row.id), (0, 0, 0)))
            for row in rows
        ]


async def get_session_detail(session_id: str) -> dict[str, Any] | None:
    """Паспорт сессии + счётчики + ключи мощностей; ``None`` — не найдена."""
    await init_db()
    async with AsyncSessionLocal() as session:
        row = await session.get(Session, session_id)
        if row is None:
            return None
        counts = await _children_counts(session, [str(row.id)])
        detail = _session_summary(row, counts.get(str(row.id), (0, 0, 0)))
        detail["power_bands"] = list(settings.freq_bands)
        return detail


async def list_session_epochs(
    session_id: str, *, limit: int, offset: int,
) -> list[dict[str, Any]] | None:
    """Эпохи сессии (по ``epoch_index``); ``None`` — сессии нет."""
    await init_db()
    async with AsyncSessionLocal() as session:
        if await session.get(Session, session_id) is None:
            return None
        rows = list((await session.scalars(
            select(EpochRecord)
            .where(EpochRecord.session_id == session_id)
            .order_by(EpochRecord.epoch_index, EpochRecord.id)
            .limit(limit)
            .offset(offset)
        )).all())
        return [
            {
                "session_id": row.session_id,
                "epoch_index": row.epoch_index,
                "start_time_sec": row.start_time_sec,
                "duration_ms": row.duration_ms,
                "has_artifact": bool(row.has_artifact),
                "powers": epoch_powers(row),
            }
            for row in rows
        ]


async def list_session_dipoles(
    session_id: str, *,
    freq_band: str | None = None,
    limit: int,
    offset: int,
) -> list[dict[str, Any]] | None:
    """Диполи сессии (по эпохам); ``None`` — сессии нет. ``freq_band`` — фильтр полосы."""
    await init_db()
    async with AsyncSessionLocal() as session:
        if await session.get(Session, session_id) is None:
            return None
        conditions = [Dipole.session_id == session_id]
        if freq_band is not None:
            conditions.append(Dipole.freq_band == freq_band)
        rows = list((await session.scalars(
            select(Dipole)
            .where(*conditions)
            .order_by(Dipole.epoch_id, Dipole.id)
            .limit(limit)
            .offset(offset)
        )).all())
        return [
            {
                "session_id": row.session_id,
                "epoch_id": row.epoch_id,
                "time_ms": row.time_ms,
                "mni": _dipole_mni(row),
                "amplitude_nam": row.amplitude_nam,
                "gof": row.gof,
                "anatomical_roi": row.anatomical_roi,
                "brodmann_area": row.brodmann_area,
                "freq_band": row.freq_band,
                "method": row.method,
            }
            for row in rows
        ]


def _dipole_mni(row: Dipole) -> list[float] | None:
    """``[x, y, z]`` мм или ``None`` — MNI не считался (хотя бы одна NULL)."""
    if row.mni_x is None or row.mni_y is None or row.mni_z is None:
        return None
    return [float(row.mni_x), float(row.mni_y), float(row.mni_z)]
