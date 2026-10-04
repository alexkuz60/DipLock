"""eLORETA: пик и ROI-доли на одной эпохе (остаток B9, `docs/rules/dipoles.md` п.5).

Границы честности (п.5): **не полные карты** — объём stc × N полос упирается в
``JOB_RESULT_MAX_BYTES`` и в отсутствующую концепцию визуализации; на выходе
только пик распределения (координата + анатомия) и доли энергии по структурам
``aparc+aseg`` (ROI). Точечный «refine» по кнопке остаётся отдельным инструментом.

Цепочка — штатная MNE, без новых зависимостей:

* нарезка и окно вокруг пика GFP — **те же**, что в быстром расчёте и refine
  (``_prepare_epochs``, общий кэш подготовленного сигнала A4): «эпоха N» —
  один и тот же кусок записи во всех инструментах раздела;
* модель — BEM fsaverage + transform + source space (пути из ``settings``,
  чтение src/BEM кэшируется на путь, как F19);
* ``apply_inverse(method='eLORETA')``: ``depth`` MNE для eLORETA игнорирует
  (документация MNE ≥0.20), регуляризация — ``eloreta_lambda2`` из конфига;
* координаты вершин src — кадр fsaverage-MRI; проект скармливает этот же кадр
  атласу через ``head_to_mni`` (transform fsaverage), поэтому атрибуция и
  ROI-доли используют те же функции ``atlas_contours``, что и диполи.
"""
import logging
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import mne
import numpy as np

from app.core.config import Settings
from app.services import journal
from app.services.dipole_fitter import _get_bem, _get_covariance
from app.services.dipole_scanner import (
    DipoleScanParams,
    _electrode_matrix,
    _prepare_epochs,
    channel_positions,
    montage_sparse_warning,
)
from app.services.fsaverage_assets import src_path

logger = logging.getLogger(__name__)

# Сколько ROI-структур нести в контракт (плюс «прочие» с остаточной долей):
# топ-8 читаемы в таблице, остальное — шум (п.5: ROI, а не карта).
_ROI_TOP = 8


class EloretaError(ValueError):
    """Ошибка параметров/данных eLORETA — превращается в понятный текст задачи."""


@dataclass
class EloretaParams:
    """Параметры eLORETA: нарезка быстрого расчёта + эпоха + окно пика GFP.

    Тот же принцип, что у ``DipoleRefineParams``: номер эпохи привязан к
    нарезке результата, поэтому приходит целиком ``scan`` — иначе «эпоха 12»
    стала бы другим куском записи. ``halfwin_ms`` — половина окна вокруг пика
    GFP (0 — отсчёт пика); окно усредняет eLORETA-решение, как refine усредняет
    фит.
    """

    scan: DipoleScanParams
    epoch_index: int
    halfwin_ms: float = 0.0


@lru_cache(maxsize=2)
def _read_src(path: str) -> list:
    """Source space читается один раз на путь (F19-приём: не на каждую задачу)."""
    return mne.read_source_spaces(path, verbose=False)


