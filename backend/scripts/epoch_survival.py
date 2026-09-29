"""Замер «длина эпохи × полоса → доля выживших эпох» (решение после чисел).

Вопрос владельца (29.09.2026): не сделать ли длину эпох автоматической по
нижней границе полосы (4000 мс для δ 0.5 Гц, короче для высоких)? Договорились
**сначала посчитать**: короткие эпохи должны реже попадать под BAD_-зоны и
краевой буфер — и это должно давать больше выживших эпох (= больше диполей в
быстром режиме — одна точка на эпоху).

Скрипт гоняет **настоящий конвейер** (`run_preprocess(stage="epochs")` — та же
ветка, что в UI: подготовленный сигнал, детекция артефактов с дефолтными
порогами, нарезка и reject по BAD_), только без API. Длины — текущий список
`epoch_lengths_ms` плюс 4000 мс (вне списка: API-валидация списка в сервисе
не участвует).

Что считаем на комбинацию: всего/выжило эпох, отбраковка **BAD_edge**
(краевой буфер FIR — отдельной колонкой: это тоже «потерянная» запись, а для
широкой полосы ядро 3.3 с → ±1.65 с у краёв), полезных секунд и оценку
диполей. Замер одноразовый: числа идут в `docs/history.md` (как замеры
производительности), постоянным тестом-стражем НЕ фиксируются — запись одна.

Запуск:
    backend/venv/bin/python backend/scripts/epoch_survival.py
    backend/venv/bin/python backend/scripts/epoch_survival.py --edf data/other.edf
"""
import argparse
import os
import re
import shutil
import sys
import tempfile
import time
from collections.abc import Sequence

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:  # запуск файлом, а не модулем
    sys.path.insert(0, _BACKEND_DIR)

from app.core.config import settings  # noqa: E402
from app.services.preprocess import (  # noqa: E402
    PreprocessError,
    PreprocessParams,
    run_preprocess,
)
from app.services.recordings import recording_registry  # noqa: E402

DEFAULT_EDF = os.path.join(os.path.dirname(_BACKEND_DIR), "data", "edf", "test.edf")

# Длины: текущий `epoch_lengths_ms` (250…2000) + 4000 — проверка предложения
# «4000 мс для нижней дельты (0.5 Гц = 2 периода)».
LENGTHS_MS: tuple[float, ...] = (250.0, 500.0, 750.0, 1000.0, 1500.0, 2000.0, 4000.0)

# Полосы: пресеты панели «Фильтр и референс». «Широкий» — дефолт расчётов.
BANDS: dict[str, tuple[float, float] | None] = {
    "без фильтра": None,
    "широкий 0.5–128": (0.5, 128.0),
    "δ 0.5–4": (0.5, 4.0),
    "θ 4–8": (4.0, 8.0),
    "α 8–16": (8.0, 16.0),
    "β 16–32": (16.0, 32.0),
}

# Текст краевого буфера в warnings стадии (тот же, что печатает preprocess)
_EDGE_RE = re.compile(r"Краевой буфер фильтра: (\d+) эпох")


def _register_copy(edf_path: str) -> tuple[str, str]:
    """Копия EDF во временный каталог + регистрация (как POST /recordings).

    Копия нужна, чтобы не трогать реестр реальных записей (TTL/дедуп в
    upload_dir): замер живёт в tmp и убирает за собой.
    """
    tmp_root = tempfile.mkdtemp(prefix="epoch-survival-")
    upload_dir = os.path.join(tmp_root, "rec")
    os.makedirs(upload_dir, exist_ok=True)
    target = os.path.join(upload_dir, os.path.basename(edf_path))
    shutil.copyfile(edf_path, target)
    recording = recording_registry.register(
        target, upload_dir, os.path.basename(edf_path), settings,
    )
    return recording.recording_id, tmp_root


def _edge_dropped(warnings: list[str]) -> int:
    """Эпох, отброшенных краевым буфером, из warnings стадии (текст свой)."""
    for text in warnings:
        match = _EDGE_RE.search(text)
        if match:
            return int(match.group(1))
    return 0


