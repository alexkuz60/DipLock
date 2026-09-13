"""Авто-детекция артефактов: z-score, порог, ICA, flat-line."""
import numpy as np
import mne
from scipy import ndimage
from typing import Tuple, Dict
from app.core.config import Settings


def detect_artifacts(
    raw,
    settings,
    z_threshold: float = 5.0,
    pp_threshold_uv: float = 100.0,
    run_ica: bool = True,
) -> Tuple[mne.Annotations, dict]:
    """Детекция артефактов: z-score, peak-to-peak, flat-line, ICA-EOG.

    ``run_ica=False`` полностью пропускает ICA-ветку (быстрый профиль);
    ICA применяется только при наличии EOG-подобных каналов, факт применения
    возвращается в ``stats["ica_applied"]``.
    """
    annotations = mne.Annotations(onset=[], duration=[], description=[])
    stats = {"zscore_outlier": 0, "peak_to_peak": 0, "flat_line": 0, "ica_eog": 0}
    # Плоские зоны для слоёв вьюера (срез 2.7): аннотации MNE не хранят каналы,
    # а тултипу зоны нужно показать, по каким каналам сработал детектор.
    zones: list = []

    def add_zone(kind: str, onset: float, duration: float, channels: list) -> None:
        """Добавляет зону артефакта в список для UI-слоёв."""
        zones.append({
            "kind": kind,
            "onset_sec": round(float(onset), 3),
            "duration_sec": round(float(duration), 3),
            "channels": list(channels),
        })

    data = raw.get_data()
    sfreq = raw.info["sfreq"]

    # 1. Z-score
    for i, ch in enumerate(raw.ch_names):
        ch_data = data[i]
        std = np.std(ch_data)
        if std == 0:
            continue
        z = np.abs((ch_data - ch_data.mean()) / std)
        bad = z > z_threshold
        if bad.any():
            lab, nf = ndimage.label(bad)
            for r in range(1, nf + 1):
                idx = np.where(lab == r)[0]
                if len(idx) >= 3:
                    onset = idx[0] / sfreq
                    duration = len(idx) / sfreq
                    annotations += mne.Annotations(
                        onset=[onset],
                        duration=[duration],
                        description=["zscore_outlier"],
                    )
                    stats["zscore_outlier"] += 1
                    add_zone("zscore_outlier", onset, duration, [ch])

    # 2. Peak-to-peak (скользящее окно 2 сек)
    win = int(2.0 * sfreq)
    for w_start in range(0, data.shape[1] - win, win // 2):
        pp = np.ptp(data[:, w_start:w_start + win], axis=1)
        exceeded = np.where(pp > pp_threshold_uv * 1e-6)[0]
        if exceeded.size:
            center = (w_start + win // 2) / sfreq
            annotations += mne.Annotations(
                onset=[center], duration=[win / sfreq],
                description=["peak_to_peak"],
            )
            stats["peak_to_peak"] += 1
            add_zone(
                "peak_to_peak", center, win / sfreq,
                [raw.ch_names[int(i)] for i in exceeded],
            )

    # 3. Flat-line
    flat_min = int(settings.flat_line_min_duration_ms / 1000.0 * sfreq)
    for i, ch in enumerate(raw.ch_names):
        flat = np.abs(data[i]) < (settings.flat_line_threshold_uv * 1e-6)
        lab, nf = ndimage.label(flat)
        for r in range(1, nf + 1):
            idx = np.where(lab == r)[0]
            if len(idx) >= flat_min:
                onset = idx[0] / sfreq
                duration = len(idx) / sfreq
                annotations += mne.Annotations(
                    onset=[onset],
                    duration=[duration],
                    description=["flat_line"],
                )
                stats["flat_line"] += 1
                add_zone("flat_line", onset, duration, [ch])

    # 4. ICA EOG (только если запрошена и в записи есть EOG-подобные каналы)
    eog_like = [ch for ch in raw.ch_names if "eog" in ch.lower()]
    ica_applied = False
    if run_ica and eog_like:
        try:
            ica = mne.preprocessing.ICA(n_components=min(18, len(raw.ch_names)), random_state=42, max_iter="auto")
            ica.fit(raw)
            bads, _ = ica.find_bads_eog(raw)
            stats["ica_eog"] = len(bads)
            ica_applied = True
            # Компоненты EOG не привязаны к каналу: помечаем весь монтаж
            if bads:
                add_zone("ica_eog", 0.0, float(raw.times[-1]), list(raw.ch_names))
        except Exception:
            pass

    total = sum(stats.values())
    return annotations, {"total": total, "by_type": stats, "ica_applied": ica_applied, "zones": zones}

