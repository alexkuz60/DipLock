"""fit_dipole + локализация (анатомия + Brodmann).

Точный фитинг (``mne.fit_dipole``) — «медленный профиль»: он считается эпоха
за эпохой. Здесь же сводка ошибок фитинга (``fit_summary``): задача не должна
выглядеть успешной, если диполей не получилось (F18, ``audit.md`` §7.7).
"""
import logging
import os
from functools import lru_cache
from typing import Any, Optional

import mne
import numpy as np

from app.core.config import Settings

logger = logging.getLogger(__name__)


def inband_whitener(samples: np.ndarray) -> np.ndarray:
    """Матрица отбеливания ``W = C^{-1/2}`` по in-band ковариации шума (2.6/N23).

    ``samples`` — матрица «каналы × отсчёты», уже отфильтрованная в полосу
    расчёта: эмпирическая ковариация по ним и есть шум этой полосы (шум плюс
    фоновая активность той же полосы). Отбеливание ею делает невязку
    **сравнимой между полосами**: GOF нормируется на мощность сигнала полосы и
    поэтому в узкой полосе завышен (принцип пакетного сценария,
    ``docs/rules/dipoles.md``), а RIV — на шум.

    Average reference делает ковариацию вырожденной (нулевое направление общего
    сдвига каналов), поэтому собственные значения зажимаются снизу долей
    максимального: без зажима деление на ~0 унесло бы всю нормировку.
    """
    x = np.asarray(samples, dtype=float)
    if x.ndim != 2 or x.shape[1] < 2:
        raise ValueError("samples: матрица (каналы × отсчёты), нужно ≥ 2 отсчётов")
    x = x - x.mean(axis=1, keepdims=True)
    cov = (x @ x.T) / (x.shape[1] - 1)
    eigvals, eigvecs = np.linalg.eigh(cov)
    peak = float(eigvals.max())
    eigvals = np.maximum(eigvals, (peak * 1e-6) if peak > 0.0 else 1.0)
    return (eigvecs * (1.0 / np.sqrt(eigvals))) @ eigvecs.T


def whitened_riv(
    residual: np.ndarray, signal: np.ndarray, whitener: np.ndarray
) -> float | None:
    """Доля отбелённой невязки: ``‖W·r‖² / ‖W·d‖²`` (2.6/N23).

    Меньше — лучше. Значение может превысить 1: невязка отбелённого остатка не
    ограничена мощностью отбелённого сигнала (веса каналов после отбеливания
    разные). ``None`` — нормировать нечего (нулевая мощность сигнала): в таблице
    это «—», а не выдуманный ноль.
    """
    wr = whitener @ np.asarray(residual, dtype=float)
    wd = whitener @ np.asarray(signal, dtype=float)
    denom = float(wd @ wd)
    if denom <= 0.0:
        return None
    return float((wr @ wr) / denom)


def epochs_whitener(data: np.ndarray) -> np.ndarray | None:
    """Отбеливатель по in-band ковариации эпох (2.6/N23) или ``None``.

    ``data`` — (эпохи, каналы, отсчёты) уже в полосе расчёта: каналы × все
    отсчёты сворачиваются в матрицу наблюдений для эмпирической ковариации той
    же полосы. Слишком короткие данные ковариацию не оценивают — честнее
    вернуть ``None`` (RIV не посчитан), чем шум из одного отсчёта.
    """
    x = np.asarray(data, dtype=float)
    if x.ndim != 3 or x.shape[1] < 2 or x.size < 2 * x.shape[1]:
        return None
    try:
        return inband_whitener(x.transpose(1, 0, 2).reshape(x.shape[1], -1))
    except ValueError:
        return None


def point_riv(
    residual: Any, data_arr: np.ndarray, idx: int, whitener: np.ndarray | None
) -> float | None:
    """RIV одной временной точки из невязки `mne.fit_dipole` (2.6/N23).

    ``residual`` — второй элемент кортежа `fit_dipole` (Evoked невязки в единицах
    данных); ``None`` или несовпадение длин — ``None`` («не посчитано»).
    """
    if whitener is None:
        return None
    res = getattr(residual, "data", None)
    if res is None or idx >= res.shape[1] or idx >= data_arr.shape[1]:
        return None
    return whitened_riv(res[:, idx], data_arr[:, idx], whitener)


def conf_ci_mm(conf: Any, idx: int) -> float | None:
    """Радиус доверительной области из ``dip.conf`` MNE, мм (2.6/N23).

    Берётся максимум по трём пространственным осям диполя (``depth``/``long``/
    ``trans``, метры): глубинная граница на сфере нулевая, на BEM может быть
    ненулевой. Пустой словарь (старый MNE или фиксированная позиция) — ``None``,
    а не выдуманный ноль.
    """
    if not isinstance(conf, dict):
        return None
    limits = [
        float(conf[key][idx])
        for key in ("depth", "long", "trans")
        if key in conf and idx < len(conf[key])
    ]
    if not limits:
        return None
    return max(limits) * 1000.0


