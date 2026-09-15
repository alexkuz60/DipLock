"""Спектр записи по ритмам δ…γ и топокарты диапазонов (срез 3.4, docs/ui.md §3.3).

Зачем отдельный сервис
----------------------
Разделу «Диполи» нужны две вещи, которых нет в пайплайне локализации:

* **спектр по диапазонам** — по каким ритмам вообще считать диполи (Welch PSD
  по эпохам записи, мкВ²/Гц);
* **топокарты** — картинка распределения мощности ритма по скальпу.

Пиксели UI не считает: топокарта приходит готовым PNG (как срез МРТ в 3.2),
а числа PSD — JSON-ом, чтобы гистограмму рисовал браузер. Отсюда разделение
ответов: ``SpectrumResult`` (числа + ссылки на картинки) и
``GET …/spectrum/topomap/{band}.png`` (PNG с ETag/304).

Что считается
-------------
* сигнал читается тем же загрузчиком, что и весь пайплайн (`load_edf`:
  монтаж 10-20, average reference, band-pass, notch), фильтр применяется к
  **continuous raw** до нарезки — как везде в проекте;
* эпохи нарезаются без наложения и проходят reject-порог: эпохи с амплитудой
  выше порога в PSD не попадают, иначе спектр «съедали» бы артефакты;
* PSD — Welch по эпохам, окно ``n_fft`` (не длиннее эпохи);
* мощность диапазона — среднее PSD по каналам и частотам внутри ``freq_bands``
  (`core/config.py` — единственный источник диапазонов, DRY).

Топокарта (честно о компромиссе)
--------------------------------
Каналы 10-20 раскладываются на плоскость **ортогональной проекцией** координат
монтажа (x, y в системе головы), мощность интерполируется обратными расстояниями
на сетке ``TOPO_SIZE``, вне круга скальпа пиксель прозрачен. Это не сферическая
сплайн-интерполяция MNE (`mne.viz.plot_topomap`) — картинка служебная, а не
публикационная, и тянуть ради неё matplotlib в бэкенд смысла нет. Цвет — шкала
оттенков серого: PNG-энкодер проекта (`app/utils/png.py`) пишет 8-битный серый
(+альфа), а палитру рисовать на сервере незачем — картинка показывает форму
распределения, а не абсолютную шкалу.

Кэш
---
Топокарты кладутся на диск (``cache_dir/spectra/<recording_id>/<signature>/<band>.png``)
и отдаются с ETag. ``signature`` — отпечаток параметров расчёта (полоса фильтра,
notch, длина эпохи, n_fft, набор каналов): сменили фильтр — сменилась подпись, и
старые картинки не «залипают» в кэше браузера. Повторный запрос PNG — чтение
файла без пересчёта PSD; если файла нет (задача ещё не считалась), он строится
лениво, как пирамида сигналов вьюера (2.5).
"""
import hashlib
import logging
import os
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Dict, List, Optional, Sequence, Tuple

import mne
import numpy as np

from app.core.config import Settings
from app.services.edf_loader import _MONTAGE_NAMES, load_edf
from app.services.epoch_segmenter import segment_epochs
from app.services.recordings import Recording
from app.utils.png import encode_png_gray8

logger = logging.getLogger(__name__)

# Окно Welch: длиннее 256 отсчётов смысла нет (частотное разрешение и так выше,
# чем нужно для диапазонов шириной 3–17 Гц), а коротким эпохам окно урезается.
SPECTRUM_N_FFT = 256

# Сторона квадратной топокарты, пикселей. 128 — картинка ~10 КБ: её рисует
# `<img>` в разделе, а браузер кэширует по URL.
TOPO_SIZE = 128

# Окно яркости топокарты: чистый 0/255 «съедает» края шкалы, поэтому рабочая
# шкала уже полной.
TOPO_GRAY_RANGE = (30, 235)

# Показатель степени в интерполяции обратными расстояниями: 2 — стандарт для
# карт скальпа; больше — «пятна» вокруг электродов, меньше — излишнее сглаживание.
TOPO_IDW_POWER = 2.0