def run_eloreta(
    recording: Any,
    cfg: Settings,
    params: EloretaParams,
    progress: Any = None,
) -> dict[str, Any]:
    """Считает eLORETA-решение одной эпохи → пик + ROI (контракт ``EloretaResult``).

    Возвращает dict (валидирует ``EloretaResult`` в API); тяжёлые вычисления
    вызывающий код запускает в воркере (`job_manager`), прогресс — колбэком.
    ``EloretaError`` — текст для UI; сбой атласа не валит расчёт (анатомия
    становится пустой с предупреждением — как в ``attribution_fields``).
    """
    scan = params.scan
    report = progress or (lambda *args, **kwargs: None)
    started = time.perf_counter()

    report("eloreta", 0.1, message="Чтение EDF, монтаж 10-20")
    raw, epochs = _prepare_epochs(recording, cfg, scan)
    n_epochs = len(epochs)
    if n_epochs == 0:
        raise EloretaError("После reject-фильтра не осталось эпох — нечего локализовать")
    if not 0 <= params.epoch_index < n_epochs:
        raise EloretaError(
            f"Эпохи №{params.epoch_index + 1} нет: в нарезке быстрого расчёта их {n_epochs}. "
            "eLORETA привязан к той нарезке — если параметры менялись, пересчитайте диполи"
        )

    # Порядок выборки — как в compute_dipole_scan/refine: матрица электродов,
    # потом данные по ним (иначе индексы эпохи/канала разъезжаются).
    positions = channel_positions(raw.ch_names)
    # positions_m (метры) для forward не нужен: make_forward_solution берёт
    # позиции из info (montage уже применён при чтении).
    used_channels, _positions_m, used_index = _electrode_matrix(raw.ch_names, positions)
    data = epochs.get_data()[:, used_index, :]
    times = epochs.times
    gfp = np.sqrt(np.mean(data ** 2, axis=1))
    sample = int(np.argmax(gfp[params.epoch_index]))

    warnings: list[str] = []
    sparse = montage_sparse_warning(len(used_channels), cfg)
    if sparse:
        warnings.append(sparse)

    # Окно вокруг пика GFP — та же геометрия, что в refine (0 — один отсчёт).
    sfreq = float(raw.info["sfreq"])
    half = max(0, round(params.halfwin_ms / 1000.0 * sfreq))
    lo = max(0, sample - half)
    hi = min(data.shape[2], sample + half + 1)
    sel = [raw.ch_names.index(name) for name in used_channels]
    info = mne.pick_info(raw.info, sel)
    evoked = mne.EvokedArray(
        data[params.epoch_index][:, lo:hi], info,
        tmin=float(times[lo]), nave=1, verbose=False,
    )

    report("eloreta", 0.3, message="Модель источника (BEM fsaverage, forward)")
    try:
        bem = _get_bem(cfg)
        src = _read_src(src_path(cfg))
    except (FileNotFoundError, OSError) as exc:
        raise EloretaError(f"eLORETA недоступна: {exc}") from exc
    cov = _get_covariance(cfg)
    if cov is None:
        cov = mne.compute_covariance(epochs, method="empirical", verbose=False)

    with journal.step(
        "localize", "eloreta_forward", epochs=1,
        note=f"epoch={params.epoch_index + 1}, окно ±{params.halfwin_ms:g} мс",
    ):
        forward = mne.make_forward_solution(
            info, trans=cfg.fsaverage_trans, src=src, bem=bem,
            eeg=True, meg=False, n_jobs=1, verbose=False,
        )

    report("eloreta", 0.6, message="Обратная задача (eLORETA)")
    with journal.step(
        "localize", "eloreta_inverse", epochs=1,
        note=f"lambda2={cfg.eloreta_lambda2:g}",
    ):
        inverse = mne.minimum_norm.make_inverse_operator(
            info, forward, cov, verbose=False,
        )
        stc = mne.minimum_norm.apply_inverse(
            evoked, inverse, lambda2=cfg.eloreta_lambda2,
            method="eLORETA", verbose=False,
        )

    report("eloreta", 0.9, message="Пик и ROI (апарц+асег)")
    peak, roi_rows, other_share, atlas_missing = _peak_and_roi(cfg, stc, src)
    if atlas_missing:
        warnings.append(
            "Анатомия недоступна (атлас aparc+aseg не собран): пик показан координатами, "
            "ROI-доли не посчитаны"
        )
    warnings.append(
        "eLORETA-решение на одной эпохе: пик и ROI — ориентир для перекрёстной "
        "проверки с быстрым расчётом и refine, а не замена точечного фита"
    )

    result = {
        "recording_id": getattr(recording, "recording_id", ""),
        "method": "eloreta",
        "epoch_index": params.epoch_index,
        "time_ms": float(times[sample] * 1000.0),
        "window_ms": [float(times[lo] * 1000.0), float(times[hi - 1] * 1000.0)],
        "halfwin_ms": params.halfwin_ms,
        "peak": peak,
        "roi": roi_rows,
        "other_share": other_share,
        "n_sources": int(stc.data.shape[0]),
        "n_channels": len(used_channels),
        "lambda2": float(cfg.eloreta_lambda2),
        "warnings": warnings,
        "duration_sec_calc": round(time.perf_counter() - started, 3),
    }
    journal.record(
        "localize", "eloreta",
        ms=(time.perf_counter() - started) * 1000.0,
        note=f"epoch={params.epoch_index + 1}, sources={stc.data.shape[0]}",
        epochs=1,
    )
    report("eloreta", 1.0, message="Пик и ROI посчитаны")
    return result


