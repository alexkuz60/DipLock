"""Спайк-оценка `mne-icalabel` и `autoreject` (todo.md, «Сознательно отложено»).

Вопрос (todo.md, Этап 4): стоит ли внедрять **autoreject** (кросс-валидированная
поэпохная отбраковка вместо фиксированных порогов/наших детекторов) и
**mne-icalabel** (ML-разметка ICA-компонентов, ICLabel) — оценку откладывали до
закрытия 2.1–2.3, они закрыты. Скрипт меряет на живой записи качество, время и
цену внедрения; числа идут в `docs/history.md` и вердикт `todo.md` —
постоянным тестом-стражем НЕ фиксируется (замер одна запись, как
`epoch_survival.py`).

Часть A (`autoreject`) гоняет **тот же конвейер**, что стадия `epochs`
(`prepared_raw_report` → `detect_artifacts` → `apply_reference` →
`segment_epochs`), и сравнивает три исхода на одних и тех же эпохах:

* «сейчас» — отбраковка аннотациями `BAD_` от наших детекторов (amplitude
  reject MNE отключён, `reject=None`);
* `AutoReject` **вместо** детекторов (на всех эпохах, кроме `BAD_edge`);
* `AutoReject` **поверх** выживших (роль «второго эшелона»).

Часть B (`mne-icalabel`) фитит ICA тем же `fit_ica`, что продакшн, и сравнивает
текущую разметку (`find_eog_component_inds` + QRS-прокси `_ica_ecg_inds` — те же
хелперы, которыми пользуется ветка `run_ica` детектора) с ICLabel: согласие по
`eye blink`/`heart beat`, что ловится сверх (`muscle`/`line noise`/…), время и
вес модели. ICLabel дополнительно считается на average-referenced копии —
модель обучена на референсированных данных, а в пайплайне ICA грузится **до**
референса (пачка B) — расхождение должно быть видно числом.

Ограничения честно: одна запись (test.edf, 18 каналов, 500 Гц); вердикт — по ней
плюс клиническим прогонам, если владелец сочнёт нужным. Сеть для модели не
нужна: веса ICLabel (~11 МБ) и MEGNet (~29 МБ) вшиты в пакет, **но**
`onnxruntime` зависимостью `mne-icalabel` не заявлен — ставится руками (находка
спайка).

Запуск (изолированное окружение спайка, НЕ основной `backend/venv`):
    backend/venv-spike/bin/python backend/scripts/spike_icalabel_autoreject.py
    backend/venv-spike/bin/python backend/scripts/spike_icalabel_autoreject.py --edf data/other.edf
"""
import argparse
import os
import shutil
import sys
import tempfile
import time
from collections.abc import Sequence

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:  # запуск файлом, а не модулем
    sys.path.insert(0, _BACKEND_DIR)

import mne  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.services.artifact_cleaner import (  # noqa: E402
    _ica_ecg_inds,
    find_eog_component_inds,
    fit_ica,
)
from app.services.artifact_detector import detect_artifacts  # noqa: E402
from app.services.edf_loader import apply_reference  # noqa: E402
from app.services.epoch_segmenter import EDGE_DESC, segment_epochs  # noqa: E402
from app.services.prepared_signal import prepared_raw_report  # noqa: E402
from app.services.recordings import recording_registry  # noqa: E402

DEFAULT_EDF = os.path.join(os.path.dirname(_BACKEND_DIR), "data", "edf", "test.edf")

# Комбинации части A: широкая полоса (дефолт расчётов) на двух длинах + δ —
# медленная полоса, где отбраковка традиционно тяжелее всего.
COMBOS: list[tuple[str, tuple[float, float] | None, float]] = [
    ("широкий 0.5–128", (0.5, 128.0), 2000.0),
    ("широкий 0.5–128", (0.5, 128.0), 500.0),
    ("δ 0.5–4", (0.5, 4.0), 2000.0),
]

# Число компонентов ICA — как в продакшене (`_clean_ica`: min(15, n−1))
ICA_N_COMPONENTS = 15


def _register_copy(edf_path: str) -> tuple[str, str]:
    """Копия EDF во временный каталог + регистрация (как POST /recordings)."""
    tmp_root = tempfile.mkdtemp(prefix="spike-icalabel-")
    upload_dir = os.path.join(tmp_root, "rec")
    os.makedirs(upload_dir, exist_ok=True)
    target = os.path.join(upload_dir, os.path.basename(edf_path))
    shutil.copyfile(edf_path, target)
    recording = recording_registry.register(
        target, upload_dir, os.path.basename(edf_path), settings,
    )
    return recording.recording_id, tmp_root


