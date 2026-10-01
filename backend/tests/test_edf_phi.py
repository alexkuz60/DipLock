"""PHI-анонимизация заголовка EDF (4.4, шаг ①; ``services/edf_phi.py``).

Проверяем три инварианта: (1) оба PHI-поля заменяются псевдонимом, исходные
значения не остаются; (2) файл после патча остаётся читаемым EDF; (3) дайджест
псевдонима детерминирован от sha256 исходника.
"""
import mne
import pytest

from app.services import edf_phi


def _header_fields(path) -> tuple[str, str]:
    """Сырые поля заголовка (обрезаны по null/пробелам для сравнений)."""
    patient, recording = edf_phi.read_header_fields(str(path))
    return patient.strip(), recording.strip()


def test_read_header_fields_returns_fixture_values(edf_file):
    """Синтетический EDF из conftest несёт свои поля — до анонимизации."""
    patient, recording = _header_fields(edf_file)
    assert patient.startswith("Synthetic DipLock")
    assert recording.startswith("Test recording")


def test_anonymize_replaces_phi_and_keeps_alias(edf_file):
    """Пациент и «техник» исчезают, псевдоним занимает их место."""
    alias = edf_phi.patient_alias("ab" * 32)
    assert alias == "Patient-ababab"

    edf_phi.anonymize_edf_header(str(edf_file), alias)

    patient, recording = _header_fields(edf_file)
    assert "Synthetic DipLock" not in patient
    assert "Test recording" not in recording
    assert alias in patient
    assert alias in recording


def test_anonymized_file_still_readable(edf_file):
    """Патч 160 байт не ломает разбор: MNE читает те же каналы и sfreq."""
    edf_phi.anonymize_edf_header(str(edf_file), "Patient-000001")
    raw = mne.io.read_raw_edf(str(edf_file), preload=False, verbose=False)
    assert raw.n_times > 0
    assert float(raw.info["sfreq"]) == 250.0


def test_recording_field_keeps_startdate_but_drops_person(tmp_path):
    """«Startdate …» — не PHI и остаётся; админ-id/техник — под псевдонимом."""
    payload = bytearray(200)
    payload[8:88] = b"PAT-1 F 01-JAN-1970 Anna Larsson".ljust(80)
    payload[88:168] = b"Startdate 02-MAR-24 EXP42 BrainAmp Dr-Ivanov".ljust(80)
    path = tmp_path / "header.edf"
    path.write_bytes(bytes(payload))

    edf_phi.anonymize_edf_header(str(path), "Patient-cafe01")

    patient, recording = edf_phi.read_header_fields(str(path))
    assert "Anna Larsson" not in patient and "PAT-1" not in patient
    assert "Dr-Ivanov" not in recording and "EXP42" not in recording
    assert recording.strip() == "Startdate 02-MAR-24 Patient-cafe01"
    assert patient.strip().startswith("Patient-cafe01")


def test_short_file_raises_value_error(tmp_path):
    """Файл меньше заголовка — ValueError (регистрация падает, копия удаляется)."""
    path = tmp_path / "tiny.edf"
    path.write_bytes(b"not an edf")
    with pytest.raises(ValueError, match="меньше заголовка"):
        edf_phi.anonymize_edf_header(str(path), "Patient-000000")


def test_alias_is_deterministic_and_safe():
    """Один файл — один псевдоним; без дайджеста — одноразовый токен."""
    digest = "f" * 64
    assert edf_phi.patient_alias(digest) == edf_phi.patient_alias(digest)
    assert edf_phi.patient_alias(digest) == "Patient-ffffff"
    random_alias = edf_phi.patient_alias(None)
    assert random_alias.startswith("Patient-")
    # EDF кодируется ISO 8859-1 — псевдоним обязан латиницей
    random_alias.encode("latin-1")
