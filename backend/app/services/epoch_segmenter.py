"""Нарезка эпох БЕЗ overlap. Длина выбирается из списка: [250, 500, ..., 2000] мс."""
import mne
import numpy as np
from app.core.config import settings


def segment_epochs(
    raw: mne.io.BaseRaw,
    artifact_annotations: mne.Annotations,
    epoch_length_ms: float = 2000.0,
    reject_threshold_uv: float = 150.0,
) -> mne.Epochs:
    """Разбивает сессию на эпохи без наложения (non-overlapping)."""
    valid_lengths = settings.epoch_lengths_ms  # DRY: единый список из config.py
    if epoch_length_ms not in valid_lengths:
        raise ValueError(f"Длина эпохи {epoch_length_ms} мс не в списке: {valid_lengths}")

    raw.set_annotations(artifact_annotations)
    epoch_length_sec = epoch_length_ms / 1000.0

    # События без overlap
    events = mne.make_fixed_length_events(
        raw, duration=epoch_length_sec, first_samp=0,
    )

    # Эпохи с reject-фильтрацией: эпохи с артефактами ОТБРАСЫВАЮТСЯ (drop),
    # если превышают порог. Пропущенные доступны через epochs.drop_log/metrics.
    # baseline=None явно: MNE по умолчанию берёт (None, 0), что при tmin=0
    # даёт интервал в 1 сэмпл и ValueError. Для continuous EEG без стимула
    # коррекция по baseline неприменима.
    epochs = mne.Epochs(
        raw, events, tmin=0, tmax=epoch_length_sec,
        baseline=None,
        reject=dict(eeg=reject_threshold_uv * 1e-6),
        preload=True, verbose=False,
    )

    if len(epochs) == 0:
        raise ValueError(
            f"Все эпохи отброшены reject-фильтром (порог {reject_threshold_uv} мкВ). "
            "Проверьте масштаб/единицы EDF и качество сигнала."
        )

    return epochs
