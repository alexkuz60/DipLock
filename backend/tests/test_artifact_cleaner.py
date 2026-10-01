"""Очистка сигнала MNE-only (этап 4): гармоники notch, bad-каналы, ICA, SSP."""
import mne
import numpy as np
import pytest

from app.core.config import settings
from app.services.artifact_cleaner import (
    CLEAN_METHODS,
    CleanSpec,
    apply_cleaning,
    find_eog_component_inds,
    fit_ica,
)

_CHANNELS = ["Fp1", "Fp2", "C3", "C4", "T7", "T8", "P3", "P4"]
_SFREQ = 500.0


def _raw(duration_sec: float = 30.0, seed: int = 0) -> mne.io.RawArray:
    rng = np.random.default_rng(seed)
    data = rng.standard_normal((len(_CHANNELS), int(_SFREQ * duration_sec))) * 2e-6
    raw = mne.io.RawArray(data, mne.create_info(_CHANNELS, _SFREQ, "eeg"), verbose=False)
    raw.set_montage("standard_1020", verbose=False)
    return raw


def _mimic_raw(duration_sec: float = 20.0, seed: int = 0) -> mne.io.RawArray:
    """Шум + «моргания»: синфазные экспоненциальные всплески на Fp1/Fp2 (N8).

    Стандартная синтетика ICA-тестов: чистый мимик сильно коррелирует
    с фронтальным прокси, а фон не содержит других артефактов.
    """
    rng = np.random.default_rng(seed)
    n = int(_SFREQ * duration_sec)
    data = rng.standard_normal((len(_CHANNELS), n)) * 2e-6
    mimic = np.zeros(n)
    for t in range(1, 10):
        onset = int(t * 2.0 * _SFREQ)
        burst = 80e-6 * np.exp(-np.arange(int(0.3 * _SFREQ)) / (0.05 * _SFREQ))
        mimic[onset: onset + burst.size] += burst
    data[0] += mimic
    data[1] += mimic
    raw = mne.io.RawArray(data, mne.create_info(_CHANNELS, _SFREQ, "eeg"), verbose=False)
    raw.set_montage("standard_1020", verbose=False)
    return raw


def test_clean_spec_label_mentions_steps():
    """Метка спец-ключа читается в журнале: что именно применили."""
    spec = CleanSpec(
        notch_harmonics=2, bad_channels=("C3",), interpolate_bads=True, method="ica",
    )
    label = spec.label()
    assert "гармоник" in label and "C3" in label and "интерполяция" in label and "ica" in label
    assert CleanSpec().label() == "без очистки"
    assert set(CLEAN_METHODS) == {"none", "ica", "ssp"}


def test_interpolate_bads_replaces_channel_and_reports():
    """Bad-канал интерполируется и попадает в отчёт; чужие имена — в предупреждение."""
    rng = np.random.default_rng(4)
    n = int(_SFREQ * 30.0)
    data = rng.standard_normal((len(_CHANNELS), n)) * 2e-6
    data[2] = 200e-6 * np.sin(2 * np.pi * 8 * np.arange(n) / _SFREQ)  # C3 «испорчен»
    raw = mne.io.RawArray(data, mne.create_info(_CHANNELS, _SFREQ, "eeg"), verbose=False)
    raw.set_montage("standard_1020", verbose=False)

    report = apply_cleaning(
        raw, CleanSpec(bad_channels=("C3", "XYZ"), interpolate_bads=True), settings,
    )

    assert report.interpolated_channels == ["C3"]
    assert any("XYZ" in warning for warning in report.warnings)
    assert report.amplitude_p95_uv_after <= report.amplitude_p95_uv_before


def test_apply_cleaning_keeps_loader_bads():
    """Пометка bads формы не затирает bads загрузки (мёртвые до референса, 2.2)."""
    raw = _raw()
    raw.info["bads"] = ["C4"]  # мёртвый электрод, помеченный `load_edf`

    apply_cleaning(raw, CleanSpec(bad_channels=("C3",), interpolate_bads=False), settings)

    assert set(raw.info["bads"]) == {"C3", "C4"}


def test_notch_harmonics_counted_in_report():
    """Гармоники notch (100/150/200 Гц для 50 Гц) считаются в отчёте."""
    report = apply_cleaning(
        _raw(), CleanSpec(notch_harmonics=3), settings, notch_hz=50.0,
    )
    assert report.notch_harmonics == 3


def test_ica_clean_reports_removed_components():
    """ICA-очистка находит мимическую компоненту (N8): удалено ≥ 1, отчёт чистый.

    До шага 2.1 тест был «врущим»: fit падал (не было sklearn), ноль удалённых
    сравнивался с нулём списком — тест оставался зелёным при мёртвой ветке.
    """
    report = apply_cleaning(_mimic_raw(), CleanSpec(method="ica", ica_n_components=6), settings)

    assert report.method == "ica"
    assert report.n_components_removed >= 1
    assert report.n_components_removed == len(report.removed_components)
    assert not report.warnings
    assert report.amplitude_p95_uv_before is not None
    assert report.amplitude_p95_uv_after is not None