class SpectrumError(ValueError):
    """Ошибка параметров/данных спектра — превращается в понятный текст задачи."""


@dataclass
class SpectrumParams:
    """Параметры расчёта спектра (плоская проекция формы запроса)."""

    filter_band: Optional[Tuple[float, float]] = None
    notch_hz: Optional[float] = None
    epoch_length_ms: float = 2000.0
    reference: str = "average"
    reference_channels: Optional[List[str]] = None
    reject_threshold_uv: float = 150.0
    n_fft: int = SPECTRUM_N_FFT


def spectrum_signature(params: SpectrumParams, cfg: Settings, channels: Sequence[str]) -> str:
    """Отпечаток параметров расчёта: ключ дискового кэша топокарт и их ETag.

    Каналы входят в подпись осознанно: после смены набора каналов (или записи)
    топокарта «старыми» значениями не отдаётся.
    """
    digest = hashlib.sha256()
    band = f"{params.filter_band[0]:g}-{params.filter_band[1]:g}" if params.filter_band else "none"
    digest.update("|".join((
        band,
        f"notch={params.notch_hz}",
        f"epoch={params.epoch_length_ms:g}",
        f"reject={params.reject_threshold_uv:g}",
        f"nfft={params.n_fft}",
        f"ref={params.reference}",
        ",".join(channels),
        ",".join(f"{name}:{cfg.freq_bands[name]}" for name in sorted(cfg.freq_bands)),
    )).encode("utf-8"))
    return digest.hexdigest()[:16]


def _topomap_path(cfg: Settings, recording_id: str, signature: str, band: str) -> str:
    """Путь топокарты в дисковом кэше."""
    return os.path.join(cfg.cache_dir, "spectra", recording_id, signature, f"{band}.png")


def topomap_url(cfg: Settings, recording_id: str, band: str) -> str:
    """URL топокарты диапазона (версию клиент добавляет из ``topomap_version``)."""
    return f"{cfg.api_prefix}/recordings/{recording_id}/spectrum/topomap/{band}.png"


def clear_spectrum_cache(cfg: Settings, recording_id: Optional[str] = None) -> None:
    """Удаляет дисковый кэш топокарт (тесты и очистка реестра записей)."""
    import shutil

    root = os.path.join(cfg.cache_dir, "spectra")
    shutil.rmtree(os.path.join(root, recording_id) if recording_id else root, ignore_errors=True)


@lru_cache(maxsize=4)
def _montage_positions(montage_name: str) -> Dict[str, np.ndarray]:
    """Координаты каналов монтажа в системе головы (кэш: файл монтажа читается раз).

    Имя монтажа берётся из общего списка `edf_loader` (MNE 1.13 переименовал
    `standard_1020` в `colin27_1020`), чтобы не дублировать правила версий.
    """
    # MNE 1.13: `make_standard_montage(kind, head_size='auto')` — без verbose.
    montage = mne.channels.make_standard_montage(montage_name)
    return {
        name: np.asarray(position, dtype=float)
        for name, position in montage.get_positions()["ch_pos"].items()
    }


def channel_positions(channels: Sequence[str]) -> Dict[str, np.ndarray]:
    """Позиции каналов записи по монтажу 10-20 (только те, что нашлись).

    Пустой dict — монтаж недоступен: спектр всё равно считается, а топокарты не
    строятся (UI покажет числа и предупреждение) — «рисовать наугад» нельзя.
    """
    for name in _MONTAGE_NAMES:
        try:
            positions = _montage_positions(name)
        except (ValueError, KeyError, RuntimeError):
            continue
        return {ch: positions[ch] for ch in channels if ch in positions}
    return {}


def _scalp_projection(positions: np.ndarray) -> np.ndarray:
    """Плоскость скальпа: ортогональная проекция (x, y) головы, нормировка к [-1, 1].

    Нормировка по максимальному радиусу, а не по крайним значениям осей: так
    круг скальпа остаётся кругом, а его края совпадают с границей картинки.
    """
    xy = positions[:, :2]
    radius = float(np.max(np.linalg.norm(xy, axis=1))) or 1.0
    return xy / radius


