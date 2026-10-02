"""Тесты fsaverage_assets: BEM/transform на живой установке (задача FreeSurfer).

Логика разрешения (готовый файл → кэш → расчёт → ошибка) покрыта быстро и
детерминированно: тяжёлые ``make_bem_model``/``write_trans`` подменяются,
пакетные fallback'и MNE выключаются — иначе тест читал бы файлы машины.
Честный расчёт на реальных данных — маркер ``integration``.
"""
from pathlib import Path

import mne
import pytest

from app.core.config import Settings
from app.services import fsaverage_assets as fa

_SOLUTION_NAME = "fsaverage-5120-5120-5120-bem-sol.fif"
_SOURCES = {
    fa.SOURCE_PRECOMPUTED,
    fa.SOURCE_CACHED,
    fa.SOURCE_COMPUTABLE,
    fa.SOURCE_MISSING,
}


def _cfg(tmp_path: Path) -> Settings:
    """Изолированный конфиг: свои subjects_dir/cache_dir, файлов нет."""
    subjects = tmp_path / "subjects"
    (subjects / "fsaverage" / "bem").mkdir(parents=True)
    cache = tmp_path / "cache"
    cache.mkdir()
    return Settings(
        subjects_dir=str(subjects),
        fsaverage_trans=str(tmp_path / "nofile" / "fsaverage-trans.fif"),
        cache_dir=str(cache),
    )


def _no_package_fallbacks(monkeypatch: pytest.MonkeyPatch) -> None:
    """Пакет MNE установлен на любой машине теста — отключаем его fallback'и."""
    monkeypatch.setattr(fa, "_trans_fallbacks", lambda: [])
    monkeypatch.setattr(fa, "_fiducials_fallbacks", lambda: [])


def _touch_surfaces(cfg: Settings) -> None:
    """Три пустых ``.surf`` — для логики достаточно существования файлов."""
    surf_dir = Path(cfg.subjects_dir) / "fsaverage" / "bem"
    for name in fa.BEM_SURFACE_NAMES:
        (surf_dir / f"{name}.surf").write_bytes(b"surf")


def _fake_compute(path_getter):
    """Фабрика подмены расчёта: пишет файл результата и себя в счётчик."""
    calls: list[Settings] = []

    def compute(cfg: Settings) -> str:
        calls.append(cfg)
        path = path_getter(cfg)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_bytes(b"computed")
        return path

    return compute, calls


# ---------- BEM ---------------------------------------------------------------

def test_bem_path_prefers_precomputed_file(tmp_path: Path) -> None:
    """Готовый файл установки важнее любого расчёта."""
    cfg = _cfg(tmp_path)
    candidate = Path(cfg.subjects_dir) / "fsaverage" / "bem" / _SOLUTION_NAME
    candidate.write_bytes(b"fiff")

    assert fa.bem_path(cfg) == str(candidate)
    assert fa.bem_source(cfg) == fa.SOURCE_PRECOMPUTED


def test_bem_computes_once_then_serves_from_cache(tmp_path, monkeypatch) -> None:
    """Нет готового файла, но есть .surf — расчёт один раз, дальше кэш."""
    cfg = _cfg(tmp_path)
    _touch_surfaces(cfg)
    assert fa.bem_source(cfg) == fa.SOURCE_COMPUTABLE

    compute, calls = _fake_compute(fa._bem_cache_path)
    monkeypatch.setattr(fa, "_compute_bem_solution", compute)

    first = fa.bem_path(cfg)
    assert first == fa._bem_cache_path(cfg)
    assert Path(first).exists()
    assert len(calls) == 1, "первый вызов — ровно один расчёт"

    assert fa.bem_path(cfg) == first
    assert len(calls) == 1, "повторный вызов идёт в кэш, не в расчёт"
    assert fa.bem_source(cfg) == fa.SOURCE_CACHED


def test_bem_path_missing_everything_raises(tmp_path: Path) -> None:
    """Ни файла, ни поверхностей — ошибка с прежним началом и путями."""
    cfg = _cfg(tmp_path)
    assert fa.bem_source(cfg) == fa.SOURCE_MISSING

    with pytest.raises(FileNotFoundError, match="BEM-решение fsaverage") as exc:
        fa.bem_path(cfg)
    assert fa.bem_candidates(cfg)[0] in str(exc.value)


# ---------- transform ---------------------------------------------------------

def test_trans_path_prefers_precomputed_file(tmp_path: Path, monkeypatch) -> None:
    """Готовый ``fsaverage-trans.fif`` из конфигурации — первый кандидат."""
    _no_package_fallbacks(monkeypatch)
    cfg = _cfg(tmp_path)
    configured = Path(cfg.fsaverage_trans)
    configured.parent.mkdir(parents=True)
    configured.write_bytes(b"fiff")

    assert fa.trans_path(cfg) == str(configured)
    assert fa.trans_source(cfg) == fa.SOURCE_PRECOMPUTED


