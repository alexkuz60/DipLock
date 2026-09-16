"""Прогрев кэша контуров атласа (срез 3.9): структуры + поля Бродмана.

Первый запрос к ``/surface/contours`` собирает объёмы меток: ``aparc+aseg.mgz``
на MNI-сетке 1 мм и производную объёмную разметку полей Бродмана (лента коры
``lh/rh.ribbon.mgz`` → ближайшая вершина ``PALS_B12_Brodmann``). Это около
секунды, и тратить её внутри обработчика HTTP-запроса незачем: скрипт собирает
объёмы заранее, кладёт их в ``cache_dir/contours`` и печатает паспорт — версию
ассета, числа меток и размер JSON среза. Размер ответа печатается специально:
регресс «срез стал весить мегабайт» должен быть виден здесь, а не в браузере.

Запуск:
    backend/venv/bin/python backend/scripts/build_atlas_contours.py
    backend/venv/bin/python backend/scripts/build_atlas_contours.py --force
    backend/venv/bin/python backend/scripts/build_atlas_contours.py --slice axial:0 --slice coronal:-20
"""
import argparse
import json
import logging
import os
import sys
import time
from typing import List, Optional, Sequence, Tuple

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:  # запуск файлом, а не модулем
    sys.path.insert(0, _BACKEND_DIR)

from app.core.config import settings  # noqa: E402
from app.services import atlas_contours as contours  # noqa: E402

logger = logging.getLogger("build_atlas_contours")

# Срезы, которые показываются по умолчанию: три плоскости через AC–PC.
DEFAULT_SLICES: Tuple[str, ...] = ("axial:0", "sagittal:12", "coronal:-20")


def parse_slice(value: str) -> Tuple[str, float]:
    """``ПЛОСКОСТЬ:ММ`` → (плоскость, мм); формат ошибки виден сразу."""
    plane, _, raw_mm = value.partition(":")
    if plane not in contours.PLANE_AXES or not raw_mm:
        raise argparse.ArgumentTypeError(
            f"{value!r}: ожидается ПЛОСКОСТЬ:ММ, где плоскость — "
            f"{', '.join(contours.PLANE_AXES)} (например axial:0)"
        )
    try:
        return plane, float(raw_mm)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"{value!r}: {exc}") from exc


def build(force: bool) -> Tuple[dict, float]:
    """Собирает объёмы (или берёт кэш) и возвращает метаданные и время сборки."""
    cache_path = contours.cache_file(settings)
    if force and os.path.exists(cache_path):
        os.remove(cache_path)
        print(f"Кэш удалён: {cache_path}")
    contours.clear_contour_cache()
    started = time.perf_counter()
    meta = contours.contours_meta(settings)
    return meta, time.perf_counter() - started


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Сборка и прогрев кэша контуров атласа (структуры + поля Бродмана)"
    )
    parser.add_argument(
        "--force", action="store_true", help="удалить кэш версии и собрать объёмы заново"
    )
    parser.add_argument(
        "--slice",
        dest="slices",
        action="append",
        type=parse_slice,
        metavar="ПЛОСКОСТЬ:ММ",
        help="показать контуры среза (можно указать несколько раз)",
    )
    args = parser.parse_args(argv)

    meta, build_seconds = build(args.force)
    cache_path = contours.cache_file(settings)
    size_mb = os.path.getsize(cache_path) / 1e6 if os.path.exists(cache_path) else 0.0
    print(
        f"Ассет: version={meta['version']} · структур {meta['n_structures']} · "
        f"полей {meta['n_areas']} · метод {meta['method']}"
    )
    print(f"Кэш: {cache_path} ({size_mb:.1f} МБ)")
    print(f"Сборка: {build_seconds:.2f} с (кэш на диске — дальше запросы к срезам без неё)")

    entries: List[Tuple[str, float]] = args.slices or list(map(parse_slice, DEFAULT_SLICES))
    for plane, mm in entries:
        started = time.perf_counter()
        payload = contours.slice_contours(settings, plane, mm)
        elapsed_ms = (time.perf_counter() - started) * 1000
        size_kb = len(json.dumps(payload, separators=(",", ":")).encode("utf-8")) / 1024
        print(
            f"  {plane:9s} {payload['mm']:>6g} мм: структур {len(payload['structures']):3d}, "
            f"полей {len(payload['areas']):3d}, JSON {size_kb:6.1f} КБ, {elapsed_ms:6.1f} мс"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
