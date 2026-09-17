"""Тесты единого отпечатка версий ассетов (A7, этап 6).

Смысл этих тестов — «забыли поднять версию». Дисковые кэши ассетов адресуются
отпечатком: если входы сборки изменились, а версия нет, на диске и в браузере
останутся старые ассеты, и это не видно глазами. Поэтому:

* ``test_snapshot_of_asset_inputs`` — снапшот всех входов: любое изменение
  параметров/файлов/версии падает здесь, а сообщение говорит, что делать;
* ``test_*`` ниже — что отпечаток вообще чувствителен к каждому виду входа
  (версия, параметры, файлы данных) и что все три сервиса считают его **одной**
  функцией, а не своей копией.
"""
import os

import pytest

from app.services import asset_versions as av
from app.services import atlas_contours as ac
from app.services import mri_slices as ms
from app.services import surface_cache as sc

# Снапшот входов ассетов. Меняете значения — поднимайте ``version`` своего
# ассета в ``app/services/asset_versions.py`` И обновляйте снапшот: иначе кэши
# на диске останутся от прежней сборки.
INPUTS_SNAPSHOT = {
    "surface": {
        "version": 1,
        "params": {
            "subject": "fsaverage",
            "mesh": "inflated",
            "hemispheres": ["lh", "rh"],
            "atlas": "PALS_B12_Brodmann",
        },
        "stamp_files": (
            "fsaverage/surf/lh.inflated",
            "fsaverage/surf/rh.inflated",
            "fsaverage/label/lh.PALS_B12_Brodmann.annot",
            "fsaverage/label/rh.PALS_B12_Brodmann.annot",
        ),
    },
    "mri": {
        "version": 2,
        "params": {
            "subject": "fsaverage",
            "source": "T1.mgz + brainmask.mgz",
            "grid": "mni",
            "spacing_mm": 1.0,
            "bounds": {"x": [-80.0, 80.0], "y": [-116.0, 80.0], "z": [-82.0, 90.0]},
            "window_percentiles": [1.0, 99.0],
        },
        "stamp_files": ("fsaverage/mri/T1.mgz", "fsaverage/mri/brainmask.mgz"),
    },
    "contours": {
        "version": 2,
        "params": {
            "subject": "fsaverage",
            "source": "aparc+aseg.mgz + ribbon.mgz",
            "spacing_mm": 1.0,
            "simplify_mm": 0.6,
            "min_area_mm2": 25.0,
            "brodmann_method": "nearest_cortex_vertex",
            "area_id_offset": {"lh": 0, "rh": 10000},
        },
        "stamp_files": (
            "fsaverage/mri/aparc+aseg.mgz",
            "fsaverage/mri/lh.ribbon.mgz",
            "fsaverage/mri/rh.ribbon.mgz",
            "fsaverage/label/lh.PALS_B12_Brodmann.annot",
            "fsaverage/label/rh.PALS_B12_Brodmann.annot",
            "fsaverage/surf/lh.white",
            "fsaverage/surf/rh.white",
        ),
    },
}


def test_snapshot_of_asset_inputs():
    """Входы ассетов совпадают со снапшотом: изменили — поднимите версию."""
    assert set(av.ASSET_SPECS) == set(INPUTS_SNAPSHOT), (
        "Состав ассетов изменился. Добавляя ассет — заведите ему версию в "
        "asset_versions.py и строку в INPUTS_SNAPSHOT (см. docs/rules/data-and-caches.md)."
    )
    for kind, expected in INPUTS_SNAPSHOT.items():
        spec = av.spec(kind)
        assert spec.version == expected["version"], (
            f"Изменилась версия сборки ассета {kind!r} без правки снапшота: "
            "поднимайте версию осознанно (старые файлы кэша станут неактуальны)."
        )
        assert spec.params == expected["params"], (
            f"Изменились параметры ассета {kind!r} ({spec.params!r}): поднимите "
            "version в asset_versions.py и обновите INPUTS_SNAPSHOT — иначе на диске "
            "останется артефакт прежней сборки."
        )
        assert spec.stamp_files == expected["stamp_files"], (
            f"Изменился список файлов данных ассета {kind!r}: поднимите version и "
            "обновите INPUTS_SNAPSHOT."
        )


def test_fingerprint_is_short_hex():
    """Отпечаток — 16 hex-символов: он уходит и в ETag, и в имя файла кэша."""
    tag = av.fingerprint("mri", "/нет-такого-каталога")
    assert len(tag) == av.TAG_LENGTH
    assert all(char in "0123456789abcdef" for char in tag)


def test_fingerprint_sensitive_to_version():
    """Подъём версии меняет отпечаток: старый кэш перестаёт подходить."""
    base = av.spec("mri")
    bumped = av.AssetSpec(
        kind=base.kind, title=base.title, version=base.version + 1,
        params=base.params, stamp_files=base.stamp_files,
    )
    assert av.fingerprint_of(bumped, "/subjects") != av.fingerprint_of(base, "/subjects")


def test_fingerprint_sensitive_to_params():
    """Правка параметров сборки меняет отпечаток (границы сетки входили не всегда)."""
    base = av.spec("mri")
    assert base.params["bounds"]["x"] == [-80.0, 80.0]
    moved = {**base.params, "bounds": {**base.params["bounds"], "x": [-79.0, 80.0]}}
    changed = av.AssetSpec(
        kind=base.kind, title=base.title, version=base.version,
        params=moved, stamp_files=base.stamp_files,
    )
    assert av.fingerprint_of(changed, "/subjects") != av.fingerprint_of(base, "/subjects")


def test_fingerprint_tracks_data_files(tmp_path):
    """Файлы данных входят в отпечаток: заменили атлас — версия поднялась сама."""
    subjects = tmp_path / "subjects"
    for relative in av.SURFACE_STAMP_RELATIVE:
        path = subjects / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"mesh")

    before = av.fingerprint("surface", str(subjects))
    annot = subjects / av.SURFACE_STAMP_RELATIVE[2]
    os.utime(annot, (1700000000.0, 1700000000.0))
    assert av.fingerprint("surface", str(subjects)) != before

    # Пропавший файл — тоже смена входов (сборка без него даст другой артефакт).
    annot.unlink()
    assert av.fingerprint("surface", str(subjects)) != before
    assert av.file_stamp(str(subjects), av.SURFACE_STAMP_RELATIVE[2]).endswith(":missing")


def test_services_use_unified_fingerprint(tmp_path):
    """Три сервиса считают версию одной функцией, а не своими копиями."""
    subjects = str(tmp_path / "subjects")
    prefix = "/api/v1"

    assert sc.surface_version(sc._AssetCtx(subjects, str(tmp_path), prefix)) == (
        av.fingerprint("surface", subjects)
    )
    assert ms.mri_version(ms._MriCtx(subjects, str(tmp_path), prefix)) == (
        av.fingerprint("mri", subjects)
    )
    assert ac.contour_version(ac._ContourCtx(subjects, str(tmp_path), prefix)) == (
        av.fingerprint("contours", subjects)
    )


def test_asset_kinds_have_distinct_fingerprints():
    """Ассеты не делят один отпечаток: иначе кэши разных артефактов совпали бы."""
    tags = av.asset_versions("/subjects")
    assert set(tags) == set(av.ASSET_KINDS)
    assert len(set(tags.values())) == len(tags)


def test_unknown_asset_kind_is_error():
    """Опечатка в имени ассета видна сразу, а не как «пустой» кэш."""
    with pytest.raises(KeyError):
        av.fingerprint("surface_v2", "/subjects")