def fit_dipoles_for_epochs(
    epochs: mne.Epochs,
    settings: Settings,
    freq_bands: dict,
    progress: Any = None,
) -> list[dict[str, Any]]:
    """Фитинг по эпохам; ``progress`` — колбэк задачи (этап ``dipoles``).

    Дробный прогресс по эпохам обязателен: на дефолтах (все эпохи, ``decim=5``)
    расчёт идёт часами, и без счётчика задача выглядит зависшей (F19).
    """
    report = progress or (lambda *args, **kwargs: None)
    bem = _get_bem(settings)
    trans = settings.fsaverage_trans

    # Ковариация: из файла, иначе считаем empirical прямо из эпох
    # (method='shrunk' требует scikit-learn).
    cov = _get_covariance(settings)
    if cov is None:
        cov = mne.compute_covariance(epochs, method="empirical", verbose=False)

    # Итерация по mne.Epochs даёт numpy-массивы (не .average()), а mne.fit_dipole
    # требует Evoked — поэтому собираем Evoked для каждой эпохи вручную.
    max_epochs = int(getattr(settings, "dipole_fit_max_epochs", 0) or 0)
    n_fit = len(epochs) if max_epochs <= 0 else min(len(epochs), max_epochs)
    data = epochs.get_data()[:n_fit]  # (n_fit, n_channels, n_times)
    tmin = float(epochs.times[0])
    decim = max(1, int(getattr(settings, "dipole_fit_decim", 1) or 1))
    n_jobs = max(1, int(getattr(settings, "dipole_fit_n_jobs", 1) or 1))

    all_dips: list[dict[str, Any]] = []
    # Отбеливатель по in-band ковариации шума — один на набор эпох (2.6/N23):
    # полоса у всех эпох одна, поэтому и ковариация шума общая.
    whitener = epochs_whitener(data)
    for i in range(n_fit):
        evoked = mne.EvokedArray(
            data[i], epochs.info.copy(), tmin=tmin, nave=1, verbose=False,
        )
        # Прореживание по времени: fit_dipole на каждую точку очень дорог
        if decim > 1:
            evoked.decimate(decim, verbose=False)
        try:
            # MNE 1.13 отдаёт кортеж (dipoles, residual): без распаковки
            # `dip.pos` падал, и диполей не было вовсе (F17). Второй элемент
            # (невязка) раньше отбрасывался — из него считается RIV (N23).
            out = mne.fit_dipole(
                evoked, cov, bem, trans=trans,
                min_dist=5.0, n_jobs=n_jobs, verbose=False,
            )
            dip = out[0] if isinstance(out, tuple) else out
            residual = out[1] if isinstance(out, tuple) else None
            conf = getattr(dip, "conf", None) or {}
            khi2 = getattr(dip, "khi2", None)
            nfree = getattr(dip, "nfree", None)
            traj = []
            for idx in range(len(dip.pos)):
                traj.append({
                    "time_ms": float(dip.times[idx] * 1000),
                    "pos_head": dip.pos[idx].tolist(),
                    "ori_head": dip.ori[idx].tolist(),
                    "amplitude_nam": float(dip.amplitude[idx] * 1e9),
                    # MNE отдаёт Dipole.gof в процентах (dipole.py: * 100);
                    # контракт проекта — доля 0..1
                    "gof": float(dip.gof[idx]) / 100.0,
                    # RIV/CI (2.6/N23): кросс-полосной фильтр доверия. GOF между
                    # полосами не сравним (узкая полоса завышает R²) — сравним RIV.
                    "riv": point_riv(residual, evoked.data, idx, whitener),
                    "ci_mm": conf_ci_mm(conf, idx),
                    "khi2": float(khi2[idx]) if khi2 is not None else None,
                    "nfree": int(nfree[idx]) if nfree is not None else None,
                })
            best = max(traj, key=lambda x: x["gof"]) if traj else {}
            all_dips.append({
                "epoch_index": i,
                "n_time_points": len(traj),
                "trajectory": traj,
                "best_fit": best,
            })
        except Exception as e:
            all_dips.append({"epoch_index": i, "error": str(e), "trajectory": [], "best_fit": {}})
        report(
            "dipoles", (i + 1) / max(1, n_fit),
            message=f"Фитинг диполей: эпоха {i + 1} из {n_fit}",
            epochs_done=i + 1, epochs_total=n_fit,
        )

    return all_dips


