"""Прогон по набору поддиапазонов (С1, кирпич B7) и кластеры диполей (С2, B8).

«Северная звезда» методики (``concept.md`` §3): не одна точка на эпоху, а
**наборы диполей по поддиапазонам**, из которых считаются кластеры. Здесь —
пакетный прогон: один запуск по списку полос (узкие поддиапазоны δ/θ/α… и
отдельные частоты), набор результатов и их сопоставление.

Правила пакета (``docs/rules/dipoles.md``, «Пакетный сценарий»):

* **одна сетка эпох на прогон** (п.7): длина эпохи — свойство прогона, не
  полосы; ключ наблюдения — «эпоха × поддиапазон + момент пика GFP своей
  полосы» (``docs/data-blocks.md`` §3);
* **GOF между полосами не сравним** (принцип 3): в сопоставление полос уходят
  только нормированные величины (доля от максимума момента своей полосы, доля
  прошедших КД) и единственный кросс-полосной фильтр доверия — медианный RIV;
  GOF живёт только внутри своей полосы;
* **КД — параметр анализа** (С0): вердикты ``kd_passed`` считаются здесь же
  (``services/kd_criteria.py``) и решают, что попадает в кластеры;
* **eLORETA/LCMV — не часть пакета** (п.5): только ``fast_grid`` по полосам.

Переиспользование на пакет (С1, ``audits/audit_qwen.md`` §7.1): ядро перебора
сетки (свинцовое поле `G` = forward и обращённая `GᵀG` = inverse-ядро МНК)
строится **один раз** на прогон (``shared_scan_kernel``) и переиспользуется
всеми полосами; подготовленный сигнал, BEM/ковариация и атлас — общие кэши.
Для eLORETA то же сделано с MNE-операторами (``eloreta._forward_inverse``).

Кластеры (С2, B8): параметры — в нормированных единицах (доля от диаметра
области поиска, ``dipole_clusters.resolve_cluster_params``), в кластеры входят
только точки, прошедшие КД (если методика задала пороги), устойчивость
кластера — доля поддиапазонов пакета, где найден кластер той же области.
"""
import hashlib
import time
from dataclasses import dataclass
from statistics import median
from typing import Any

from app.core.config import Settings
from app.services import journal
from app.services.dipole_clusters import (
    cluster_points,
    cluster_stability,
    resolve_cluster_params,
)
from app.services.dipole_scanner import (
    GRID_STEP_MM,
    DipoleScanError,
    DipoleScanParams,
    compute_dipole_scan,
    shared_scan_kernel,
)
from app.services.kd_criteria import kd_basis_for, resolve_gof_min
from app.services.recordings import Recording


class DipoleBatchError(ValueError):
    """Ошибка параметров/данных пакета — понятный текст для задачи."""


@dataclass(frozen=True)
class BandSpec:
    """Полоса пакета: ``band_key`` — стабильный адрес (п.6 dipoles.md).

    Границы — производные для именованных полос (``freq_bands``/
    ``functional_bands``); у «своих» полос ключ включает границы
    (``custom:2.5-4``) — адрес не меняется при пересчёте.
    """

    band_key: str
    lo_hz: float
    hi_hz: float
    label: str


@dataclass
class DipoleBatchParams:
    """Параметры прогона по набору поддиапазонов (С1).

    ``cluster_voxel_norm``/``cluster_min_points`` — ``None`` берут дефолт
    конфига (нормированные единицы С2); остальное — как у одиночного быстрого
    расчёта, но **одна** длина эпохи на все полосы (п.7).
    """

    bands: list[BandSpec]
    notch_hz: float | None = None
    epoch_length_ms: float = 1000.0
    reference: str = "average"
    reference_channels: list[str] | None = None
    grid_mm: float = GRID_STEP_MM
    cluster_voxel_norm: float | None = None
    cluster_min_points: int | None = None
    # КД (С0, по-полосный GOF 29.10.2026): пороги формы прогона перекрывают
    # порог методики (`kd_criteria.resolve_gof_min`); ``None`` — дефолт
    # конфига (X = 5 % эксперта + интерполяция GOF).
    kd_gof_min_by_band: dict[str, float] | None = None
    kd_moment_share: float | None = None


class _BandWindow:
    """Прогресс полосы: своё окно 0..1 внутри общего прогресса пакета."""

    def __init__(self, report: Any, lo: float, hi: float, label: str) -> None:
        self._report = report
        self._lo = lo
        self._hi = hi
        self._label = label

    def __call__(
        self,
        stage: str,
        progress: float | None = None,
        message: str = "",
        **kwargs: Any,
    ) -> None:
        share = self._lo + (self._hi - self._lo) * float(progress or 0.0)
        self._report(
            stage, share,
            message=f"[{self._label}] {message}" if message else f"[{self._label}]",
            **kwargs,
        )