def _peak_and_roi(
    cfg: Settings, stc: Any, src: Any,
) -> tuple[dict[str, Any], list[dict[str, Any]], float, bool]:
    """Пик |amplitude| stc и ROI-доли по структурам ``aparc+aseg``.

    Возвращает ``(peak, roi_rows, other_share, atlas_missing)``:

    * пик — максимум ``|stc.data|`` по вершинам и времени; координата — кадр
      fsaverage-MRI в мм (тот же, что ``head_to_mni`` скармливает атласу),
      анатомия — общая ``attribution_payload`` (нельзя расходиться с таблицей
      диполей);
    * ROI — доля суммарной энергии (``sum(data²)`` по времени) на вершину,
      сгруппированная по ближайшей структуре; топ-``_ROI_TOP`` + остаток
      «прочие». Вершины вне атласа не выдумываются — их энергия уходит в
      «прочие»;
    * ``atlas_missing=True`` — объёмы не собрались: ROI честно пустые
      (warning добавит вызывающий код), пик остаётся координатами.
    """
    data = np.asarray(stc.data, dtype=np.float64)
    energy = np.sum(data * data, axis=1)  # (n_src,) — энергия вершины за окно
    total = float(energy.sum())
    flat = int(np.argmax(np.abs(data)))
    ver_idx, time_idx = np.unravel_index(flat, data.shape)

    # Порядок строк stc — lh затем rh; spaces по id (101/102 — константы FIFF).
    n_lh = len(stc.vertices["lh"])
    spaces = {
        "lh": next(s for s in src if s["id"] == 101),
        "rh": next(s for s in src if s["id"] == 102),
    }

    def _coord_mm(index: int) -> list[float]:
        hemi = "lh" if index < n_lh else "rh"
        local = index if hemi == "lh" else index - n_lh
        vertex = int(stc.vertices[hemi][local])
        return (np.asarray(spaces[hemi]["rr"][vertex], dtype=np.float64) * 1000.0).tolist()

    coord_mm = _coord_mm(int(ver_idx))

    from app.services.atlas_contours import attribution_payload

    peak: dict[str, Any] = {
        "mni_mm": coord_mm,
        "value": float(abs(data[ver_idx, time_idx])),
        "time_ms": float(stc.times[time_idx] * 1000.0),
        **attribution_payload(cfg, coord_mm),
    }

    # ROI: ближайшая структура на каждую вершину → доля энергии.
    try:
        from app.services.atlas_contours import (
            _ContourCtx,
            load_volumes,
            nearest_structure,
        )

        volumes = load_volumes(_ContourCtx.from_settings(cfg))
    except Exception:
        logger.info("ROI для eLORETA: объёмы атласа недоступны", exc_info=True)
        return peak, [], 1.0, True

    by_structure: dict[str, float] = {}
    unlabeled = 0.0
    for idx in range(energy.size):
        name, _distance = nearest_structure(volumes, _coord_mm(idx))
        if name is None:
            unlabeled += float(energy[idx])
            continue
        by_structure[name] = by_structure.get(name, 0.0) + float(energy[idx])

    if total <= 0:
        return peak, [], 0.0, False
    ordered = sorted(by_structure.items(), key=lambda item: item[1], reverse=True)
    top: list[dict[str, Any]] = [
        {"structure": name, "share": value / total}
        for name, value in ordered[:_ROI_TOP]
    ]
    shown = sum(float(row["share"]) for row in top)
    other = max(0.0, 1.0 - shown - unlabeled / total)
    return peak, top, round(other, 6), False