def fit_summary(dipoles: list[dict[str, Any]]) -> dict[str, Any]:
    """Сводка фитинга: сколько эпох дало диполь и сколько завершилось ошибкой.

    Ошибки глушить нельзя (F18): задача со 100 % ошибок получает
    ``succeeded`` и «прогресс 1.0», поэтому предупреждение и счётчики — часть
    контракта результата (`AnalyzeResponse`), а не строка в логе.
    """
    errors = [str(d["error"]) for d in dipoles if d.get("error")]
    fitted = [d for d in dipoles if d.get("best_fit")]
    warnings: list[str] = []
    total = len(dipoles)
    if errors and len(errors) == total:
        warnings.append(
            f"Точный фитинг не дал диполей: все {total} эпох — ошибка. "
            f"Первая: {errors[0]}"
        )
    elif errors:
        warnings.append(
            f"Часть эпох не посчитана: {len(errors)} из {total}. Первая: {errors[0]}"
        )
    return {
        "n_dipole_fit": len(fitted),
        "n_dipole_errors": len(errors),
        # Тексты усечены: контракт не должен раздуваться списком на сотни эпох
        "dipole_error_samples": errors[:5],
        "warnings": warnings,
    }


def localize_dipoles(dipoles_result: list, settings: Settings) -> list:
    subjects_dir = settings.subjects_dir
    trans_path = settings.fsaverage_trans
    # Кэшированный один раз (module-level lru_cache)
    transform = _get_transform(subjects_dir, trans_path)

    for result in dipoles_result:
        if "error" in result or not result.get("trajectory"):
            continue

        traj = result["trajectory"]
        localized = []
        for dp in traj:
            pos = np.array(dp["pos_head"]).reshape(1, 3)

            # MNI — корректная сигнатура в MNE 1.13: (pos, subject, mri_head_t, ...)
            mni = None
            try:
                mni = mne.head_to_mni(
                    pos, subject="fsaverage",
                    mri_head_t=transform,
                    subjects_dir=subjects_dir,
                )
                dp["mni_coords"] = mni[0].tolist()
            except Exception:
                dp["mni_coords"] = [0, 0, 0]

            # Анатомия одной функцией (шаг 1.4/N21): ближайшая структура и поле
            # Бродмана с расстояниями и признаком «вне мозга» — общий источник с
            # контурами среза (`atlas_contours`). Объёмы кэшируются, поэтому цена
            # точки — поиск в KD-дереве вместо чтения тома на точку (F19).
            dp.update(attribution_fields(settings, mni[0] if mni is not None else None))
            localized.append(dp)

        result["trajectory"] = localized
        if localized:
            result["best_fit"] = max(localized, key=lambda x: x["gof"])

    return dipoles_result


@lru_cache(maxsize=1)
def _get_transform(subjects_dir: str, trans_path: str) -> "mne.Transform":
    """Закэшированный Transform (mri_head_t). Принимает путь к .fif, возвращает mne.Transform."""
    return mne.read_trans(trans_path, verbose=False)


def attribution_fields(settings: Settings, mni_mm: Any) -> dict[str, Any]:
    """Поля атрибуции точки из общего источника (``atlas_contours``, шаг 1.4/N21).

    Ближайшая структура/поле Бродмана с расстояниями и признаком «вне мозга».
    Ленивый импорт: ``atlas_contours`` тянет nibabel/scipy, а фитинг без
    локализации (например, в тестах) не должен зависеть от атласов. Сбой
    атрибуции не отменяет расчёт: поля остаются пустыми («—» в таблице),
    а не выдуманными.
    """
    try:
        from app.services.atlas_contours import attribution_payload

        return attribution_payload(settings, mni_mm)
    except Exception as exc:
        logger.info("Атрибуция по MNI не определена: %s", exc)
        return {
            "anatomical_structure": None,
            "structure_distance_mm": None,
            "brodmann_area": None,
            "brodmann_distance_mm": None,
            "outside_brain": None,
        }


def _get_covariance(settings) -> Optional["mne.Covariance"]:
    try:
        return mne.read_cov(f"{settings.subjects_dir}/fsaverage-cov.fif")
    except (FileNotFoundError, OSError):
        return None


def bem_path(settings) -> str:
    """Путь к BEM-решению fsaverage; ищем существующий файл."""
    candidates = [
        f"{settings.subjects_dir}/fsaverage/bem/fsaverage-5120-5120-5120-bem-sol.fif",
        f"{settings.subjects_dir}/fsaverage/bem/fsaverage-5120-5120-5120-bem.fif",
        f"{settings.subjects_dir}/bem/fsaverage-5120-5120-5120-bem-sol.fif",
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    raise FileNotFoundError(
        "BEM-решение fsaverage не найдено. Ожидался один из файлов: "
        + ", ".join(candidates)
    )


@lru_cache(maxsize=1)
def _read_bem(bem_file: str) -> "mne.bem.ConductorModel":
    """BEM-решение читается один раз на путь (F19: было чтение на каждую эпоху)."""
    return mne.read_bem_solution(bem_file, verbose=False)


def _get_bem(settings) -> "mne.bem.ConductorModel":
    """BEM-решение fsaverage из кэша процесса — аргумент ``mne.fit_dipole``."""
    return _read_bem(bem_path(settings))
