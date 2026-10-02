"""BEM и transform fsaverage на живой установке (задача «FreeSurfer», todo.md).

Порядок разрешения для обоих ассетов:

1. **готовый файл установки** (``fsaverage-5120-5120-5120-bem-sol.fif``,
   ``fsaverage-trans.fif``) — предпочтителен, это результат штатной сборки;
2. **дисковый кэш расчёта** (``cache_dir/bem/``) — результат, посчитанный здесь;
3. **расчёт из исходников установки** чистым MNE, CLI FreeSurfer не нужен:
   BEM — из трёх поверхностей ``.surf`` (``mne.make_bem_model`` +
   ``make_bem_solution``, ico-4 = 5120 треугольников, как у готового файла),
   transform — из ``fsaverage-fiducials.fif``
   (``get_ras_to_neuromag_trans`` → ``mne.Transform('mri', 'head')``).

Правило безопасности соблюдено: наружу отдаётся **путь к файлу** или объект
``mne.Transform`` — никогда не строка-«трансформация». Функции ``*_source``
отвечают без расчёта (для ``/init-status`` и ``/meta``): статус готовности не
должен запускать тяжёлую математику.
"""
import logging
import os
from typing import TYPE_CHECKING

import mne
import numpy as np

if TYPE_CHECKING:  # аннотации без цикла импортов (модуль тянет только mne)
    from app.core.config import Settings

logger = logging.getLogger(__name__)

# Решение считается с той же разрешающей способностью, что и готовый файл
# установки (5120 треугольников на слой = ico-4).
BEM_ICO = 4
BEM_CONDUCTIVITY: tuple[float, ...] = (0.3, 0.006, 0.3)
BEM_CACHE_SUBDIR = "bem"
BEM_CACHE_NAME = "fsaverage-ico-4-bem-sol.fif"
# Имя обязано заканчиваться на «-trans.fif» — иначе MNE ругается на конвенцию
# имён при каждом чтении/записи.
TRANS_CACHE_NAME = "fsaverage-computed-trans.fif"

# Три поверхности, из которых MNE строит BEM-модель (``.surf`` рядом с решением).
BEM_SURFACE_NAMES: tuple[str, ...] = ("inner_skull", "outer_skull", "outer_skin")

# Допустимые значения ``bem_source``/``trans_source``.
SOURCE_PRECOMPUTED = "precomputed"   # готовый файл установки на месте
SOURCE_CACHED = "cached"             # лежит кэш расчёта в cache_dir/bem
SOURCE_COMPUTABLE = "computable"     # готового нет, исходники есть — посчитаем
SOURCE_MISSING = "missing"           # нечем считать — ошибочный статус

# Кандидаты готового BEM-решения (прежний список ``bem_path`` — не менять).
_BEM_FILE_NAMES: tuple[str, ...] = (
    "fsaverage-5120-5120-5120-bem-sol.fif",
    "fsaverage-5120-5120-5120-bem.fif",
)


def _bem_cache_path(cfg: "Settings") -> str:
    """Путь дискового кэша расчётного BEM-решения (``cache_dir/bem/…``)."""
    return os.path.join(cfg.cache_dir, BEM_CACHE_SUBDIR, BEM_CACHE_NAME)


def _trans_cache_path(cfg: "Settings") -> str:
    """Путь дискового кэша расчётного transform (``cache_dir/bem/…``)."""
    return os.path.join(cfg.cache_dir, BEM_CACHE_SUBDIR, TRANS_CACHE_NAME)


def bem_candidates(cfg: "Settings") -> list[str]:
    """Кандидаты готового BEM-решения fsaverage (порядок = приоритет).

    Пути только из настройки ``subjects_dir`` (правило AGENTS: без хардкода
    ``~/mne_data`` — ``settings`` единственный источник).
    """
    root = cfg.subjects_dir
    return [
        os.path.join(root, "fsaverage", "bem", _BEM_FILE_NAMES[0]),
        os.path.join(root, "fsaverage", "bem", _BEM_FILE_NAMES[1]),
        os.path.join(root, "bem", _BEM_FILE_NAMES[0]),
    ]


def _bem_surface_dirs(cfg: "Settings") -> list[str]:
    """Каталоги, где могут лежать исходные ``.surf``-поверхности."""
    root = cfg.subjects_dir
    return [
        os.path.join(root, "fsaverage", "bem"),
        os.path.join(root, "bem"),
    ]


def _surface_dir(cfg: "Settings") -> str | None:
    """Первый каталог со всеми тремя поверхностями или ``None``."""
    for directory in _bem_surface_dirs(cfg):
        if all(
            os.path.exists(os.path.join(directory, f"{name}.surf"))
            for name in BEM_SURFACE_NAMES
        ):
            return directory
    return None


