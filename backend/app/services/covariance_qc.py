"""Ковариация как QC-слой: числа (λ, % дисперсии) и картинки «до/после» (п.6).

Что смотрит исследователь (обсуждение 01.10.2026):

* **heatmap корреляций каналов** (нормированная ковариация, −1…1): связность
  монтажа читается цветом, «до» и «после» на одной шкале;
* **топокарты ведущих собственных векторов** (PCA ковариации): PC1 с
  фронтальным максимумом и инверсией фазы — «моргание в эпохе»;
* **шумовой хвост** λ≈0 — некоррелированный аппаратный шум: эффективный ранг
  (компоненты с λ ≥ ``covariance_qc_tail_ratio``·λ1) показывает, сколько
  компонент реально несёт сигнал — видимая проверка, что фит ICA не посчитан
  на шумовом хвосте.

Числа и картинки уходят в отчёт стадии ``filter`` (поле ``covariance``) — туда
же, где метрики L1/L3/L4/L5. Картинки — base64-строки **внутри** отчёта (тот
же приём, что у отчётов `group_reports`): диагностика привязана к конкретной
конфигурации и обязана показывать ровно те числа, что стоят рядом, —
отдельный ассет-эндпоинт с ключом только добавил бы путь к рассинхрону
(«числа одни, картинка другая»).

Реализация — numpy ``eigh`` для симметричной ковариации (без новых
зависимостей и без дрейфа MNE API); рендер — matplotlib Agg без pyplot (как
``spectral._render_topomap`` — расчёт идёт в потоках). Сбой картинки —
warning в ``warnings`` отчёта, чистка не страдает (тот же ранг, что у L5
и ICLabel).
"""
import base64
import logging
from typing import Any

import matplotlib
import numpy as np
from numpy.typing import NDArray

from app.core.config import Settings
from app.utils.png import encode_png_rgba8

# Рендер только Agg: расчёт идёт в потоках (job_manager), GUI-бэкенд в них не
# работает — та же причина и тот же порядок, что в `spectral.py` (N32).
matplotlib.use("Agg")

logger = logging.getLogger(__name__)

# Отсечка «два нуля» (как в clean_metrics): дисперсия ниже — честный отказ
# «проценты не определены», а не деление на 1e-308.
_FLOOR = np.finfo(np.float64).tiny

# Палитра heatmap и топокарт ПК: дивергентная RdBu_r на симметричной шкале —
# та же, что у карт разности B−A (`services/compare.py`), читается одинаково.
_QC_CMAP = "RdBu_r"


def _warn(warnings: list[str], text: str) -> None:
    """Добавляет предупреждение, не дублируя («до» и «после» зовут с своими списками)."""
    if text not in warnings:
        warnings.append(text)


def _correlation_matrix(cov: NDArray) -> NDArray:
    """Нормированная ковариация (корреляции) в [−1, 1] — heatmap «до/после» на одной шкале.

    Нулевая дисперсия канала делением не лечится: его строка остаётся нулевой
    (корреляция не определена — рисовать единицу на диагонали было бы враньём).
    """
    diag = np.clip(np.diag(cov), _FLOOR, None)
    return np.clip(cov / np.sqrt(np.outer(diag, diag)), -1.0, 1.0)


def _heatmap_png(corr: NDArray, ch_names: list[str]) -> bytes:
    """Heatmap корреляций каналов: RdBu_r на [−1, 1], подписи каналов, colorbar."""
    from matplotlib.backends.backend_agg import FigureCanvasAgg
    from matplotlib.figure import Figure

    count = len(ch_names)
    side = max(3.0, 0.22 * count + 1.6)  # подпись канала ≈ 0.22" в колонке
    figure = Figure(figsize=(side, side * 0.92), dpi=100, facecolor="white")
    canvas = FigureCanvasAgg(figure)
    axes = figure.add_axes((0.16, 0.04, 0.74, 0.84))
    image = axes.imshow(corr, cmap=_QC_CMAP, vmin=-1.0, vmax=1.0, aspect="equal")
    axes.set_xticks(range(count), labels=ch_names, rotation=90, fontsize=7)
    axes.set_yticks(range(count), labels=ch_names, fontsize=7)
    colorbar = figure.add_axes((0.92, 0.04, 0.024, 0.84))
    figure.colorbar(image, cax=colorbar)
    canvas.draw()
    return encode_png_rgba8(np.asarray(canvas.buffer_rgba(), dtype=np.uint8).copy())


