"""Тесты отдачи томов fsaverage «как есть» (3.5, N33): белый список, ETag, /meta.

Быстрая часть не требует научных данных: белый словарь проверяется на
отсутствие traversal (все пути — внутри ``fsaverage/``, без ``..``), роут —
фиктивными файлами в ``tmp_path`` ( subjects_dir подменяется), ссылка в
``/meta`` — на любом окружении. Реальный ``T1.mgz`` проверяется тестами с
маркером ``integration`` (включая гард TS-таблицы ``FSAVERAGE_T1_AFFINE``).
"""
import os
from pathlib import Path

import numpy as np
import pytest

from app.core.config import settings
from app.services import asset_versions as av
from app.services import mri_volumes as mv

_PREFIX = settings.api_prefix


def test_whitelist_paths_stay_inside_fsaverage():
    """Все пути белого списка — относительные, внутри ``fsaverage/``, без ``..``.

    Это юридически-важная проверка безопасности: имя в URL сопоставляется с
    фиксированным словарём, и словарь не должен содержать выход наружу.
    """
    assert set(mv.VOLUME_FILES) == {"T1.mgz", "seghead.mgz", "lh.white", "rh.white"}
    for relative in mv.VOLUME_FILES.values():
        assert relative.startswith("fsaverage/")
        assert ".." not in relative
        assert not os.path.isabs(relative)
    # Словарь и список имён для /meta — один источник
    assert mv.volume_names() == list(mv.VOLUME_FILES)


def test_whitelist_matches_asset_stamp_files():
    """Белый список = входы ассета ``volumes``: иначе замена файла не бампит версию."""
    assert set(mv.VOLUME_FILES.values()) == set(
        av.spec("volumes").stamp_files
    ), "Добавили файл в белый список — добавьте и в MRI_VOLUMES_STAMP_RELATIVE (и наоборот)"


def test_volume_route_404_on_unknown_name(client):
    """Чужое имя — 404 до чтения файловой системы (path traversal невозможен)."""
    assert client.get(f"{_PREFIX}/surface/mri/volume/evil.mgz").status_code == 404
    # Закодированный traversal тоже не доходит до файловой системы
    response = client.get(f"{_PREFIX}/surface/mri/volume/..%2F..%2Fetc%2Fpasswd")
    assert response.status_code == 404


def test_volume_route_serves_file_with_etag_and_304(client, monkeypatch, tmp_path):
    """200 отдаёт байты файла с ETag, повтор с тем же ``If-None-Match`` — 304."""
    fake_t1 = tmp_path / "fsaverage" / "mri" / "T1.mgz"
    fake_t1.parent.mkdir(parents=True)
    fake_t1.write_bytes(b"\x1f\x8b-fake-mgz")
    monkeypatch.setattr(settings, "subjects_dir", str(tmp_path))
    mv.clear_volume_cache()

    response = client.get(f"{_PREFIX}/surface/mri/volume/T1.mgz")
    assert response.status_code == 200
    assert response.content == b"\x1f\x8b-fake-mgz"
    assert response.headers["Cache-Control"].startswith("public")
    etag = response.headers["ETag"]
    assert etag == f'"{mv.volume_version(settings)}"'

    again = client.get(
        f"{_PREFIX}/surface/mri/volume/T1.mgz", headers={"If-None-Match": etag}
    )
    assert again.status_code == 304
    assert again.content == b""


def test_volume_route_503_when_file_missing(client, monkeypatch, tmp_path):
    """Имя в списке, файла нет — 503 с текстом, а не 500."""
    monkeypatch.setattr(settings, "subjects_dir", str(tmp_path))
    mv.clear_volume_cache()
    response = client.get(f"{_PREFIX}/surface/mri/volume/T1.mgz")
    assert response.status_code == 503
    assert "fsaverage" in response.json()["detail"]