def _trans_fallbacks() -> list[str]:
    """Запасные ``fsaverage-trans.fif``: пакет MNE (``mne/data/fsaverage``).

    Выделено в функцию, чтобы тесты подменяли список и проверяли остальные
    состояния на машинах, где пакет установлен.
    """
    return [
        os.path.join(os.path.dirname(mne.__file__), "data", "fsaverage", "fsaverage-trans.fif"),
    ]


def _fiducials_fallbacks() -> list[str]:
    """Запасные ``fsaverage-fiducials.fif``: пакет MNE (для расчёта transform)."""
    return [
        os.path.join(os.path.dirname(mne.__file__), "data", "fsaverage", "fsaverage-fiducials.fif"),
    ]


def trans_candidates(cfg: "Settings") -> list[str]:
    """Кандидаты готового transform fsaverage (порядок = приоритет)."""
    return [
        cfg.fsaverage_trans,
        os.path.join(cfg.subjects_dir, "fsaverage", "bem", "fsaverage-trans.fif"),
        os.path.join(cfg.subjects_dir, "bem", "fsaverage-trans.fif"),
        *_trans_fallbacks(),
    ]


def _fiducials_candidates(cfg: "Settings") -> list[str]:
    """Кандидаты ``fsaverage-fiducials.fif`` (для расчёта transform)."""
    return [
        os.path.join(cfg.subjects_dir, "fsaverage", "bem", "fsaverage-fiducials.fif"),
        os.path.join(cfg.subjects_dir, "bem", "fsaverage-fiducials.fif"),
        *_fiducials_fallbacks(),
    ]


def _first_existing(paths: list[str]) -> str | None:
    """Первый существующий путь из списка (иначе ``None``)."""
    for path in paths:
        if os.path.exists(path):
            return path
    return None


def _fiducials_path(cfg: "Settings") -> str | None:
    """Существующий файл фидуциалов или ``None``."""
    return _first_existing(_fiducials_candidates(cfg))


# --- Расчёт -----------------------------------------------------------------

def _compute_bem_solution(cfg: "Settings") -> str:
    """Считает BEM-решение из ``.surf`` и пишет в дисковый кэш.

    Тяжёлый шаг (замер 02.10.2026: **≈62 с** на живой установке): вызывается
    один раз — дальше путь отдаётся из кэша. Сбой (неполные поверхности) не
    маскируется: исключение уходит к вызывающему, который превращает его в
    ``FileNotFoundError`` с перечнем путей.
    """
    surface_dir = _surface_dir(cfg)
    if surface_dir is None:
        raise FileNotFoundError("нет исходных поверхностей BEM (.surf)")
    logger.info("Расчёт BEM-решения fsaverage из %s (ico=%d)", surface_dir, BEM_ICO)
    model = mne.make_bem_model(
        subject="fsaverage",
        ico=BEM_ICO,
        conductivity=BEM_CONDUCTIVITY,
        subjects_dir=cfg.subjects_dir,
        verbose=False,
    )
    solution = mne.make_bem_solution(model, verbose=False)
    path = _bem_cache_path(cfg)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Атомарная запись: параллельная задача не увидит полфайла.
    building = path + ".building"
    mne.write_bem_solution(building, solution, overwrite=True, verbose=False)
    os.replace(building, path)
    logger.info("BEM-решение записано в кэш: %s", path)
    return path


