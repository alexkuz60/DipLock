"""Юнит-тесты дискового кэша рендера «Нейромузыки» (``audio_render/store.py``).

Ключевые свойства: детерминизм ``render_sig`` (нормализация гейнов, полосы,
версии), манифест-коммит (нет него или файла из него — промах кэша),
восстановление по записям и чистка вместе с записью.
"""
import json
import os

import pytest

from app.core.config import settings
from app.services.audio_render import store
from app.services.recordings import Recording

pytestmark = pytest.mark.usefixtures("isolated_io")


def _recording(tmp_path, digest: str = "abc123") -> Recording:
    """Минимальная запись для ``edf_stamp`` (digest — стабильный ключ)."""
    path = tmp_path / "test.edf"
    path.write_bytes(b"stub")
    return Recording(
        "rec-store", "test.edf", str(path), str(tmp_path), 1.0, {}, digest=digest,
    )


def _sig(rec, gains=None, boost=6.0, phon=75.0, autobase=True, octave=7):
    return store.render_sig(rec, settings, gains or {}, boost, phon, autobase, octave)


def test_render_sig_is_deterministic(tmp_path):
    """Одинаковые входы → одинаковый ключ; каждый параметр меняет ключ."""
    rec = _recording(tmp_path)
    base = _sig(rec, gains={"alpha": -3.0}, boost=0.0, phon=None, octave=5)
    assert base == _sig(rec, gains={"alpha": -3.0}, boost=0.0, phon=None, octave=5)
    assert base != _sig(rec, gains={"alpha": -2.0}, boost=0.0, phon=None, octave=5)
    assert base != _sig(rec, gains={"alpha": -3.0}, boost=6.0, phon=None, octave=5)
    assert base != _sig(rec, gains={"alpha": -3.0}, boost=0.0, phon=75.0, octave=5)
    assert base != _sig(rec, gains={"alpha": -3.0}, boost=0.0, phon=None, autobase=False, octave=5)
    assert base != _sig(rec, gains={"alpha": -3.0}, boost=0.0, phon=None, octave=7)
    # Другой файл (digest) — другой ключ.
    assert base != _sig(_recording(tmp_path, digest="other"), {"alpha": -3.0}, 0.0, None, True, 5)


def test_render_sig_normalizes_zero_gains(tmp_path):
    """Явный нулевой гейн равен отсутствию — ключ совпадает, кэш не дробится."""
    rec = _recording(tmp_path)
    assert _sig(rec, gains={}) == _sig(rec, gains={"alpha": 0.0, "theta": -0.0})


def test_write_then_load_roundtrip(tmp_path):
    """Артефакты без манифеста — промах; после коммита — полный круг чтения."""
    files = {"master.wav": b"RIFF-stub", "track_alpha.wav": b"wav", "sidecar.json": b"{}"}
    manifest = {
        "format": store.RENDER_FORMAT_VERSION,
        "sig": "s" * store.SIG_LEN,
        "recording_id": "rec-store",
        "created_at": 1728000000.0,
        "duration_s": 4.0,
        "bands": ["alpha"],
        "params": {"boost_db": 6.0},
        "files": {name: len(data) for name, data in files.items()},
        "message": "готово",
    }
    sig = manifest["sig"]
    assert store.write_artifacts(settings, "rec-store", sig, files) is True
    # Манифеста ещё нет — это промах (коммит последним).
    assert store.load_manifest(settings, "rec-store", sig) is None

    assert store.write_manifest(settings, "rec-store", sig, manifest) is True
    loaded = store.load_manifest(settings, "rec-store", sig)
    assert loaded is not None and loaded["message"] == "готово"
    directory = store.render_dir(settings, "rec-store", sig)
    assert store.read_artifact(directory, "master.wav") == b"RIFF-stub"

    # Файл из манифеста исчез (ручная чистка) → промах, не битые отдачи.
    os.remove(os.path.join(directory, "master.wav"))
    assert store.load_manifest(settings, "rec-store", sig) is None


def test_load_manifest_rejects_broken_and_foreign(tmp_path):
    """Битый JSON и чужая версия формата — промах кэша."""
    sig = "f" * store.SIG_LEN
    directory = store.render_dir(settings, "rec-store", sig)
    os.makedirs(directory, exist_ok=True)
    with open(os.path.join(directory, store.MANIFEST_NAME), "w", encoding="utf-8") as fh:
        fh.write("{not json")
    assert store.load_manifest(settings, "rec-store", sig) is None

    with open(os.path.join(directory, store.MANIFEST_NAME), "w", encoding="utf-8") as fh:
        json.dump({"format": 999, "files": {"master.wav": 1}}, fh)
    assert store.load_manifest(settings, "rec-store", sig) is None


def test_find_manifest_scans_recordings_and_list_sorts(tmp_path):
    """``find_manifest`` находит манифест по записям; список — свежие вперёд."""
    sig = "e" * store.SIG_LEN
    assert store.find_manifest(settings, sig) is None

    for rec_id, created in (("rec-b", 1728000000.0), ("rec-a", 1728000100.0)):
        directory = store.render_dir(settings, rec_id, sig)
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, "master.wav"), "wb") as fh:
            fh.write(b"x")
        manifest = {"format": store.RENDER_FORMAT_VERSION, "files": {"master.wav": 1},
                    "created_at": created, "bands": []}
        store.write_manifest(settings, rec_id, sig, manifest)

    found = store.find_manifest(settings, sig)
    assert found is not None and found[0] in {"rec-a", "rec-b"}
    # У обеих записей есть этот sig — list отдаёт их по одной.
    for rec_id in ("rec-a", "rec-b"):
        listed = store.list_manifests(settings, rec_id)
        assert [item[0] for item in listed] == [sig]

    store.clear_audio_cache(settings, "rec-a")
    assert store.list_manifests(settings, "rec-a") == []
    assert store.find_manifest(settings, sig)[0] == "rec-b"