def test_fit_ica_uses_hp_copy_and_keeps_raw_intact():
    """Фит ICA идёт на high-pass-копии: исходный raw не фильтруется (N8)."""
    raw = _mimic_raw()

    ica = fit_ica(raw, 4)

    assert ica.n_components == 4
    assert raw.info["highpass"] == 0.0


def test_find_eog_component_inds_falls_back_to_frontal_proxy():
    """Без EOG-каналов мимику находит фронтальный прокси Fp1/Fp2 (N8)."""
    raw = _mimic_raw()
    ica = fit_ica(raw, 6)

    inds, source = find_eog_component_inds(ica, raw)

    assert source == "proxy"
    assert len(inds) >= 1


def test_find_eog_component_inds_without_eog_or_proxy_raises():
    """Ни EOG-каналов, ни фронтальных — честное RuntimeError, а не падение (N8)."""
    rng = np.random.default_rng(1)
    data = rng.standard_normal((4, int(_SFREQ * 10.0))) * 2e-6
    raw = mne.io.RawArray(
        data, mne.create_info(["C3", "C4", "P3", "P4"], _SFREQ, "eeg"), verbose=False,
    )
    ica = fit_ica(raw, 3)

    with pytest.raises(RuntimeError, match="прокси"):
        find_eog_component_inds(ica, raw)


def test_ssp_clean_is_reported():
    """SSP: проекторы применяются и считаются (или честное предупреждение)."""
    report = apply_cleaning(_raw(), CleanSpec(method="ssp"), settings)

    assert report.n_projectors >= 0
    assert report.n_projectors > 0 or report.warnings


def test_iclabel_second_opinion_real_model():
    """Вторая разметка ICLabel: метки/вероятности advisory, контракт чистый (01.10.2026).

    Модель настоящая (веса вшиты в пакет, сеть не нужна): на мимике (синфазные
    «моргания» на Fp1/Fp2) она обязана найти артефактную компоненту — иначе
    второе мнение ничего не стоит.
    """
    report = apply_cleaning(_mimic_raw(), CleanSpec(method="ica"), settings)

    labels = report.iclabel_labels
    probabilities = report.iclabel_probabilities
    assert labels is not None and probabilities is not None
    assert len(labels) == len(probabilities) == len(set(range(len(labels))))
    known = {
        "brain", "muscle artifact", "eye blink", "heart beat",
        "line noise", "channel noise", "other",
    }
    assert set(labels) <= known
    assert all(0.0 <= probability <= 1.0 for probability in probabilities)
    assert all(0 <= index < len(labels) for index in report.iclabel_recommended)
    # Мимик видят оба метода: ICLabel рекомендует снять моргающую компоненту
    assert report.iclabel_recommended
    # Контракт: отчёт целиком валидируется схемой OpenAPI
    from app.schemas.analysis import CleanReportOut

    out = CleanReportOut(**report.as_dict())
    assert out.iclabel_labels is not None


def test_iclabel_failure_is_warning_and_recommendation_is_advisory(monkeypatch):
    """Сбой модели — предупреждение (чистка живёт); рекомендация не меняет решение."""
    import app.services.artifact_cleaner as cleaner

    baseline = apply_cleaning(_mimic_raw(), CleanSpec(method="ica"), settings)

    # 1) Сбой ICLabel: чистка отработала, причина — в warnings отчёта
    def _boom(raw, ica):
        raise RuntimeError("нет onnxruntime")

    monkeypatch.setattr(cleaner, "iclabel_second_opinion", _boom)
    failed = apply_cleaning(_mimic_raw(), CleanSpec(method="ica"), settings)
    assert failed.iclabel_labels is None
    assert failed.iclabel_recommended == []
    assert any("ICLabel" in text and "нет onnxruntime" in text for text in failed.warnings)
    # наше решение не пострадало: удалено ровно то же, что без модели
    assert list(failed.removed_components) == list(baseline.removed_components)

    # 2) Рекомендация advisory: «модель хочет удалить #0» не трогает ica.apply
    def _opinion(raw, ica):
        n_components = int(ica.n_components_)
        return {
            "labels": ["other"] * n_components,
            "probabilities": [0.9] * n_components,
            "recommended": [0],
        }

    monkeypatch.setattr(cleaner, "iclabel_second_opinion", _opinion)
    advised = apply_cleaning(_mimic_raw(), CleanSpec(method="ica"), settings)
    assert advised.iclabel_recommended == [0]
    assert list(advised.removed_components) == list(baseline.removed_components)
    assert advised.n_components_removed == baseline.n_components_removed