def test_meta_exposes_volumes_ref(client):
    """``/meta`` объявляет ссылку на тома: URL, имена, версия, affine (или null)."""
    body = client.get(f"{_PREFIX}/meta").json()
    volumes = body["mri_volumes"]
    assert volumes["url"] == f"{_PREFIX}/surface/mri/volume"
    assert volumes["names"] == mv.volume_names()
    assert volumes["version"] == mv.volume_version(settings)
    affine = volumes["affine"]
    assert affine is None or (
        len(affine) == 4
        and all(len(row) == 4 for row in affine)
        and affine[3] == [0.0, 0.0, 0.0, 1.0]
    )


@pytest.mark.integration
def test_real_t1_affine_is_4x4_with_rigid_last_row():
    """Реальный T1.mgz: affine 4×4, последняя строка — однородная координата."""
    pytest.importorskip("nibabel")
    if not os.path.exists(os.path.join(settings.subjects_dir, mv.VOLUME_FILES["T1.mgz"])):
        pytest.skip("нет T1.mgz (~/mne_data): интеграционный тест пропущен")
    affine = mv.t1_affine(settings)
    assert affine is not None
    assert len(affine) == 4 and all(len(row) == 4 for row in affine)
    assert affine[3] == [0.0, 0.0, 0.0, 1.0]
    # Томы fsaverage — 1 мм (диагональ ≥ 1): вырожденная матрица сломала бы
    # конвертацию мм MNI в координаты тома на клиенте.
    diagonal = [abs(affine[i][i]) for i in range(3)]
    assert max(diagonal) >= 1.0


@pytest.mark.integration
def test_real_t1_affine_matches_frontend_table():
    """TS-таблица `FSAVERAGE_T1_AFFINE` == affine реального T1.mgz (гард 3.5).

    Константа живёт в двух языках (JSON-контракт не переносит матрицу в UI
    до загрузки `/meta`), поэтому расхождение ловится чтением TS-таблицы —
    по образцу `test_geometry_matches_frontend` (иначе диполи в 3D-виде
    «уезжают» относительно проекций, а тесты зелёные).
    """
    import re

    ts_file = (
        Path(__file__).resolve().parents[2]
        / "frontend" / "src" / "shared" / "lib" / "brain3d.ts"
    )
    if not ts_file.exists():  # pragma: no cover - бэкенд без фронтенда
        pytest.skip("нет исходников фронтенда")

    if not os.path.exists(os.path.join(settings.subjects_dir, mv.VOLUME_FILES["T1.mgz"])):
        pytest.skip("нет T1.mgz (~/mne_data): интеграционный тест пропущен")

    match = re.search(
        r"FSAVERAGE_T1_AFFINE[^=]*=\s*\[(.*?)\n\]", ts_file.read_text(encoding="utf-8"), re.S
    )
    assert match, "в brain3d.ts не найдена таблица FSAVERAGE_T1_AFFINE"
    rows = [
        [float(value.strip()) for value in row.split(",")]
        for row in re.findall(r"\[([^\]]+)\]", match.group(1))
    ]
    assert len(rows) == 4 and all(len(row) == 4 for row in rows), rows

    import nibabel as nib

    affine = nib.load(os.path.join(settings.subjects_dir, mv.VOLUME_FILES["T1.mgz"])).affine
    assert np.allclose(rows, np.asarray(affine), atol=1e-6), (
        f"TS-таблица {rows} != affine T1.mgz {affine.tolist()}: обновите "
        "FSAVERAGE_T1_AFFINE в brain3d.ts (и проверьте инвариант MNI == мир тома)"
    )


@pytest.mark.integration
def test_real_volume_route_serves_seghead(client):
    """Реальный seghead.mgz отдаётся роутом (магические байты gzip mgz)."""
    if not os.path.exists(os.path.join(settings.subjects_dir, mv.VOLUME_FILES["seghead.mgz"])):
        pytest.skip("нет seghead.mgz (~/mne_data): интеграционный тест пропущен")
    response = client.get(f"{_PREFIX}/surface/mri/volume/seghead.mgz")
    assert response.status_code == 200
    assert response.content[:2] == b"\x1f\x8b"  # mgz — gzip
