"""Разбор находки 29.09.2026: детектор ``flat_line`` на медленных полосах.

На δ 0.5–4 Гц дефолт (1 мкВ / окно 100 мс) помечает **39% записи (293 зоны)**
``test.edf`` — главная причина 0% выживших эпох у δ (п.5 `todo.md`). Две
гипотезы: (а) на записи реальный дрейф/константные участки; (б) срезание
высоких частот даёт ложную «мёртвость» — здоровая медленная активность в
коротком окне почти не меняется.

Скрипт различает их численно: одна и та же детекция на трёх сигналах записи
(«без фильтра» — ширина, «широкий 0.5–128», «δ 0.5–4») + распределение
размахов в окнах 100 мс против порога. Зона ``flat_line`` на δ **без пары**
(пересечения по каналу) на сигнале «без фильтра» — ложная, созданная
фильтром; парная — реальный константный участок записи.

Запуск (одна запись или несколько):
    backend/venv/bin/python backend/scripts/flat_line_band_audit.py
    backend/venv/bin/python backend/scripts/flat_line_band_audit.py \\
        --edf data/edf/<uuid>/<имя>.edf data/edf/<uuid>/<имя2>.edf

Замер одноразовый: числа идут в `docs/history.md`, постоянным тестом-стражем
НЕ фиксируются (записи разные). Работает через реестр с дедупом (патрон
`epoch_survival.py`), реальные записи и кэши не трогает.
"""
import argparse
import os
import shutil
import sys
import tempfile
import time
from collections.abc import Sequence
from typing import Any

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:  # запуск файлом, а не модулем
    sys.path.insert(0, _BACKEND_DIR)

from app.core.config import settings  # noqa: E402
from app.services.artifact_detector import detect_artifacts  # noqa: E402
from app.services.prepared_signal import prepared_raw_report  # noqa: E402
from app.services.recordings import file_digest, recording_registry  # noqa: E402

DEFAULT_EDF = os.path.join(os.path.dirname(_BACKEND_DIR), "data", "edf", "test.edf")

# Полосы для сравнения: широкая — «здоровый» ориентир, δ — находка замера
# 29.09.2026. Верхняя граница широкой зажимается по Найквисту (запись 250 Гц).
BAND_LOW = (0.5, 4.0)
WIDE_LOW, WIDE_HIGH_MAX = 0.5, 128.0


def _register_copy(edf_path: str, tag: str) -> tuple[str, str]:
    """Копия EDF во временный каталог + регистрация (как POST /recordings).

    Переданный отпечаток включает дедуп: уже зарегистрированные записи
    (``data/edf/<uuid>/``) переиспользуются, копия удаляется — сигнал читается
    из реального файла реестра.
    """
    tmp_root = tempfile.mkdtemp(prefix="flat-line-audit-")
    upload_dir = os.path.join(tmp_root, tag)
    os.makedirs(upload_dir, exist_ok=True)
    target = os.path.join(upload_dir, os.path.basename(edf_path))
    shutil.copyfile(edf_path, target)
    recording = recording_registry.register(
        target, upload_dir, os.path.basename(edf_path), settings,
        digest=file_digest(target),
    )
    if recording.deduplicated:
        shutil.rmtree(upload_dir, ignore_errors=True)
    return recording.recording_id, tmp_root


def _merged_sec(zones: list[dict[str, Any]], duration: float) -> float:
    """Слитые секунды ``flat_line`` по всем каналам (без двойного счёта)."""
    intervals: list[tuple[float, float]] = [
        (z["onset_sec"], z["onset_sec"] + z["duration_sec"]) for z in zones
    ]
    merged = 0.0
    cur_start: float | None = None
    cur_end = 0.0
    for onset, end in sorted(intervals):
        if cur_start is None or onset > cur_end:
            if cur_start is not None:
                merged += cur_end - cur_start
            cur_start, cur_end = onset, end
        else:
            cur_end = max(cur_end, end)
    if cur_start is not None:
        merged += cur_end - cur_start
    return min(merged, duration)


def _window_pp_stats(data: Any, sfreq: float, threshold_uv: float) -> tuple[float, float]:
    """(медиана размаха в окнах 100 мс, доля окон ниже порога) — в мкВ и %."""
    import numpy as np

    win = max(1, int(settings.flat_line_window_ms / 1000.0 * sfreq))
    n_win = data.shape[1] // win
    if n_win == 0:
        return 0.0, 0.0
    windows = data[:, : n_win * win].reshape(data.shape[0], n_win, win)
    pp_uv = (np.nanmax(windows, axis=2) - np.nanmin(windows, axis=2)) * 1e6
    return float(np.median(pp_uv)), float(100.0 * (pp_uv < threshold_uv).mean())