def test_trans_computes_once_then_serves_from_cache(tmp_path, monkeypatch) -> None:
    """Нет transform, но есть фидуциалы — расчёт один раз, дальше кэш."""
    _no_package_fallbacks(monkeypatch)
    cfg = _cfg(tmp_path)
    fiducials = Path(cfg.subjects_dir) / "fsaverage" / "bem" / "fsaverage-fiducials.fif"
    fiducials.write_bytes(b"fiff")
    assert fa.trans_source(cfg) == fa.SOURCE_COMPUTABLE

    compute, calls = _fake_compute(fa._trans_cache_path)
    monkeypatch.setattr(fa, "_compute_trans", compute)

    first = fa.trans_path(cfg)
    assert first == fa._trans_cache_path(cfg)
    assert len(calls) == 1

    assert fa.trans_path(cfg) == first
    assert len(calls) == 1, "повторный вызов идёт в кэш, не в расчёт"
    assert fa.trans_source(cfg) == fa.SOURCE_CACHED


def test_trans_path_missing_everything_raises(tmp_path: Path, monkeypatch) -> None:
    """Ни файла, ни фидуциалов — понятная ошибка, а не молчаливый мусор."""
    _no_package_fallbacks(monkeypatch)
    cfg = _cfg(tmp_path)
    assert fa.trans_source(cfg) == fa.SOURCE_MISSING

    with pytest.raises(FileNotFoundError, match="transform fsaverage") as exc:
        fa.trans_path(cfg)
    assert fa.trans_candidates(cfg)[0] in str(exc.value)


def test_compute_trans_builds_valid_transform(tmp_path: Path) -> None:
    """Расчёт из фидуциалов пакета MNE даёт читаемый ``mne.Transform``.

    Направление **head→mri** — как у файла установки ``fsaverage-trans.fif``.
    Пакет MNE всегда содержит ``fsaverage-fiducials.fif`` (на нём же держится
    ``mne.coreg.get_mni_fiducials``), поэтому тест работает и в CI.
    """
    from mne.io.constants import FIFF

    cfg = _cfg(tmp_path)
    path = fa._compute_trans(cfg)
    assert path == fa._trans_cache_path(cfg)
    assert path.endswith("-trans.fif"), "имя файла обязано следовать конвенции MNE"

    trans = mne.read_trans(path, verbose=False)
    assert int(trans["from"]) == int(FIFF.FIFFV_COORD_HEAD)
    assert int(trans["to"]) == int(FIFF.FIFFV_COORD_MRI)
    assert trans["trans"].shape == (4, 4)


# ---------- контракты API -----------------------------------------------------

def test_init_status_exposes_sources(client) -> None:
    """/init-status: источники BEM/transform видны без расчёта."""
    body = client.get("/init-status").json()
    assert set(body["sources"]) == {"bem", "transform"}
    assert set(body["sources"].values()) <= _SOURCES
    # Готовность следует за источником (missing — единственный «error»)
    for key in ("bem", "transform"):
        expected = "error" if body["sources"][key] == fa.SOURCE_MISSING else "ready"
        assert body["checks"][key] == expected


def test_meta_exposes_sources(client) -> None:
    """/meta: ``bem_source``/``trans_source`` в контракте (наблюдаемость FreeSurfer)."""
    from app.core.config import settings as app_settings

    body = client.get(f"{app_settings.api_prefix}/meta").json()
    assert body["bem_source"] in _SOURCES
    assert body["trans_source"] in _SOURCES


# ---------- честный расчёт на реальных данных (integration) -------------------

@pytest.mark.integration
def test_bem_computes_on_real_dataset(tmp_path: Path) -> None:
    """Расчёт BEM из реальных .surf даёт читаемое трёхслойное решение."""
    from app.core.config import settings as app_settings

    cfg = Settings(
        subjects_dir=app_settings.subjects_dir,
        cache_dir=str(tmp_path),
        fsaverage_trans=app_settings.fsaverage_trans,
    )
    path = fa._compute_bem_solution(cfg)
    solution = mne.read_bem_solution(path, verbose=False)
    assert len(solution["surfs"]) == 3, "BEM — ровно три поверхности"


@pytest.mark.integration
def test_computed_trans_matches_shipped(tmp_path: Path) -> None:
    """Расчёт transform из фидуциалов совпадает с готовым файлом установки."""
    from app.core.config import settings as app_settings

    cfg = Settings(
        subjects_dir=app_settings.subjects_dir,
        cache_dir=str(tmp_path),
        fsaverage_trans=app_settings.fsaverage_trans,
    )
    shipped = fa._first_existing(fa.trans_candidates(cfg))
    assert shipped is not None, "на установке есть готовый fsaverage-trans.fif"
    computed_path = fa._compute_trans(cfg)

    # Оба файла хранят head→mri — сравниваем напрямую; расхождение только
    # плавающая точка FIF (замер 02.10.2026: 3.2e-07).
    shipped_matrix = mne.read_trans(shipped, verbose=False)["trans"]
    computed_matrix = mne.read_trans(computed_path, verbose=False)["trans"]
    assert (abs(shipped_matrix - computed_matrix) < 1e-6).all(), (
        "расчёт по фидуциалам обязан воспроизводить transform установки"
    )
