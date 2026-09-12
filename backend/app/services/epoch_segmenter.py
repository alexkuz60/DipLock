"""Нарезка эпох БЕЗ overlap. Длина выбирается из списка: [250, 500, ..., 2000] мс."""
import mne
import numpy as np


def segment_epochs(
    raw: mne.io.BaseRaw,
    artifact_annotations: mne.Annotations,
    epoch_length_ms: float = 2000.0,
    reject_threshold_uv: float = 150.0,
) -> mne.Epochs:
    """Разбивает сессию на эпохи без наложения (non-overlapping)."""
    valid_lengths = [250, 500, 750, 1000, 1250, 1500, 1750, 2000]
    if epoch_length_ms not in valid_lengths:
        raise ValueError(f"Длина эпохи {epoch_length_ms} мс не в списке: {valid_lengths}")

    raw.set_annotations(artifact_annotations)
    epoch_length_sec = epoch_length_ms / 1000.0

    # События без overlap
    events = mne.make_fixed_length_events(
        raw, duration=epoch_length_sec, first_samp=0,
    )

    epochs = mne.Epochs(
        raw, events, tmin=0, tmax=epoch_length_sec,
        baseline=(None, 0),
        reject=dict(eeg=reject_threshold_uv * 1e-6),
        preload=True, verbose=False,
    )

    # Пометим пропущенные (с артефактами)
    return epochs
