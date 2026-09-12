"""Загрузка EDF + монтаж 10-20 + фильтр."""
import mne
from typing import List


def load_edf(filepath: str, channel_names: List[str], l_freq: float = 1.0, h_freq: float = 40.0) -> mne.io.BaseRaw:
    raw = mne.io.read_raw_edf(filepath, preload=True, stim_channel=False)

    available = [ch for ch in channel_names if ch in raw.ch_names]
    if not available:
        raise ValueError(
            f"Ни один из стандартных каналов не найден. "
            f"Доступные в EDF: {raw.ch_names}"
        )

    raw.pick(available)
    raw.set_montage("standard_1020")
    raw.set_eeg_reference("average", projection=True)
    raw.filter(l_freq, h_freq, fir_design="firwin")
    raw.resample(min(raw.info["sfreq"], 500.0), events="auto")

    return raw