def _interpolate_topomap(
    channel_xy: np.ndarray, values: np.ndarray, size: int = TOPO_SIZE,
) -> np.ndarray:
    """Сетка значений топокарты: интерполяция обратными расстояниями.

    Значения определены только внутри единичного круга; вне него альфа картинки
    равна нулю — за границей электродов нет, и «дорисовывать» туда мощность нельзя.
    """
    axis = np.linspace(-1.0, 1.0, size)
    grid_x, grid_y = np.meshgrid(axis, axis)

    flat_x = grid_x.reshape(-1)
    flat_y = grid_y.reshape(-1)
    # Маска круга — в плоском виде: интерполяция считается по пикселям-строками
    inside = (flat_x ** 2 + flat_y ** 2) <= 1.0
    # Матрица расстояний «пиксель × канал»: (size², n_channels)
    distances = np.hypot(
        flat_x[:, None] - channel_xy[None, :, 0],
        flat_y[:, None] - channel_xy[None, :, 1],
    )
    # Точное попадание в электрод — берём его значение как есть (иначе 0/0)
    weights = 1.0 / np.power(np.maximum(distances, 1e-6), TOPO_IDW_POWER)
    interpolated = (weights @ values) / np.sum(weights, axis=1)
    return np.where(inside, interpolated, 0.0).reshape(size, size)


def _normalize(values: np.ndarray) -> np.ndarray:
    """Приводит мощности к 0..1; при постоянной карте — середина шкалы."""
    low = float(np.min(values))
    high = float(np.max(values))
    if not np.isfinite(low) or not np.isfinite(high) or high - low < 1e-12:
        return np.full(values.shape, 0.5, dtype=float)
    return (values - low) / (high - low)


def topomap_png(
    positions: Dict[str, np.ndarray], values: Dict[str, float], size: int = TOPO_SIZE,
) -> bytes:
    """PNG топокарты: круг скальпа, серая шкала, вне круга прозрачно.

    Чистая функция (без диска и MNE) — её и проверяет тест сервиса: картинка
    разбирается обратно по формату `encode_png_gray8`.
    """
    if not positions:
        raise SpectrumError("Нет позиций каналов — топокарта не строится")
    names = [name for name in positions if name in values]
    if not names:
        raise SpectrumError("Нет мощностей для построения топокарты")

    channel_xy = _scalp_projection(np.stack([positions[name] for name in names]))
    normalized = _normalize(np.asarray([values[name] for name in names], dtype=float))
    gray01 = _interpolate_topomap(channel_xy, normalized, size)

    low, high = TOPO_GRAY_RANGE
    gray = np.clip(low + gray01 * (high - low), 0, 255).astype(np.uint8)
    # Альфа — маска круга: пиксель внутри скальпа непрозрачен
    axis = np.linspace(-1.0, 1.0, size)
    grid_x, grid_y = np.meshgrid(axis, axis)
    alpha = np.where((grid_x ** 2 + grid_y ** 2) <= 1.0, 255, 0).astype(np.uint8)
    return encode_png_gray8(gray, alpha)


def _band_powers(
    freqs: np.ndarray, psd_mean: np.ndarray, bands: Dict[str, tuple],
) -> Dict[str, Optional[float]]:
    """Средняя мощность каждого диапазона: PSD уже усреднён по эпохам.

    Диапазон без попавших частот (например γ при узкой полосе фильтра) даёт
    ``None``, а не NaN: «NaN» — невалидный JSON, и ответ ломался бы на клиенте,
    тогда как ``None`` читается как «не измерено» (UI покажет «—»).
    """
    powers: Dict[str, Optional[float]] = {}
    for name, (fmin, fmax) in bands.items():
        mask = (freqs >= fmin) & (freqs <= fmax)
        powers[name] = float(np.mean(psd_mean[:, mask])) if np.any(mask) else None
    return powers