def batch_signature(params: DipoleBatchParams) -> str:
    """Отпечаток прогона пакета (B7 ``fingerprint``): набор полос + параметры.

    Тот же состав, что у ``report_signature``/``analyses.params_sig``: один и
    тот же расчёт не путается с другим, повтор — честная новая строка истории
    (§8.4.2 ``docs/rules/results-db.md``).
    """
    parts = [
        f"{b.band_key}:{b.lo_hz:g}-{b.hi_hz:g}" for b in params.bands
    ] + [
        f"epoch={params.epoch_length_ms:g}",
        f"grid={params.grid_mm:g}",
        f"notch={params.notch_hz or 0:g}",
        f"ref={params.reference}:{','.join(params.reference_channels or ())}",
        f"cluster_voxel_norm={params.cluster_voxel_norm or 0:g}",
        f"cluster_min_points={params.cluster_min_points or 0:g}",
    ]
    # Пороги КД — часть «что считали»: вердикт меняется без изменения точек.
    # Только заданные значения (None не входит) — старые отпечатки стабильны.
    if params.kd_moment_share is not None:
        parts.append(f"kd_moment={params.kd_moment_share:g}")
    for key in sorted(params.kd_gof_min_by_band or {}):
        parts.append(f"kd_gof[{key}]={float((params.kd_gof_min_by_band or {})[key]):g}")
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:16]


def _comparison_row(
    band_key: str,
    label: str,
    band_hz: list[float],
    points: list[dict[str, Any]],
    moment_max: float | None,
    n_kd_passed: int | None,
    n_clusters: int,
    cluster_point_count: int,
) -> dict[str, Any]:
    """Строка сопоставления полос: **только нормированные величины** (С1).

    GOF между полосами не сравним (принцип 3 ``docs/rules/dipoles.md``) — его
    здесь нет и быть не может; ``moment_share`` — доля момента точки от
    максимума **своей** полосы, ``kd_share`` — доля прошедших КД.
    """
    shares = [
        float(p["amplitude_nam"]) / float(moment_max)
        for p in points
        if p.get("amplitude_nam") is not None and moment_max
    ]
    ordered = sorted(shares)
    p90 = (
        ordered[min(len(ordered) - 1, int(0.9 * (len(ordered) - 1)))]
        if ordered else None
    )
    peak_times = [
        float(p["time_ms"]) for p in points if p.get("time_ms") is not None
    ]
    rvs = [float(p["riv"]) for p in points if p.get("riv") is not None]
    return {
        "band_key": band_key,
        "label": label,
        "band_hz": band_hz,
        "n_points": len(points),
        "n_kd_passed": n_kd_passed,
        "kd_share": (
            n_kd_passed / len(points)
            if n_kd_passed is not None and points else None
        ),
        "moment_share_median": median(shares) if shares else None,
        "moment_share_p90": p90,
        "peak_time_median_ms": median(peak_times) if peak_times else None,
        # Единственный кросс-полосной фильтр доверия (2.6/N23): in-band
        # ковариация шума. `None` — данных мало, RIV не считался.
        "median_riv": median(rvs) if rvs else None,
        "n_clusters": n_clusters,
        "cluster_share": (cluster_point_count / len(points)) if points else None,
    }