def _pc_topomaps(
    ch_names: list[str],
    eigenvectors: NDArray,
    variance_percent: list[float],
    n_components: int,
    positions: dict[str, NDArray],
    warnings: list[str],
) -> list[dict[str, Any]]:
    """Топокарты первых ``n_components`` собственных векторов (подписи честные)."""
    # Лениво: spectral тянет prepared_signal → artifact_cleaner — цикл (то же
    # решение, что у mains в clean_metrics).
    from app.services.spectral import topomap_png

    components: list[dict[str, Any]] = []
    if not positions:
        _warn(warnings, "Нет позиций монтажа — топокарты ПК не построены (числа на месте)")
        for index in range(1, n_components + 1):
            components.append({
                "index": index,
                "variance_percent": variance_percent[index - 1],
                "topomap_png_b64": None,
            })
        return components

    for index in range(1, n_components + 1):
        vector = np.array(eigenvectors[:, index - 1], dtype=np.float64)
        # Знак собственного вектора произволен: якорим по максимуму |загрузки|,
        # иначе пересчёт показал бы зеркальную картинку «та же PC, другой знак».
        if vector[int(np.argmax(np.abs(vector)))] < 0.0:
            vector = -vector
        values = {name: float(vector[pos]) for pos, name in enumerate(ch_names)}
        scale = float(np.max(np.abs(vector))) or 0.0
        b64: str | None = None
        if scale > 0.0:
            try:
                png = topomap_png(positions, values, cmap=_QC_CMAP, vlim=(-scale, scale))
                b64 = base64.b64encode(png).decode("ascii")
            except Exception as exc:  # картинка вторична к числам — как L5/ICLabel
                _warn(warnings, f"Топокарта PC{index} не построилась: {exc}")
                logger.debug("Топокарта PC%d не построилась", index, exc_info=True)
        components.append({
            "index": index,
            "variance_percent": variance_percent[index - 1],
            "topomap_png_b64": b64,
        })
    return components


def _pca_side(
    data: NDArray,
    ch_names: list[str],
    positions: dict[str, NDArray],
    settings: Settings,
    warnings: list[str],
) -> dict[str, Any]:
    """Числа и картинки QC-слоя одной стороны («до» или «после» чистки)."""
    x = np.asarray(data, dtype=np.float64)
    # Эмпирическая ковариация каналов: np.cov центрирует сам и для одной строки
    # возвращает скаляр — atleast_2d держит контракт «матрица канал×канал».
    cov = np.atleast_2d(np.cov(x))
    eigenvalues, eigenvectors = np.linalg.eigh(cov)  # симметричная → вещественный спектр
    order = np.argsort(eigenvalues)[::-1]
    eigenvalues = np.clip(eigenvalues[order], 0.0, None)  # PSD: минус — числовой шум
    eigenvectors = eigenvectors[:, order]
    # мкВ²: данные MNE в вольтах, как у амплитуды p95 в том же отчёте
    eigenvalues_uv2 = [round(float(value) * 1e12, 3) for value in eigenvalues]

    total = float(eigenvalues.sum())
    if total <= _FLOOR:
        # Честный отказ (конвенция clean_metrics): не делим на ноль и не
        # выдумываем «100 % дисперсии» на пустом сигнале.
        _warn(warnings, "Нулевая дисперсия сигнала — проценты и ПК не определены")
        return {
            "eigenvalues_uv2": eigenvalues_uv2,
            "variance_percent": [],
            "cumulative_percent": [],
            "effective_rank": 0,
            "heatmap_png_b64": None,
            "components": [],
        }

    variance_percent = [round(float(value) / total * 100.0, 2) for value in eigenvalues]
    cumulative_percent = [round(float(value), 2) for value in np.cumsum(variance_percent)]
    # Эффективный ранг: сколько компонент несёт сигнал против шумового хвоста
    effective_rank = int(
        np.count_nonzero(eigenvalues >= float(settings.covariance_qc_tail_ratio) * eigenvalues[0])
    )

    side_warnings: list[str] = []
    heatmap_png_b64: str | None = None
    try:
        png = _heatmap_png(_correlation_matrix(cov), ch_names)
        heatmap_png_b64 = base64.b64encode(png).decode("ascii")
    except Exception as exc:
        _warn(side_warnings, f"Heatmap ковариации не построился: {exc}")
        logger.debug("Heatmap ковариации не построился", exc_info=True)

    n_components = min(max(1, int(settings.covariance_qc_top_components)), len(ch_names))
    components = _pc_topomaps(
        ch_names, eigenvectors, variance_percent, n_components, positions, side_warnings,
    )
    for text in side_warnings:
        _warn(warnings, text)

    return {
        "eigenvalues_uv2": eigenvalues_uv2,
        "variance_percent": variance_percent,
        "cumulative_percent": cumulative_percent,
        "effective_rank": effective_rank,
        "heatmap_png_b64": heatmap_png_b64,
        "components": components,
    }


def covariance_qc(
    before: NDArray,
    after: NDArray,
    ch_names: list[str],
    settings: Settings,
) -> dict[str, Any]:
    """QC-слой ковариации для пары сигналов «до/после» чистки.

    ``before``/``after`` — те же массивы, что у метрик потерь (уже с учётом
    отмен ``exclude_zone_ids``): диагностика обязана видеть текущую
    конфигурацию. Возвращает словарь, который валидирует ``CovarianceQcOut``.
    """
    # Лениво: spectral тянет prepared_signal → artifact_cleaner — цикл импортов
    from app.services.spectral import channel_positions

    warnings: list[str] = []
    positions = channel_positions(ch_names)
    sides = {
        "before": _pca_side(before, ch_names, positions, settings, warnings),
        "after": _pca_side(after, ch_names, positions, settings, warnings),
    }
    return {
        "channels": list(ch_names),
        "before": sides["before"],
        "after": sides["after"],
        "tail_ratio": float(settings.covariance_qc_tail_ratio),
        "warnings": warnings,
    }
