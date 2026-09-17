"""Единый отпечаток версий ассетов (A7, этап 6).

До этого модуля у каждого тяжёлого ассета была **своя** версия и свой способ её
подъёма: ``surface_cache.surface_version`` (отпечаток файлов меша), ``mri_version``
(номер ``MRI_GRID_VERSION`` + шаг сетки + отпечаток тома), ``contour_version``
(номер ``CONTOUR_VERSION`` + шаг сетки + отпечаток атласа). Три реализации одной
идеи расходились: у одной в отпечаток входили границы сетки, у другой — нет; у
одной номер версии поднимался вручную, у другой его не было вовсе. Забыли поднять
версию — на диске и в браузере остаются старые ассеты, и это не воспроизводится
в тестах.

Здесь входы ассетов объявлены **в одном месте**, а отпечаток считается одной
функцией::

    отпечаток = sha256(kind : version : params : отпечатки файлов данных)[:16]

Правило пользователя модуля: меняете данные или шаги сборки ассета — сначала
поднимаете ``version`` соответствующей сборки, потом код. Тест
``tests/test_asset_versions.py::test_snapshot_of_asset_inputs`` падает при любом
изменении входов без правки снапшота, то есть напоминает про подъём версии.

Два вида «версий» в проекте — намеренно разные, и путать их нельзя:

* **версия ассета** (этот модуль) — сборка тяжёлого статического артефакта из
  файлов FreeSurfer; поднимается вручную, потому что изменение кода сборки
  снаружи не видно;
* **отпечаток расчёта** (``spectral.spectrum_signature``,
  ``spectrogram.spectrogram_signature`` — они же ``topomap_version`` и
  ``grid_version`` в ответах) — набор параметров конкретного расчёта; меняется
  автоматически вместе с параметрами, ручного подъёма не требует.
"""
import hashlib
import json
import os
from dataclasses import dataclass
from typing import Any

# Длина «тега» отпечатка: 16 hex-символов хватает и на ETag, и на имя файла
# кэша, и на ``?v=`` в URL (та же длина была у прежних трёх реализаций).
TAG_LENGTH = 16

# --- Входы ассетов (единственный источник этих чисел для всего проекта) -------

# Меш fsaverage + атлас Brodmann (``/surface``, ``/surface/brodmann``).
# 1 — начальный номер: до этапа 6 версия считалась без него, и поднять её при
# изменении шагов сборки было нечем.
SURFACE_VERSION = 1
SURFACE_STAMP_RELATIVE: tuple[str, ...] = (
    "fsaverage/surf/lh.inflated",
    "fsaverage/surf/rh.inflated",
    "fsaverage/label/lh.PALS_B12_Brodmann.annot",
    "fsaverage/label/rh.PALS_B12_Brodmann.annot",
)

# Том МРТ на MNI-сетке (``/surface/mri``, срезы PNG).
# 2 — выборка узлов сетки берёт строку обратной матрицы по оси вокселей (у
# коронарной укладки T1 оси y и z были перепутаны, срез показывал не ту анатомию).
MRI_GRID_VERSION = 2
MRI_SPACING_MM = 1.0
# Границы MNI-сетки: объём мозга с мозжечком и стволом по маске ``brainmask``
# (интеграционный тест сверяет их с реальным томом). Это же — границы фигур на
# фронтенде (`MNI_BRAIN_BOUNDS`): картинка среза ровно накрывает прямоугольник
# плоскости, поэтому обе стороны обязаны сойтись до миллиметра.
MRI_BOUNDS: dict[str, tuple[float, float]] = {
    "x": (-80.0, 80.0),
    "y": (-116.0, 80.0),
    "z": (-82.0, 90.0),
}
# Окно интенсивности: перцентили яркости внутри маски мозга. 1/99 вместо
# min/max — иначе пара выбросов «съедает» весь динамический диапазон, и срез
# выглядит серой заливкой.
MRI_WINDOW_PERCENTILES = (1.0, 99.0)
# Файлы тома, по «отпечатку» которых считается версия ассета (ETag).
# Порядок значим: [0] — том T1, [1] — маска мозга (так их читает сборка).
MRI_STAMP_RELATIVE: tuple[str, ...] = (
    "fsaverage/mri/T1.mgz",
    "fsaverage/mri/brainmask.mgz",
)

# Объёмы меток и контуры структур/полей Бродмана (``/surface/contours``).
# 2 — разметки полушарий разведены по id (в annot обоих полушарий id совпадают).
CONTOUR_VERSION = 2
# Шаг сетки контуров: тот же, что у срезов МРТ (контур обязан совпасть с картинкой).
CONTOUR_SPACING_MM = MRI_SPACING_MM
# Упрощение контура, мм: сетка 1 мм даёт точку на пиксель, для отрисовки и
# хит-теста хватает десятых долей точности.
CONTOUR_SIMPLIFY_MM = 0.6
# Структура мельче этого на срез не рисуется: иначе «пыль» из обрезков коры,
# которые на 1 мм-срезе выглядят как случайные штрихи.
MIN_SHAPE_AREA_MM2 = 25.0
# Метод производной BA-разметки — уходит в ответ и в ``/meta`` (честность картинки).
BRODMANN_METHOD = "nearest_cortex_vertex"
# Смещение id полей Бродмана по полушариям: в annot обоих полушарий id лежат в
# одном диапазоне (2…67), и без смещения разметки lh и rh слились бы в одну.
CONTOUR_AREA_ID_OFFSET: dict[str, int] = {"lh": 0, "rh": 10000}
CONTOUR_STAMP_RELATIVE: tuple[str, ...] = (
    "fsaverage/mri/aparc+aseg.mgz",
    "fsaverage/mri/lh.ribbon.mgz",
    "fsaverage/mri/rh.ribbon.mgz",
    "fsaverage/label/lh.PALS_B12_Brodmann.annot",
    "fsaverage/label/rh.PALS_B12_Brodmann.annot",
    "fsaverage/surf/lh.white",
    "fsaverage/surf/rh.white",
)


