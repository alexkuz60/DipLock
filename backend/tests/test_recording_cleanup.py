"""Тесты скрипта чистки каталога записей: дедуп копий и сайдкары.

Скрипт разовый (запускается вручную), но его арифметика — «один каталог на
отпечаток» и «корневые файлы не трогаем» — обязана быть под тестом: ошибка здесь
удаляет файлы пользователя, а не портит картинку.
"""
import os
import shutil

from app.services.recordings import SIDECAR_NAME, file_digest, read_sidecar
from scripts.dedupe_recordings import main, plan_cleanup, scan_records


def _make_record(root, name: str, edf_file, mtime: float = None):
    """Каталог записи с копией тестового EDF (старое время — по желанию)."""
    upload_dir = root / name
    upload_dir.mkdir()
    shutil.copy(edf_file, upload_dir / "probe.edf")
    if mtime is not None:
        os.utime(upload_dir, (mtime, mtime))
    return upload_dir


def test_scan_and_plan_keep_one_copy_per_digest(tmp_path, edf_file):
    root = tmp_path / "edf"
    root.mkdir()
    _make_record(root, "aaa", edf_file, mtime=1700000000.0)
    _make_record(root, "bbb", edf_file, mtime=1800000000.0)

    records = scan_records(str(root))

    assert len(records) == 2
    assert {record.digest for record in records} == {file_digest(str(root / "aaa" / "probe.edf"))}

    kept, removed = plan_cleanup(records, keep="newest")
    assert [os.path.basename(record.upload_dir) for record in removed] == ["aaa"]
    assert os.path.basename(kept[0].upload_dir) == "bbb"


def test_cleanup_dry_run_changes_nothing(tmp_path, edf_file, capsys):
    root = tmp_path / "edf"
    root.mkdir()
    first = _make_record(root, "aaa", edf_file)
    second = _make_record(root, "bbb", edf_file)

    assert main(["--upload-dir", str(root)]) == 0

    assert "План." in capsys.readouterr().out
    assert first.is_dir() and second.is_dir()
    assert not os.path.exists(first / SIDECAR_NAME)
    assert not os.path.exists(second / SIDECAR_NAME)


def test_cleanup_apply_removes_copies_and_writes_sidecars(tmp_path, edf_file, capsys):
    root = tmp_path / "edf"
    root.mkdir()
    shutil.copy(edf_file, root / "test.edf")  # корневой файл репозитория
    old = _make_record(root, "aaa", edf_file, mtime=1700000000.0)
    new = _make_record(root, "bbb", edf_file, mtime=1800000000.0)

    assert main(["--upload-dir", str(root), "--apply"]) == 0

    assert "Удалено каталогов: 1" in capsys.readouterr().out
    assert not old.exists()
    assert new.is_dir()
    assert (root / "test.edf").exists()  # файл-исходник не тронут

    payload = read_sidecar(str(new))
    assert payload is not None
    assert payload["digest"] == file_digest(str(new / "probe.edf"))
    assert payload["meta"]["sfreq"] == 250.0


def test_scan_skips_dir_without_edf(tmp_path, edf_file):
    root = tmp_path / "edf"
    root.mkdir()
    (root / "empty-dir").mkdir()
    _make_record(root, "aaa", edf_file)

    records = scan_records(str(root))

    assert [os.path.basename(record.upload_dir) for record in records] == ["aaa"]