def _channel_band_power(
    freqs: np.ndarray, psd_mean: np.ndarray, channels: List[str], fmin: float, fmax: float,
) -> Dict[str, float]:
    """Мощность диапазона по каждому каналу — значения для топокарты."""
    mask = (freqs >= fmin) & (freqs <= fmax)
    if not np.any(mask):
        return {}
    per_channel = np.mean(psd_mean[:, mask], axis=1)
    return {name: float(value) for name, value in zip(channels, per_channel)}


def _prepare_epochs(recording: Recording, cfg: Settings, params: SpectrumParams) -> Any:
    """Читает запись и нарезает эпохи для PSD (reject-порог из параметров).

    Аннотации артефактов здесь не нужны: `segment_epochs` отбраковывает эпохи по
    амплитуде (reject), а детекция артефактов — отдельная стадия предподготовки
    (2.7). Считать её второй раз ради спектра незачем.
    """
    l_freq: Optional[float] = None
    h_freq: Optional[float] = None
    if params.filter_band is not None:
        l_freq, h_freq = params.filter_band

    try:
        raw = load_edf(
            recording.path,
            cfg.standard_channels,
            l_freq=l_freq,
            h_freq=h_freq,
            units=cfg.edf_units,
            notch_hz=params.notch_hz,
            reference_channels=params.reference_channels,
        )
    except ValueError as exc:
        raise SpectrumError(str(exc)) from exc

    try:
        epochs = segment_epochs(
            raw,
            mne.Annotations([], [], []),
            epoch_length_ms=params.epoch_length_ms,
            reject_threshold_uv=params.reject_threshold_uv,
        )
    except ValueError as exc:
        raise SpectrumError(str(exc)) from exc
    return raw, epochs