@dataclass(frozen=True)
class AssetSpec:
    """Входы одного ассета: версия сборки, параметры и файлы данных.

    ``params`` — всё, что влияет на байты артефакта и объявлено кодом сборки
    (шаг сетки, границы, окно интенсивности, метод разметки). ``stamp_files`` —
    пути относительно ``subjects_dir``, по отпечатку которых ассет устаревает
    без участия человека.
    """

    kind: str
    title: str
    version: int
    params: dict[str, Any]
    stamp_files: tuple[str, ...]


# Реестр ассетов: единственное место, где ассет объявляет свои входы.
ASSET_SPECS: dict[str, AssetSpec] = {
    "surface": AssetSpec(
        kind="surface",
        title="Меш fsaverage и поля Бродмана",
        version=SURFACE_VERSION,
        params={
            "subject": "fsaverage",
            "mesh": "inflated",
            "hemispheres": ["lh", "rh"],
            "atlas": "PALS_B12_Brodmann",
        },
        stamp_files=SURFACE_STAMP_RELATIVE,
    ),
    "mri": AssetSpec(
        kind="mri",
        title="Том МРТ на MNI-сетке",
        version=MRI_GRID_VERSION,
        params={
            "subject": "fsaverage",
            "source": "T1.mgz + brainmask.mgz",
            "grid": "mni",
            "spacing_mm": MRI_SPACING_MM,
            "bounds": {axis: list(value) for axis, value in MRI_BOUNDS.items()},
            "window_percentiles": list(MRI_WINDOW_PERCENTILES),
        },
        stamp_files=MRI_STAMP_RELATIVE,
    ),
    "contours": AssetSpec(
        kind="contours",
        title="Объёмы и контуры атласа",
        version=CONTOUR_VERSION,
        params={
            "subject": "fsaverage",
            "source": "aparc+aseg.mgz + ribbon.mgz",
            "spacing_mm": CONTOUR_SPACING_MM,
            "simplify_mm": CONTOUR_SIMPLIFY_MM,
            "min_area_mm2": MIN_SHAPE_AREA_MM2,
            "brodmann_method": BRODMANN_METHOD,
            "area_id_offset": dict(CONTOUR_AREA_ID_OFFSET),
        },
        stamp_files=CONTOUR_STAMP_RELATIVE,
    ),
}

ASSET_KINDS: tuple[str, ...] = tuple(ASSET_SPECS)


def spec(kind: str) -> AssetSpec:
    """Входы ассета по имени; неизвестное имя — ошибка программиста, а не клиента."""
    try:
        return ASSET_SPECS[kind]
    except KeyError as exc:  # pragma: no cover — сюда попадают только опечатки в коде
        raise KeyError(
            f"Неизвестный ассет {kind!r}: есть только {', '.join(ASSET_KINDS)}"
        ) from exc


def file_stamp(subjects_dir: str, relative_path: str) -> str:
    """«Отпечаток» файла данных: размер и mtime (O(1), без чтения содержимого).

    Файла нет — в отпечаток уходит ``missing``: ассет, собранный без файла, и
    ассет после появления файла обязаны иметь разные версии.
    """
    path = os.path.join(subjects_dir, relative_path)
    try:
        stat = os.stat(path)
    except OSError:
        return f"{relative_path}:missing"
    return f"{relative_path}:{stat.st_size}:{int(stat.st_mtime)}"


def fingerprint_of(asset: AssetSpec, subjects_dir: str) -> str:
    """Отпечаток ассета по его входам (публичен ради теста чувствительности)."""
    digest = hashlib.sha256()
    digest.update(f"{asset.kind}:{asset.version}".encode())
    digest.update(
        json.dumps(asset.params, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    )
    for relative_path in asset.stamp_files:
        digest.update(file_stamp(subjects_dir, relative_path).encode("utf-8"))
    return digest.hexdigest()[:TAG_LENGTH]


def fingerprint(kind: str, subjects_dir: str) -> str:
    """Отпечаток ассета: версия + параметры сборки + отпечатки файлов данных.

    Один и тот же вызов для меша, тома МРТ и контуров: ETag, ``?v=`` в URL и имя
    файла дискового кэша у всех считаются отсюда.
    """
    return fingerprint_of(spec(kind), subjects_dir)


def version_of(kind: str) -> int:
    """Версия сборки ассета (её поднимает человек при изменении шагов сборки)."""
    return spec(kind).version


def asset_versions(subjects_dir: str) -> dict[str, str]:
    """Отпечатки всех ассетов — для диагностики (тесты, отладка кэша)."""
    return {kind: fingerprint(kind, subjects_dir) for kind in ASSET_KINDS}
