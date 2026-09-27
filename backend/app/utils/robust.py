"""Робастные статистики сигнала (медиана/MAD) — общий хелпер детекторов.

Вынесены из `artifact_detector`, чтобы новый детектор мог переиспользовать
оценку, не копируя медиану/MAD и не заводя цикл в графе зависимостей.
"""
import numpy as np
from numpy.typing import NDArray


def robust_stats(x: NDArray) -> tuple[float, float]:
    """Медиана и устойчивый масштаб (1.4826·MAD, фолбэк — std) по M11.

    Обычное среднее/std съедаются самими артефактами (выброс тянет std вверх и
    прячется за собственным порогом) — детектор считает «норму» по медиане.
    """
    x = np.asarray(x, dtype=float)
    x = x[np.isfinite(x)]
    if x.size == 0:
        return 0.0, 0.0
    med = float(np.median(x))
    scale = float(np.median(np.abs(x - med))) * 1.4826
    if scale <= 0.0:
        scale = float(np.std(x))
    return med, scale
