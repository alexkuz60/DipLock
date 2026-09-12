"""Загрузка EDF + монтаж 10-20 + фильтр."""
import logging
import re
from typing import Dict, List, Optional

import mne
import numpy as np

logger = logging.getLogger(__name__)

# MNE >= 1.13 переименовал montage 'standard_1020' -> 'colin27_1020'
# (старое имя deprecated и будет удалено в 1.14).
_MONTAGE_NAMES = ("colin27_1020", "standard_1020")

# EDF без physical dimension: MNE трактует цифровые значения как «вольты»,
# хотя реально они в микровольтах → масштаб завышен в 1e6 раз.
_UNREALISTIC_STD_V = 1e-3  # > 1 мВ std для ЭЭГ физиологически невозможно
_UV_TO_V = 1e-6

# Устаревшие обозначения 10-20 -> современные (MNE montage знает оба)
_CHANNEL_ALIASES: Dict[str, str] = {
    "T3": "T7",
    "T4": "T8",
    "T5": "P7",
    "T6": "P8",
}

# Префиксы производителей ЭЭГ-систем: "EEG F7", "eeg-fp1", "POL C3", "Ch5"
_CHANNEL_PREFIX_RE = re.compile(r"^(?:EEG|POL|CH)\s*[-_ ]?\s*", re.IGNORECASE)


def normalize_channel_name(name: str) -> str:
    """Приводит имя канала ЭЭГ к стандарту 10-20.

    "EEG F7" -> "F7"; "EEG T3" -> "T7"; "eeg-fp1" -> "Fp1"; "Cz" -> "Cz".
    """
    cleaned = _CHANNEL_PREFIX_RE.sub("", name.strip())
    match = re.fullmatch(r"([A-Za-z]+)\s*(\d*)", cleaned)
    if match:
        letters, digits = match.group(1), match.group(2)
        cleaned = letters[0].upper() + letters[1:].lower() + digits
    return _CHANNEL_ALIASES.get(cleaned, cleaned)


def _apply_standard_montage(raw: mne.io.BaseRaw) -> None:
    """Ставит монтаж 10-20, совместимо с MNE до/после 1.13."""
    last_err: Exception | None = None
    for name in _MONTAGE_NAMES:
        try:
            raw.set_montage(name)
            return
        except (ValueError, KeyError, RuntimeError) as err:  # noqa: PERF203
            last_err = err
    raise ValueError(f"Не удалось установить монтаж 10-20: {last_err}")


def _read_raw_edf(filepath: str, units: Optional[str]) -> mne.io.BaseRaw:
    """Читает EDF; units передаётся только при явном указании (иначе авто MNE)."""
    kwargs: Dict = {"preload": True, "stim_channel": False}
    if units is not None:
        kwargs["units"] = units
    return mne.io.read_raw_edf(filepath, **kwargs)


def _ensure_physical_units(raw: mne.io.BaseRaw, requested_units: Optional[str]) -> mne.io.BaseRaw:
    """Страхует от нефизиологического масштаба.

    Часть EDF-файлов не содержит physical dimension, и MNE читает цифровые
    значения как «вольты» (в 1e6 раз больше). Если медианный std заведомо
    нереалистичен для ЭЭГ, пересчитываем данные как микровольты.
    """
    if requested_units is not None:
        return raw
    median_std = float(np.median(np.std(raw.get_data(verbose=False), axis=1)))
    if median_std > _UNREALISTIC_STD_V:
        logger.warning(
            "Нефизиологичный масштаб EDF (median std=%.3g В): похоже, файл без "
            "physical dimension. Пересчитываем как микровольты (x1e-6). "
            "Явно задайте EDF_UNITS, если это не так.",
            median_std,
        )
        raw.apply_function(lambda x: x * _UV_TO_V, verbose=False)
    return raw


def load_edf(
    filepath: str,
    channel_names: List[str],
    l_freq: float = 1.0,
    h_freq: float = 40.0,
    units: Optional[str] = None,
) -> mne.io.BaseRaw:
    raw = _read_raw_edf(filepath, units)
    raw = _ensure_physical_units(raw, units)

    # Нормализуем имена каналов EDF (префиксы "EEG"/"POL", T3->T7 и т.п.),
    # чтобы сопоставить их со стандартом 10-20 из настроек.
    rename: Dict[str, str] = {}
    for orig in raw.ch_names:
        norm = normalize_channel_name(orig)
        if norm in channel_names and norm not in rename.values():
            rename[orig] = norm
    if rename:
        raw.rename_channels(rename)

    available = [ch for ch in channel_names if ch in raw.ch_names]
    if not available:
        raise ValueError(
            f"Ни один из стандартных каналов не найден. "
            f"Доступные в EDF: {raw.ch_names}"
        )

    raw.pick(available)
    _apply_standard_montage(raw)
    # Average reference применяем сразу (projection=False): mne.fit_dipole
    # требует applied average reference, а не отложенную проекцию.
    raw.set_eeg_reference("average", projection=False)
    raw.filter(l_freq, h_freq, fir_design="firwin")
    # Даунсэмплинг до 500 Гц только если запись чаще (экономия памяти/времени)
    if raw.info["sfreq"] > 500.0:
        raw.resample(500.0)

    return raw