def _prepared(recording, band: tuple[float, float] | None, apply_ref: bool) -> mne.io.BaseRaw:
    """Свежая копия подготовленного сигнала (кэш отдаёт свою — мутации безопасны)."""
    l_freq = h_freq = None
    if band is not None:
        l_freq, h_freq = band
    raw, _ = prepared_raw_report(
        recording, settings,
        l_freq=l_freq, h_freq=h_freq,
        pipeline=None,  # спайк не пишет в журнал шагов
        apply_ref=apply_ref,
    )
    return raw


def _pct(kept: int, total: int) -> float:
    return 100.0 * kept / total if total else 0.0


def part_autoreject(recording) -> list[dict[str, float | str]]:
    """Часть A: «наши BAD_» против AutoReject (вместо и поверх) — три комбинации."""
    from autoreject import AutoReject

    rows: list[dict[str, float | str]] = []
    for band_name, band, length_ms in COMBOS:
        # --- «сейчас»: детекторы → референс → нарезка (зеркало стадии epochs)
        raw = _prepared(recording, band, apply_ref=False)
        flat_raw = _prepared(recording, None, apply_ref=False) if band is not None else None
        started = time.perf_counter()
        annotations, _stats = detect_artifacts(
            raw, settings, run_ica=False, flat_raw=flat_raw,
        )
        detect_ms = (time.perf_counter() - started) * 1000.0
        apply_reference(raw, None)
        started = time.perf_counter()
        epochs_now = segment_epochs(
            raw, annotations, epoch_length_ms=length_ms, filter_band=band,
        )
        slice_ms = (time.perf_counter() - started) * 1000.0
        total = len(epochs_now.drop_log)
        kept_now = len(epochs_now)
        edge = sum(1 for log in epochs_now.drop_log if EDGE_DESC in log)

        # --- AutoReject вместо детекторов: края (BAD_edge) те же, без BAD_
        raw_all = _prepared(recording, band, apply_ref=True)
        epochs_all = segment_epochs(
            raw_all,
            mne.Annotations(onset=[], duration=[], description=[]),
            epoch_length_ms=length_ms, filter_band=band,
        )
        started = time.perf_counter()
        ar_all = AutoReject(random_state=42, n_jobs=1, verbose=False)
        epochs_ar_all = ar_all.fit_transform(epochs_all.copy())
        ar_all_ms = (time.perf_counter() - started) * 1000.0

        # --- AutoReject поверх выживших (роль «второго эшелона»)
        started = time.perf_counter()
        ar_tail = AutoReject(random_state=42, n_jobs=1, verbose=False)
        epochs_ar_tail = ar_tail.fit_transform(epochs_now.copy())
        ar_tail_ms = (time.perf_counter() - started) * 1000.0

        rows.append({
            "combo": f"{band_name} × {length_ms:g} мс",
            "total": total,
            "edge": edge,
            "kept_now": kept_now,
            "pct_now": _pct(kept_now, total),
            "kept_ar_all": len(epochs_ar_all),
            "pct_ar_all": _pct(len(epochs_ar_all), total),
            "kept_ar_tail": len(epochs_ar_tail),
            "pct_ar_tail": _pct(len(epochs_ar_tail), total),
            "detect_ms": detect_ms,
            "slice_ms": slice_ms,
            "ar_all_ms": ar_all_ms,
            "ar_tail_ms": ar_tail_ms,
        })
    return rows