def run_dipole_batch(
    recording: Recording,
    cfg: Settings,
    params: DipoleBatchParams,
    progress: Any = None,
    *,
    artifact_annotations: Any = None,
) -> dict[str, Any]:
    """Считает прогон по набору поддиапазонов: полосы, КД, кластеры, сопоставление.

    Возвращает dict под схему ``DipoleBatchResult`` (её валидирует API).
    Каждая полоса — тот же быстрый расчёт (``compute_dipole_scan``, одна
    точка на эпоху в пике GFP **своей** полосы), но пакет строит ядро перебора
    один раз и собирает результаты в набор (B7) вместо затирания одного
    результата другим.
    """
    report = progress or (lambda *args, **kwargs: None)
    started = time.perf_counter()
    if not params.bands:
        raise DipoleBatchError("Пакету нужна хотя бы одна полоса")
    seen: set[str] = set()
    for band in params.bands:
        if band.band_key in seen:
            raise DipoleBatchError(f"Полоса {band.band_key} в пакете повторяется")
        seen.add(band.band_key)
        if band.lo_hz >= band.hi_hz:
            raise DipoleBatchError(
                f"Полоса {band.band_key}: нижняя граница не меньше верхней"
            )

    cluster_voxel_norm = (
        cfg.cluster_voxel_norm
        if params.cluster_voxel_norm is None else float(params.cluster_voxel_norm)
    )
    cluster_min_points = (
        cfg.cluster_min_points
        if params.cluster_min_points is None else int(params.cluster_min_points)
    )
    cluster_params = resolve_cluster_params(cluster_voxel_norm, cluster_min_points)

    report("load_edf", 0.0, message="Пакет поддиапазонов: монтаж и ядро перебора")
    channels = list(recording.meta.get("channels") or [])
    kernel: Any = None
    kernel_error: str | None = None
    kernel_started = time.perf_counter()
    try:
        if len(channels) >= 4:
            kernel = shared_scan_kernel(channels, params.grid_mm)
    except DipoleScanError as exc:
        kernel_error = str(exc)
    if kernel is not None:
        # Ядро (forward G + inverse GᵀG) построено один раз на прогон — полосы
        # его переиспользуют (С1, §7.1 audit_qwen).
        journal.record(
            "dipoles", "batch_kernel",
            ms=(time.perf_counter() - kernel_started) * 1000.0,
            note=f"ядро перебора один раз на пакет из {len(params.bands)} полос (С1)",
            epochs=0,
        )

    # КД решает, что попадает в кластеры (concept.md §3): вердикт — по-полосный
    # (порог GOF своей полосы + общая доля момента), поэтому «оцененность» тоже
    # своя у каждой полосы; без порогов методики в кластеры идут все точки,
    # и это подписано в паспорте (`kd_filter`).
    any_kd_evaluated = False

    band_runs: list[dict[str, Any]] = []
    warnings: list[str] = []
    n_bands = max(1, len(params.bands))
    for index, band in enumerate(params.bands):
        lo = 0.02 + 0.94 * index / n_bands
        hi = 0.02 + 0.94 * (index + 1) / n_bands
        scan = DipoleScanParams(
            filter_band=(band.lo_hz, band.hi_hz),
            notch_hz=params.notch_hz,
            epoch_length_ms=params.epoch_length_ms,
            reference=params.reference,
            reference_channels=params.reference_channels,
            grid_mm=params.grid_mm,
        )
        try:
            with journal.step(
                "dipoles", "band_scan",
                note=f"{band.band_key} ({band.lo_hz:g}–{band.hi_hz:g} Гц)",
            ):
                scan_result = compute_dipole_scan(
                    recording, cfg, scan,
                    progress=_BandWindow(report, lo, hi, band.label),
                    artifact_annotations=artifact_annotations,
                    kernel=kernel,
                )
        except DipoleScanError as exc:
            band_runs.append({
                "band_key": band.band_key,
                "label": band.label,
                "band_hz": [band.lo_hz, band.hi_hz],
                "state": "error",
                "n_points": 0,
                "n_kd_passed": None,
                "n_errors": 1,
                "moment_max_nam": None,
                "median_gof": None,
                "kd_basis": {
                    "moment_share_x": (
                        params.kd_moment_share
                        if params.kd_moment_share is not None
                        else cfg.kd_moment_share
                    ),
                    "gof_min": resolve_gof_min(
                        cfg, band_key=band.band_key,
                        band_hz=(band.lo_hz, band.hi_hz),
                        gof_min_by_band=params.kd_gof_min_by_band,
                    ),
                    "moment_max_nam": None,
                },
                "n_epochs_total": None,
                "n_epochs_used": None,
                "bad_epoch_indexes": [],
                "points": [],
                "warnings": [str(exc)],
            })
            warnings.append(f"Полоса {band.label}: {exc}")
            continue

        points = list(scan_result.get("points") or [])
        kd_basis, verdicts, n_kd_passed = kd_basis_for(
            points, cfg,
            band_key=band.band_key,
            band_hz=(band.lo_hz, band.hi_hz),
            gof_min_by_band=params.kd_gof_min_by_band,
            moment_share=params.kd_moment_share,
        )
        any_kd_evaluated = any_kd_evaluated or any(v is not None for v in verdicts)
        enriched = [
            # Вердикт — bool|None по контракту (DipoleBatchPointOut): 1/0 здесь
            # превратились бы в «1» в JSON, а NULL обязан остаться NULL.
            {**point, "kd_passed": None if verdict is None else bool(verdict)}
            for point, verdict in zip(points, verdicts, strict=True)
        ]
        gofs = sorted(float(p["gof"]) for p in points if p.get("gof") is not None)
        band_warnings = list(scan_result.get("warnings") or [])
        band_runs.append({
            "band_key": band.band_key,
            "label": band.label,
            "band_hz": [band.lo_hz, band.hi_hz],
            "state": "ok" if points else "empty",
            "n_points": len(points),
            "n_kd_passed": n_kd_passed,
            "n_errors": len(band_warnings),
            "moment_max_nam": kd_basis.get("moment_max_nam"),
            # GOF — только внутри своей полосы (принцип 3): медиана не покидает
            # строку полосы и не сравнивается с соседними.
            "median_gof": median(gofs) if gofs else None,
            "kd_basis": kd_basis,
            "n_epochs_total": scan_result.get("n_epochs_total"),
            "n_epochs_used": scan_result.get("n_epochs_used"),
            # Сетка отброшенных эпох своя у каждой полосы: краевой буфер BAD_edge
            # зависит от ядра фильтра полосы (одна длина эпохи на прогон, п.7).
            "bad_epoch_indexes": scan_result.get("bad_epoch_indexes") or [],
            "points": enriched,
            "warnings": band_warnings,
        })
        warnings.extend(band_warnings)

    # Кластеры (С2): точки, прошедшие КД своей полосы (или все — без порогов
    # методики; «оцененность» — по вердиктам полосы, а не по глобальному флагу).
    clusters_by_band: dict[str, list[dict[str, Any]]] = {}
    for run in band_runs:
        run_evaluated = any(
            point.get("kd_passed") is not None for point in run["points"]
        )
        cluster_input = [
            {
                "recording_id": recording.recording_id,
                "mni": point.get("mni_coords"),
                "structure": point.get("anatomical_structure"),
                "area": point.get("brodmann_area"),
                # Измеренное для профиля признаков кластера (cluster_features)
                "amplitude_nam": point.get("amplitude_nam"),
                "gof": point.get("gof"),
                "kd_passed": point.get("kd_passed"),
            }
            for point in run["points"]
            if not run_evaluated or point.get("kd_passed") == 1
        ]
        clusters_by_band[run["band_key"]] = cluster_points(
            cluster_input,
            float(cluster_params["voxel_mm"]),
            int(cluster_params["min_points"]),
        )
    stability = cluster_stability(
        clusters_by_band, float(cluster_params["voxel_mm"]),
    )

    clusters: list[dict[str, Any]] = []
    for run in band_runs:
        band_key = run["band_key"]
        band_points = max(1, run["n_points"])
        for index, cluster in enumerate(clusters_by_band.get(band_key) or []):
            stability_row = stability.get(f"{band_key}:{index}") or {}
            clusters.append({
                "band_key": band_key,
                "cluster_index": index,
                "centroid_mni": cluster.get("centroid_mni"),
                "n_points": cluster.get("n_points"),
                "share": float(cluster.get("n_points") or 0) / band_points,
                "volume_cm3": cluster.get("volume_cm3"),
                "density_per_cm3": cluster.get("density_per_cm3"),
                "extent_mm": cluster.get("extent_mm"),
                "top_structures": cluster.get("top_structures"),
                "top_brodmann": cluster.get("top_brodmann"),
                "features": cluster.get("features"),
                "n_bands_matched": stability_row.get("n_bands_matched", 1),
                "band_share": stability_row.get("band_share", 1.0 / n_bands),
                "matched_band_keys": stability_row.get("matched_band_keys", [band_key]),
            })

    comparison = [
        _comparison_row(
            run["band_key"], run["label"], run["band_hz"],
            run["points"], run["moment_max_nam"], run["n_kd_passed"],
            len(clusters_by_band.get(run["band_key"]) or []),
            sum(
                int(c.get("n_points") or 0)
                for c in (clusters_by_band.get(run["band_key"]) or [])
            ),
        )
        for run in band_runs
    ]

    if kernel_error:
        warnings.append(f"Ядро перебора из общего монтажа не построено: {kernel_error}")

    report("done", 1.0, message=f"Пакет посчитан: {len(band_runs)} полос")
    return {
        "recording_id": recording.recording_id,
        "method": "fast_grid",
        "params_sig": batch_signature(params),
        "reference": params.reference,
        "reference_channels": (
            list(params.reference_channels) if params.reference_channels else None
        ),
        "channels": channels,
        "sfreq": recording.meta.get("sfreq"),
        "epoch_length_ms": float(params.epoch_length_ms),
        "notch_hz": params.notch_hz,
        "grid_mm": float(params.grid_mm),
        "bands": band_runs,
        "comparison": comparison,
        "clusters": clusters,
        "cluster_params": {
            **cluster_params,
            # Что ушло в кластеры: вердикт КД или «все точки» (без порогов).
            "kd_filter": "kd_passed" if any_kd_evaluated else None,
        },
        "warnings": list(dict.fromkeys(warnings)),
        "duration_sec_calc": round(time.perf_counter() - started, 3),
    }
