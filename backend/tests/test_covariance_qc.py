"""QC-слой ковариации: числа λ/% дисперсии, картинки «до/после», отказы (п.6).

Проверяется то, на что опирается UI и отчёт стадии: PCA находит общую
фронтальную компоненту («моргание») и отбрасывает шумовой хвост, картинки —
валидные PNG base64-строками, отсутствие позиций монтажа и сбой рендера —
warning, а не падение.
"""
import base64

import numpy as np

from app.core.config import settings
from app.services.covariance_qc import covariance_qc
from tests.test_png import _decode_png

_CHANNELS = ["Fp1", "Fp2", "C3", "C4", "T7", "T8", "P3", "P4"]


def _pair(seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """«До» — общая фронтальная компонента с инверсией фазы поверх шума; «после» — шум.

    Общая компонента: Fp1/Fp2 в фазе (+), остальные против (−) — тот самый
    «фронтальный максимум с инверсией фазы»; её дисперсия на порядок больше
    шума, поэтому PC1 обязана забрать почти всё, а шумовой хвост λ упасть
    ниже порога ``covariance_qc_tail_ratio``.
    """
    rng = np.random.default_rng(seed)
    n = 20_000
    loadings = np.array([[4.0], [4.0], [-1.0], [-1.0], [-1.0], [-1.0], [-1.0], [-1.0]])
    shared = rng.standard_normal((1, n)) * 20e-6
    noise = rng.standard_normal((len(_CHANNELS), n)) * 2e-6
    before = loadings * shared + noise
    after = rng.standard_normal((len(_CHANNELS), n)) * 2e-6
    return before, after


def test_pca_finds_shared_component_and_noise_tail():
    """PC1 забирает общую компоненту, проценты сходятся к 100, хвост за порогом."""
    before, after = _pair()
    result = covariance_qc(before, after, _CHANNELS, settings)

    assert result["channels"] == _CHANNELS
    assert result["tail_ratio"] == settings.covariance_qc_tail_ratio
    for side in (result["before"], result["after"]):
        eigen = side["eigenvalues_uv2"]
        assert len(eigen) == len(_CHANNELS)
        assert all(value >= 0 for value in eigen), "λ — спектр PSD, минус только числовой шум"
        assert eigen == sorted(eigen, reverse=True), "собственные значения по убыванию"
        assert abs(sum(side["variance_percent"]) - 100.0) < 0.5, "доли дисперсии дают 100 %"
        assert side["cumulative_percent"][-1] == max(side["cumulative_percent"])

    # «До»: общая доминирует (загрузки 4× против шума 2 мкВ) и хвост за порогом
    assert result["before"]["variance_percent"][0] >= 90.0
    assert result["before"]["effective_rank"] == 1
    # «После»: структуры нет — равномерный шумовой спектр занимает весь монтаж
    assert result["after"]["effective_rank"] == len(_CHANNELS)


def test_images_are_valid_base64_png():
    """Heatmap и топокарты ПК — валидные PNG; число ПК — из конфига."""
    before, after = _pair()
    result = covariance_qc(before, after, _CHANNELS, settings)

    for slot in ("before", "after"):
        side = result[slot]
        assert side["heatmap_png_b64"] is not None, f"heatmap {slot} обязана построиться"
        heatmap = _decode_png(base64.b64decode(side["heatmap_png_b64"]))
        assert heatmap["width"] > 50 and heatmap["height"] > 50

        assert len(side["components"]) == settings.covariance_qc_top_components
        for component in side["components"]:
            assert component["topomap_png_b64"] is not None, f"PC{component['index']}"
            topomap = _decode_png(base64.b64decode(component["topomap_png_b64"]))
            assert topomap["color_type"] == 6, "топокарта — RGBA, как у спектра (N32)"
        assert [c["index"] for c in side["components"]] == list(
            range(1, settings.covariance_qc_top_components + 1)
        )


def test_sign_of_pc_is_deterministic_between_recalculations():
    """Знак ПК якорен — пересчёт не показывает зеркальную картинку той же PC."""
    before, after = _pair()
    first = covariance_qc(before, after, _CHANNELS, settings)
    second = covariance_qc(before, after, _CHANNELS, settings)

    for slot in ("before", "after"):
        assert first[slot]["heatmap_png_b64"] == second[slot]["heatmap_png_b64"]
        for left, right in zip(first[slot]["components"], second[slot]["components"], strict=True):
            assert left["topomap_png_b64"] == right["topomap_png_b64"]


def test_missing_montage_positions_gives_warning_without_topomaps():
    """Каналы вне монтажа: числа и heatmap на месте, топокарты — честный None + warning."""
    channels = ["EEG001", "EEG002", "EEG003"]
    rng = np.random.default_rng(1)
    data = rng.standard_normal((len(channels), 5000)) * 5e-6

    result = covariance_qc(data, data, channels, settings)

    assert any("позиций монтажа" in text for text in result["warnings"]), result["warnings"]
    assert result["before"]["heatmap_png_b64"] is not None, "heatmap позиции монтажа не требует"
    assert result["before"]["variance_percent"], "числа без монтажа считаются"
    for component in result["before"]["components"]:
        assert component["topomap_png_b64"] is None


def test_zero_signal_is_honest_refusal_not_fake_percentages():
    """Нулевая дисперсия: честный отказ (пустые проценты, ранг 0), а не «100 %»."""
    empty = np.zeros((len(_CHANNELS), 1000))

    result = covariance_qc(empty, empty, _CHANNELS, settings)

    assert result["before"]["variance_percent"] == []
    assert result["before"]["effective_rank"] == 0
    assert result["before"]["heatmap_png_b64"] is None
    assert any("Нулевая дисперсия" in text for text in result["warnings"])


def test_image_failure_keeps_numbers_with_warning(monkeypatch):
    """Сбой рендера heatmap — warning, но числа и топокарты остаются."""
    import app.services.covariance_qc as qc

    def _boom(*args, **kwargs):
        raise RuntimeError("Agg упал")

    monkeypatch.setattr(qc, "_heatmap_png", _boom)
    before, after = _pair()
    result = covariance_qc(before, after, _CHANNELS, settings)

    assert result["before"]["heatmap_png_b64"] is None
    assert result["before"]["variance_percent"], "числа обязаны пережить сбой картинки"
    assert all(pc["topomap_png_b64"] for pc in result["before"]["components"])
    assert any("Heatmap" in text for text in result["warnings"])