def part_icalabel(recording) -> str:
    """Часть B: текущая разметка ICA против ICLabel (до и после референса)."""
    import onnxruntime
    from mne_icalabel import label_components

    raw = _prepared(recording, (0.5, 128.0), apply_ref=False)
    started = time.perf_counter()
    ica = fit_ica(raw, ICA_N_COMPONENTS)
    fit_ms = (time.perf_counter() - started) * 1000.0

    started = time.perf_counter()
    try:
        eog_inds, eog_src = find_eog_component_inds(ica, raw)
    except RuntimeError as exc:
        # В test.edf нет Fp1/Fp2 — продакшен (_clean_ica) переводит это в
        # предупреждение, спайк обязан показать разметку, а не падать
        eog_inds, eog_src = [], f"нет ({exc})"
    ecg_inds = _ica_ecg_inds(ica, raw)
    current_ms = (time.perf_counter() - started) * 1000.0

    started = time.perf_counter()
    out_raw = label_components(raw, ica, method="iclabel")
    label_raw_ms = (time.perf_counter() - started) * 1000.0

    raw_ref = raw.copy()
    apply_reference(raw_ref, None)
    started = time.perf_counter()
    out_ref = label_components(raw_ref, ica, method="iclabel")
    label_ref_ms = (time.perf_counter() - started) * 1000.0

    labels_raw = list(out_raw["labels"])
    labels_ref = list(out_ref["labels"])
    probas_raw = [float(p) for p in out_raw["y_pred_proba"]]

    lines = [
        f"Среда: mne-icalabel 0.9.0 (ICLabelNet.onnx ~11.6 МБ вшит в пакет), "
        f"onnxruntime {onnxruntime.__version__} — **зависимостью не заявлен, ставится руками**; "
        f"сеть для весов не нужна.",
        "",
        f"ICA: fit_ica(n={ICA_N_COMPONENTS}) — {fit_ms:.0f} мс; текущая разметка "
        f"(find_bads_eog + QRS-прокси) — {current_ms:.0f} мс; ICLabel — {label_raw_ms:.0f} мс "
        f"(на average-referenced копии — {label_ref_ms:.0f} мс).",
        "",
        "| # | Текущая разметка | ICLabel (до реф.) | proba | ICLabel (avg-ref) |",
        "|---:|---|---|---:|---|",
    ]
    for index in range(len(labels_raw)):
        current = []
        if index in eog_inds:
            current.append(f"EOG/{eog_src}")
        if index in ecg_inds:
            current.append("ECG-прокси")
        lines.append(
            f"| {index} | {', '.join(current) or '—'} | {labels_raw[index]} "
            f"| {probas_raw[index]:.2f} | {labels_ref[index]} |"
        )

    def _set(labels: list[str], name: str) -> set[int]:
        return {i for i, label in enumerate(labels) if label == name}

    eye_raw, heart_raw = _set(labels_raw, "eye blink"), _set(labels_raw, "heart beat")
    eye_ref, heart_ref = _set(labels_ref, "eye blink"), _set(labels_ref, "heart beat")
    eog_set, ecg_set = set(eog_inds), set(ecg_inds)
    extra = ", ".join(
        f"{name}={labels_raw.count(name)}"
        for name in ("muscle artifact", "line noise", "channel noise", "other")
        if labels_raw.count(name)
    )
    lines += [
        "",
        "**Согласие (текущая ↔ ICLabel):**",
        f"- EOG: текущие {sorted(eog_set)} ↔ ICLabel eye {sorted(eye_raw)}: пересечение "
        f"{sorted(eog_set & eye_raw)}, только текущие {sorted(eog_set - eye_raw)}, только "
        f"ICLabel {sorted(eye_raw - eog_set)}; avg-ref eye {sorted(eye_ref)}.",
        f"- ЭКГ: текущие {sorted(ecg_set)} ↔ ICLabel heart {sorted(heart_raw)}: пересечение "
        f"{sorted(ecg_set & heart_raw)}, только ICLabel {sorted(heart_raw - ecg_set)}; "
        f"avg-ref heart {sorted(heart_ref)}.",
        f"- Ловит сверх (не глаза/сердце): {extra}.",
        f"- Метка «brain»: {labels_raw.count('brain')} из {len(labels_raw)}.",
    ]
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--edf", default=DEFAULT_EDF, help="путь к EDF для спайка")
    args = parser.parse_args(argv)
    if not os.path.exists(args.edf):
        print(f"Нет файла: {args.edf}", file=sys.stderr)
        return 2

    info = mne.io.read_raw_edf(args.edf, preload=False, verbose=False)
    duration_sec = info.n_times / float(info.info["sfreq"])
    print(f"Спайк: {args.edf} (sfreq {info.info['sfreq']:g} Гц, {duration_sec:.1f} с)…")

    recording_id, tmp_root = _register_copy(args.edf)
    recording = recording_registry.get(recording_id)
    if recording is None:  # pragma: no cover — register только что вернул запись
        shutil.rmtree(tmp_root, ignore_errors=True)
        raise RuntimeError("запись не зарегистрировалась")

    started = time.perf_counter()
    try:
        print("\n## Часть A: autoreject против наших BAD_-детекторов\n")
        rows = part_autoreject(recording)
        print(
            "| Комбинация | Всего | BAD_edge | «Сейчас» % | AR вместо % | AR поверх % | "
            "Детект+нарезка, мс | AR-фит (вместо), мс | AR-фит (поверх), мс |"
        )
        print("|---|---:|---:|---:|---:|---:|---:|---:|---:|")
        for row in rows:
            print(
                f"| {row['combo']} | {row['total']} | {row['edge']} "
                f"| {row['pct_now']:.0f} ({row['kept_now']}) "
                f"| {row['pct_ar_all']:.0f} ({row['kept_ar_all']}) "
                f"| {row['pct_ar_tail']:.0f} ({row['kept_ar_tail']}) "
                f"| {row['detect_ms']:.0f}+{row['slice_ms']:.0f} "
                f"| {row['ar_all_ms']:.0f} | {row['ar_tail_ms']:.0f} |"
            )

        print("\n## Часть B: mne-icalabel (ICLabel) против текущей разметки ICA\n")
        print(part_icalabel(recording))
        print(f"\nОбщее время спайка: {time.perf_counter() - started:.1f} с.")
    finally:
        recording_registry.clear()
        shutil.rmtree(tmp_root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())