def _has_pair(zone: dict[str, Any], wide_zones: list[dict[str, Any]]) -> bool:
    """Есть ли у зоны парная (по каналу и пересечению времени) зона на широком."""
    onset, end = zone["onset_sec"], zone["onset_sec"] + zone["duration_sec"]
    for other in wide_zones:
        if not set(zone.get("channels", [])) & set(other.get("channels", [])):
            continue
        o_on, o_end = other["onset_sec"], other["onset_sec"] + other["duration_sec"]
        if onset < o_end and o_on < end:
            return True
    return False

def audit_file(edf_path: str) -> list[str]:
    """Отчёт по одной записи: таблица полос + кросс-таблица δ против ширины."""
    import mne

    probe = mne.io.read_raw_edf(edf_path, preload=False, verbose=False)
    sfreq = float(probe.info["sfreq"])
    duration = probe.n_times / sfreq
    wide_high = min(WIDE_HIGH_MAX, sfreq * 0.5 - 2.0)
    bands: dict[str, tuple[float | None, float | None]] = {
        "без фильтра": (None, None),
        f"широкий {WIDE_LOW:g}–{wide_high:g}": (WIDE_LOW, wide_high),
        f"δ {BAND_LOW[0]:g}–{BAND_LOW[1]:g}": BAND_LOW,
    }

    recording_id, tmp_root = _register_copy(edf_path, "flat-line-audit")
    recording = recording_registry.get(recording_id)
    if recording is None:
        shutil.rmtree(tmp_root, ignore_errors=True)
        print(f"Не удалось зарегистрировать запись: {edf_path}", file=sys.stderr)
        return []

    lines: list[str] = []
    flat_by_band: dict[str, list[dict[str, Any]]] = {}
    try:
        lines.append("")
        lines.append(f"### {os.path.basename(edf_path)} — {duration:.1f} с, "
                     f"{sfreq:g} Гц, порог {settings.flat_line_threshold_uv:g} мкВ / "
                     f"окно {settings.flat_line_window_ms:g} мс")
        lines.append("")
        lines.append("| Полоса | Зон flat_line | Покрытие, с | % записи | "
                     "Медиана p2p в окне, мкВ | Окон < порога, % |")
        lines.append("|---|---:|---:|---:|---:|---:|")
        for band_name, (l_freq, h_freq) in bands.items():
            raw, _ = prepared_raw_report(recording, settings, l_freq=l_freq, h_freq=h_freq)
            _, stats = detect_artifacts(raw, settings, run_ica=False)
            flat_zones = [z for z in stats["zones"] if z["kind"] == "flat_line"]
            flat_by_band[band_name] = flat_zones
            merged = _merged_sec(flat_zones, duration)
            pp_med, pp_below = _window_pp_stats(
                raw.get_data(), float(raw.info["sfreq"]),
                settings.flat_line_threshold_uv,
            )
            lines.append(
                f"| {band_name} | {len(flat_zones)} | {merged:.1f} | "
                f"{100.0 * merged / duration:.1f} | {pp_med:.2f} | {pp_below:.1f} |"
            )

        # Кросс-таблица: ложные зоны δ = без пары на «без фильтра» (реальный
        # константный участок записи виден на любой полосе).
        wide_zones = flat_by_band["без фильтра"]
        delta_key = next(k for k in bands if k.startswith("δ"))
        delta_zones = flat_by_band[delta_key]
        paired = sum(1 for z in delta_zones if _has_pair(z, wide_zones))
        lines.append("")
        lines.append(
            f"- δ-зоны: **{len(delta_zones)}**, из них с парой на «без фильтра» "
            f"(реальная константа): **{paired}**, без пары (ложная «мёртвость» "
            f"от фильтра): **{len(delta_zones) - paired}**; "
            f"«без фильтра» всего: {len(wide_zones)}."
        )
    finally:
        recording_registry.clear()
        shutil.rmtree(tmp_root, ignore_errors=True)
    return lines


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--edf", nargs="+", default=[DEFAULT_EDF],
        help="путь(и) к EDF для разбора (по умолчанию data/edf/test.edf)",
    )
    args = parser.parse_args(argv)
    missing = [p for p in args.edf if not os.path.exists(p)]
    if missing:
        print(f"Нет файла: {', '.join(missing)}", file=sys.stderr)
        return 2

    started = time.perf_counter()
    report: list[str] = ["# Разбор детектора flat_line на медленных полосах", ""]
    for path in args.edf:
        report.extend(audit_file(path))
    print("\n".join(report))
    print(f"\nРазбор занял {time.perf_counter() - started:.1f} с "
          f"({len(args.edf)} записей).")
    return 0


if __name__ == "__main__":
    sys.exit(main())