def measure(edf_path: str) -> list[dict[str, float | str]]:
    """Все комбинации «полоса × длина» → строки отчёта (long format).

    Группировка по полосе (внешний цикл — полосы): RAM-кэш подготовленного
    сигнала держит 2 набора, и соседние длины одной полосы попадают в кэш —
    EDF читается один раз на полосу, а не на каждую комбинацию.

    Длины вне `epoch_lengths_ms` (4000) валидируются сервисом
    (`segment_epochs`), поэтому на время замера конфиг расширяется — это
    ровно «если бы конфиг содержал 4000», а не обход проверки: в конце
    список возвращается.
    """
    original_lengths = list(settings.epoch_lengths_ms)
    missing = [value for value in LENGTHS_MS if value not in original_lengths]
    if missing:
        settings.epoch_lengths_ms = [*original_lengths, *missing]
    recording_id, tmp_root = _register_copy(edf_path)
    recording = recording_registry.get(recording_id)
    if recording is None:  # pragma: no cover — register только что вернул запись
        shutil.rmtree(tmp_root, ignore_errors=True)
        raise RuntimeError("запись не зарегистрировалась")
    rows: list[dict[str, float | str]] = []
    duration = float(recording.meta.get("duration_sec") or 0.0)
    try:
        for band_name, band in BANDS.items():
            for length_ms in LENGTHS_MS:
                started = time.perf_counter()
                # Вся запись может уйти в отбраковку (например, медленная
                # полоса + flat-line: сглаженный сигнал похож на мёртвый) —
                # это честный ответ стадии (PreprocessError из UI), но замеру
                # нужна строка «0 выживших» с причиной, а не падение.
                try:
                    result: dict = run_preprocess(
                        recording, settings,
                        PreprocessParams(
                            stage="epochs",
                            filter_band=band,
                            epoch_length_ms=length_ms,
                        ),
                        progress=lambda *_, **__: None,
                    )
                except PreprocessError as exc:
                    rows.append({
                        "band": band_name,
                        "length_ms": length_ms,
                        "total": int(duration * 1000.0 // length_ms),
                        "used": 0,
                        "share": 0.0,
                        "edge": 0,
                        "used_sec": 0.0,
                        "time_share": 0.0,
                        "ms": (time.perf_counter() - started) * 1000.0,
                        "note": str(exc),
                    })
                    continue
                total = int(result["n_epochs_total"])
                used = int(result["n_epochs_used"])
                edge = _edge_dropped(list(result.get("warnings") or []))
                rows.append({
                    "band": band_name,
                    "length_ms": length_ms,
                    "total": total,
                    "used": used,
                    "share": (100.0 * used / total) if total else 0.0,
                    "edge": edge,
                    "used_sec": used * length_ms / 1000.0,
                    "time_share": (100.0 * used * length_ms / 1000.0 / duration)
                    if duration
                    else 0.0,
                    "ms": (time.perf_counter() - started) * 1000.0,
                    "note": "",
                })
    finally:
        recording_registry.clear()
        shutil.rmtree(tmp_root, ignore_errors=True)
        settings.epoch_lengths_ms = original_lengths
    return rows


def render(rows: list[dict[str, float | str]], duration: float) -> str:
    """Markdown-отчёт: таблица комбинаций + сводка выигрыша коротких эпох."""
    lines = [
        f"Запись: {duration:g} с · пороги детекции — дефолты `core/config.py` · "
        "оценка диполей = выжившим эпохам (одна точка на эпоху в пике GFP)",
        "",
        "| Полоса | Длина, мс | Всего | Выжило | % | BAD_edge | Полезных с | % записи |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in rows:
        lines.append(
            f"| {row['band']} | {row['length_ms']:g} | {row['total']} | {row['used']} "
            f"| {row['share']:.0f} | {row['edge']} | {row['used_sec']:g} "
            f"| {row['time_share']:.0f} |"
        )
    lines.append("")
    lines.append("**Сводка по полосам** (доля выживших %: 2000 мс → лучшая длина):")
    for band_name in BANDS:
        subset = [row for row in rows if row["band"] == band_name]
        if not subset:
            continue
        base = next((row for row in subset if row["length_ms"] == 2000.0), subset[-1])
        best = max(subset, key=lambda row: float(row["share"]))
        gain = float(best["share"]) - float(base["share"])
        lines.append(
            f"- **{band_name}**: 2000 мс → {float(base['share']):.0f}% выживших "
            f"({base['used']}/{base['total']}); лучшая {best['length_ms']:g} мс → "
            f"{float(best['share']):.0f}% (**{gain:+.0f} п.п.**), "
            f"полезных {float(best['time_share']):.0f}% записи"
        )
    notes: list[tuple[str, float, str]] = [
        (str(row["band"]), float(row["length_ms"]), str(row["note"]))
        for row in rows
        if row.get("note")
    ]
    if notes:
        lines.append("")
        lines.append("**Примечания** (стадия ответила ошибкой — 0 выживших):")
        for band_name, length_ms, note in notes:
            lines.append(f"- {band_name} × {length_ms:g} мс: {note}")
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--edf", default=DEFAULT_EDF, help="путь к EDF для замера")
    args = parser.parse_args(argv)
    if not os.path.exists(args.edf):
        print(f"Нет файла: {args.edf}", file=sys.stderr)
        return 2

    import mne

    duration = mne.io.read_raw_edf(args.edf, preload=False, verbose=False)
    duration_sec = duration.n_times / float(duration.info["sfreq"])
    print(f"Замер: {args.edf} (sfreq {duration.info['sfreq']:g} Гц, {duration_sec:.1f} с)…")
    started = time.perf_counter()
    rows = measure(args.edf)
    print(render(rows, duration_sec))
    print(f"\nЗамер занял {time.perf_counter() - started:.1f} с "
          f"({len(rows)} комбинаций).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