def _compute_psd(
    epochs: Any, cfg: Settings, params: SpectrumParams,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    """Welch PSD по эпохам: ``(freqs, psd, psd_mean, n_fft)`` в мкВ²/Гц.

    Данные MNE приходят в вольтах, поэтому x1e12 даёт мкВ²/Гц без параметра
    ``units`` (он дрейфует между версиями MNE — см. правила в `AGENTS.md`).
    Окно не длиннее эпохи: иначе короткие нарезки (250 мс) роняют `compute_psd`.
    """
    n_times = len(epochs.times)
    n_fft = int(min(max(4, params.n_fft), n_times))
    fmin = min(band[0] for band in cfg.freq_bands.values())
    fmax = max(band[1] for band in cfg.freq_bands.values())

    spectrum = epochs.compute_psd(
        method="welch", fmin=fmin, fmax=fmax, n_fft=n_fft, verbose=False,
    )
    psd = spectrum.get_data() * 1e12  # (n_epochs, n_channels, n_freqs), мкВ²/Гц
    freqs = np.asarray(spectrum.freqs, dtype=float)
    return freqs, psd, np.mean(psd, axis=0), n_fft


def compute_spectrum(
    recording: Recording,
    cfg: Settings,
    params: SpectrumParams,
    progress: Any = None,
) -> Dict[str, Any]:
    """Считает PSD по диапазонам, строит и кэширует топокарты.

    Возвращает dict под схему ``SpectrumResult`` (её валидирует API): так воркер
    не зависит от схемы ответа, а прогресс доступен по ходу вычислений.
    """
    report = progress or (lambda *args, **kwargs: None)
    started = time.perf_counter()
    report("load_edf", message="Чтение EDF, монтаж 10-20")

    raw, epochs = _prepare_epochs(recording, cfg, params)
    channels = list(epochs.ch_names)
    if not channels:
        raise SpectrumError("В записи не нашлось каналов для спектра")

    report(
        "spectrum",
        message=f"Welch PSD по {len(epochs)} эпохам",
        epochs_done=0,
        epochs_total=len(epochs),
    )
    freqs, _psd, psd_mean, n_fft = _compute_psd(epochs, cfg, params)
    band_powers = _band_powers(freqs, psd_mean, cfg.freq_bands)

    warnings: List[str] = []
    positions = channel_positions(channels)
    missed = [name for name in channels if name not in positions]
    if missed:
        warnings.append(
            "Каналы без позиции в монтаже не попали в топокарты: " + ", ".join(missed)
        )
    if len(positions) < 3:
        warnings.append("Слишком мало каналов с позициями — топокарты не построены")

    signature = spectrum_signature(params, cfg, channels)
    report(
        "topomaps",
        message=f"Топокарты диапазонов: {len(cfg.freq_bands)}",
        epochs_done=len(epochs),
        epochs_total=len(epochs),
    )
    bands_out: List[Dict[str, Any]] = []
    for name, (fmin, fmax) in cfg.freq_bands.items():
        url: Optional[str] = None
        values = _channel_band_power(freqs, psd_mean, channels, fmin, fmax)
        if len(values) >= 3:
            _write_topomap(cfg, recording.recording_id, signature, name, positions, values)
            url = topomap_url(cfg, recording.recording_id, name)
        bands_out.append({
            "name": name,
            "fmin": float(fmin),
            "fmax": float(fmax),
            "power_uv2": band_powers[name],
            "topomap_url": url,
        })

    report(
        "done", 1.0,
        message=f"Спектр готов: {len(freqs)} частот, {len(cfg.freq_bands)} диапазонов",
        epochs_done=len(epochs),
        epochs_total=len(epochs),
    )
    return {
        "recording_id": recording.recording_id,
        "channels": channels,
        "missed_channels": missed,
        "sfreq": float(raw.info["sfreq"]),
        "epoch_length_ms": params.epoch_length_ms,
        "n_epochs": len(epochs),
        "n_fft": n_fft,
        "filter_band_hz": list(params.filter_band) if params.filter_band else None,
        "notch_hz": params.notch_hz,
        "reject_threshold_uv": params.reject_threshold_uv,
        "freqs": [float(value) for value in freqs],
        "psd_mean_uv2": [float(value) for value in np.mean(psd_mean, axis=0)],
        "bands": bands_out,
        "topomap_version": signature,
        "warnings": warnings,
        "duration_sec_calc": round(time.perf_counter() - started, 3),
    }


def _write_topomap(
    cfg: Settings,
    recording_id: str,
    signature: str,
    band: str,
    positions: Dict[str, np.ndarray],
    values: Dict[str, float],
) -> None:
    """Строит и атомарно кладёт топокарту на диск; сбой кэша не критичен."""
    path = _topomap_path(cfg, recording_id, signature, band)
    try:
        data = topomap_png(positions, values)
    except SpectrumError as exc:
        logger.warning("Топокарта %s не построена: %s", band, exc)
        return
    tmp = f"{path}.tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    except OSError as exc:
        logger.warning("Кэш топокарт не записан (%s): %s", path, exc)


def cached_topomap(
    recording: Recording, cfg: Settings, params: SpectrumParams, band: str,
) -> Tuple[bytes, str]:
    """PNG топокарты + ETag; при промахе кэша картинка строится заново.

    Ленивый пересчёт (как у пирамиды сигналов, 2.5): браузер может запросить
    картинку из уже показанного результата после перезапуска сервера — кэша в
    памяти нет, но посчитать картинку дешевле, чем отдать 404 на живую ссылку.
    """
    if band not in cfg.freq_bands:
        raise SpectrumError(f"Неизвестный диапазон: {band!r}")
    channels = list(recording.meta.get("channels") or [])
    signature = spectrum_signature(params, cfg, channels)
    path = _topomap_path(cfg, recording.recording_id, signature, band)
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except OSError:
        compute_spectrum(recording, cfg, params)
        try:
            with open(path, "rb") as fh:
                data = fh.read()
        except OSError as exc:
            raise SpectrumError(
                f"Топокарта {band} недоступна: не удалось построить (позиции каналов?)"
            ) from exc
    return data, f"{signature}-{band}"