def _compute_trans(cfg: "Settings") -> str:
    """Считает transform из фидуциалов и пишет в дисковый кэш.

    ``fsaverage-fiducials.fif`` хранит LPA/nasion/RPA в кадре MRI; головной
    кадр fsaverage определяется ими же (Neuromag-соглашение):
    ``mri→head`` = ``get_ras_to_neuromag_trans(nasion, lpa, rpa)``. В файл
    кладётся обратная матрица (**head→mri**) — так устроен файл установки
    ``fsaverage-trans.fif`` (``_get_trans`` в MNE называет это «usually a
    head->MRI transform»), и кэш становится его полной заменой. Направлением
    не критично: оба потребителя (``fit_dipole``, ``head_to_mni``) нормализуют
    через ``_ensure_trans``.
    """
    from mne.io.constants import FIFF
    from mne.transforms import get_ras_to_neuromag_trans

    fid_path = _fiducials_path(cfg)
    if fid_path is None:
        raise FileNotFoundError("нет fsaverage-fiducials.fif")
    fiducials, coord_frame = mne.io.read_fiducials(fid_path, verbose=False)
    # MNE отдаёт и FIFF-константу (5 = FIFFV_COORD_MRI), и строку 'mri' —
    # сверяем по числовому значению кадра, строку принимаем наравне.
    try:
        frame_ok = int(coord_frame) == int(FIFF.FIFFV_COORD_MRI)
    except (TypeError, ValueError):
        frame_ok = str(coord_frame).lower() == "mri"
    if not frame_ok:
        raise RuntimeError(
            f"fsaverage-fiducials.fif в кадре {coord_frame!r}, ожидается MRI"
        )
    # Фидуциалы: kind у всех CARDINAL, различаются по ident (LPA/Nasion/RPA);
    # координаты — в метрах, как и весь головной кадр MNE.
    points = {
        int(p["ident"]): p["r"]
        for p in fiducials
        if int(p["kind"]) == int(FIFF.FIFFV_POINT_CARDINAL)
    }
    lpa = points.get(int(FIFF.FIFFV_POINT_LPA))
    nasion = points.get(int(FIFF.FIFFV_POINT_NASION))
    rpa = points.get(int(FIFF.FIFFV_POINT_RPA))
    if lpa is None or nasion is None or rpa is None:
        raise RuntimeError(f"в {fid_path} нет всех трёх фидуциалов (LPA/nasion/RPA)")
    logger.info("Расчёт transform fsaverage из %s", fid_path)
    mri_head = get_ras_to_neuromag_trans(nasion, lpa, rpa)  # mri → head
    trans_matrix = np.linalg.inv(mri_head)                  # head → mri, как в файле установки
    path = _trans_cache_path(cfg)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Временное имя тоже обязано кончаться на «-trans.fif» (конвенция MNE).
    building = os.path.join(os.path.dirname(path), "building-" + os.path.basename(path))
    mne.write_trans(building, mne.Transform("head", "mri", trans_matrix), overwrite=True, verbose=False)
    os.replace(building, path)
    logger.info("Transform записан в кэш: %s", path)
    return path


# --- Разрешение -------------------------------------------------------------

def bem_source(cfg: "Settings") -> str:
    """Откуда возьмётся BEM — без расчёта: precomputed | cached | computable | missing."""
    if _first_existing(bem_candidates(cfg)) is not None:
        return SOURCE_PRECOMPUTED
    if os.path.exists(_bem_cache_path(cfg)):
        return SOURCE_CACHED
    if _surface_dir(cfg) is not None:
        return SOURCE_COMPUTABLE
    return SOURCE_MISSING


def trans_source(cfg: "Settings") -> str:
    """Откуда возьмётся transform — без расчёта: precomputed | cached | computable | missing."""
    if _first_existing(trans_candidates(cfg)) is not None:
        return SOURCE_PRECOMPUTED
    if os.path.exists(_trans_cache_path(cfg)):
        return SOURCE_CACHED
    if _fiducials_path(cfg) is not None:
        return SOURCE_COMPUTABLE
    return SOURCE_MISSING


def bem_path(cfg: "Settings") -> str:
    """Путь к BEM-решению fsaverage: готовый файл → кэш → расчёт.

    ``FileNotFoundError`` — готового файла нет и считать неоткуда: текст
    сохраняет прежнее начало («BEM-решение fsaverage …») и перечисляет
    ожидаемые пути.
    """
    path = _first_existing(bem_candidates(cfg))
    if path is not None:
        return path
    cached = _bem_cache_path(cfg)
    if os.path.exists(cached):
        return cached
    try:
        return _compute_bem_solution(cfg)
    except FileNotFoundError as exc:
        raise FileNotFoundError(
            "BEM-решение fsaverage не найдено. Ожидался один из файлов: "
            + ", ".join(bem_candidates(cfg))
            + "; расчёт невозможен: "
            + str(exc)
        ) from exc


def trans_path(cfg: "Settings") -> str:
    """Путь к transform fsaverage: готовый файл → кэш → расчёт из фидуциалов.

    Путь (а не объект): ``mne.fit_dipole`` принимает только ``path-like``,
    а ``mne.read_trans`` по этому пути получает ``mne.Transform`` для
    ``head_to_mni`` (правило безопасности).
    """
    path = _first_existing(trans_candidates(cfg))
    if path is not None:
        return path
    cached = _trans_cache_path(cfg)
    if os.path.exists(cached):
        return cached
    try:
        return _compute_trans(cfg)
    except FileNotFoundError as exc:
        raise FileNotFoundError(
            "transform fsaverage не найден. Ожидался один из файлов: "
            + ", ".join(trans_candidates(cfg))
            + "; расчёт невозможен: "
            + str(exc)
        ) from exc
