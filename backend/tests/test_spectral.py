"""Тесты спектра по диапазонам и топокарт (срез 3.4, `app/services/spectral.py`).

Быстрая часть не требует fsaverage: спектр считается на синтетическом EDF
(альфа-ритм 10 Гц с разной амплитудой по каналам — average reference такой сигнал
не «съедает»), топокарта разбирается обратно PNG-декодером из `test_png.py`, а
роуты проверяются через `TestClient` с записью в реестре.

Проверяется главное: диапазоны берутся из конфига (DRY), мощность попадает в свой
ритм, топокарта — RGBA-картинка с палитрой MNE и прозрачностью вне контура головы,
кэшируется по ETag, а задача идёт фоново с прогрессом по эпохам.
"""
import os
import shutil
import time

import numpy as np
import pytest

from app.core.config import settings
from app.services import spectral as spectral_mod
from app.services.recordings import recording_registry
from app.services.spectral import (
    SpectrumParams,
    channel_positions,
    clear_spectrum_cache,
    compute_spectrum,
    spectrum_signature,
    topomap_png,
)
from tests.conftest import write_minimal_edf
from tests.test_png import _decode_png

_PREFIX = "/api/v1"


def _upload_dirs() -> set[str]:
    root = settings.upload_dir
    if not os.path.isdir(root):
        return set()
    return {name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))}


@pytest.fixture(autouse=True)
def clean_state():
    """Изоляция реестра записей и дискового кэша топокарт между тестами."""
    recording_registry.clear()
    clear_spectrum_cache(settings)
    before = _upload_dirs()
    yield
    recording_registry.clear()
    clear_spectrum_cache(settings)
    for name in _upload_dirs() - before:
        shutil.rmtree(os.path.join(settings.upload_dir, name), ignore_errors=True)


def _alpha_edf(tmp_path, seconds: float = 6.0):
    """EDF с альфа-ритмом 10 Гц: амплитуда растёт от канала к каналу."""
    path = tmp_path / "alpha.edf"
    channels = list(settings.standard_channels[:8])
    sfreq = 250.0
    times = np.arange(int(seconds * sfreq)) / sfreq
    gain = 5.0 + np.arange(len(channels), dtype=float)
    data = np.sin(2 * np.pi * 10 * times)[None, :] * gain[:, None]
    write_minimal_edf(path, channels, data, sfreq)
    return path


def _register(tmp_path, edf_path, recording_id: str = "rec-spectrum"):
    """Регистрирует запись так, как это делает ``POST /recordings``."""
    upload_dir = tmp_path / recording_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    target = upload_dir / edf_path.name
    shutil.copyfile(edf_path, target)
    return recording_registry.register(str(target), str(upload_dir), edf_path.name, settings)


def _wait_finished(client, job_id: str, timeout: float = 30.0) -> dict:
    """Ждёт завершения задачи (поллинг, как делает UI)."""
    deadline = time.time() + timeout
    body: dict = {}
    while time.time() < deadline:
        body = client.get(f"{_PREFIX}/jobs/{job_id}").json()
        if body["status"] in ("succeeded", "failed"):
            return body
        time.sleep(0.05)
    raise AssertionError(f"Задача не завершилась за {timeout} с: {body}")


def test_compute_spectrum_puts_power_into_its_band(tmp_path):
    """Альфа-ритм 10 Гц даёт максимум в alpha, а диапазоны берутся из конфига."""
    recording = _register(tmp_path, _alpha_edf(tmp_path))

    result = compute_spectrum(
        recording, settings,
        SpectrumParams(filter_band=(1, 40), epoch_length_ms=1000.0),
    )

    assert [band["name"] for band in result["bands"]] == list(settings.freq_bands)
    powers = {band["name"]: band["power_uv2"] for band in result["bands"]}
    assert powers["alpha"] > powers["delta"]
    assert powers["alpha"] > powers["beta"]
    assert result["n_epochs"] > 0
    assert len(result["freqs"]) == len(result["psd_mean_uv2"])
    # Частоты по возрастанию, границы — как в диапазонах конфига
    assert result["freqs"] == sorted(result["freqs"])
    assert result["freqs"][0] >= min(band[0] for band in settings.freq_bands.values())
    assert result["warnings"] == []
    for band in result["bands"]:
        measured = any(band["fmin"] <= f <= band["fmax"] for f in result["freqs"])
        if measured:
            assert band["topomap_url"].endswith(f"/spectrum/topomap/{band['name']}.png")
        else:
            # Полоса целиком вне оси PSD (здесь фильтр 1–40 Гц отсек γ-high):
            # топокарта не строится, мощность — честный null, а не выдуманный ноль
            assert band["topomap_url"] is None
            assert band["power_uv2"] is None


def test_spectrum_signature_follows_filter_and_channels():
    """Подпись кэша меняется вместе с фильтром и набором каналов."""
    channels = list(settings.standard_channels[:5])
    base = SpectrumParams(filter_band=(1, 40), epoch_length_ms=1000.0)
    other = SpectrumParams(filter_band=(4, 8), epoch_length_ms=1000.0)

    assert spectrum_signature(base, settings, channels) != spectrum_signature(other, settings, channels)
    assert spectrum_signature(base, settings, channels) != spectrum_signature(base, settings, channels[:3])
    assert spectrum_signature(base, settings, channels) == spectrum_signature(base, settings, list(channels))


def test_compute_spectrum_computes_signature_once(tmp_path, monkeypatch):
    """Подпись кэша считается один раз на задачу: второй расчёт — дубль (3.3, N26).

    Аудит находил в `compute_spectrum` два одинаковых вызова `spectrum_signature`
    (строки 359 и 384 в ревизии 7625de6); дубль удалён в 09b403d — тест не даёт
    ему вернуться. Второй вызов в `cached_topomap` не считается: это отдельная
    точка входа со своими каналами (`recording.meta`), не дубль внутри задачи.
    """
    recording = _register(tmp_path, _alpha_edf(tmp_path))
    original = spectral_mod.spectrum_signature
    calls: list[int] = []

    def counting(params, cfg, channels):
        calls.append(1)
        return original(params, cfg, channels)

    monkeypatch.setattr(spectral_mod, "spectrum_signature", counting)
    compute_spectrum(
        recording, settings,
        SpectrumParams(filter_band=(1, 40), epoch_length_ms=1000.0),
    )

    assert len(calls) == 1


def test_topomap_png_is_circle_with_transparent_outside():
    """Топокарта — RGBA-палитра MNE: вне контура головы прозрачно, внутри цвет «дышит»."""
    channels = list(settings.standard_channels[:8])
    positions = channel_positions(channels)
    assert len(positions) == len(channels)
    values = {name: 10.0 + index for index, name in enumerate(channels)}

    decoded = _decode_png(topomap_png(positions, values))
    pixels = decoded["pixels"]

    assert decoded["color_type"] == 6, "ожидался RGBA (цвет + альфа, N32)"
    size = pixels.shape[0]
    assert pixels[0, 0, 3] == 0, "угол картинки должен быть прозрачным"
    assert pixels[size - 1, 0, 3] == 0, "угол картинки должен быть прозрачным"
    assert pixels[size // 2, size // 2, 3] == 255, "центр контура непрозрачен"
    # Палитра, а не один оттенок: у каждой мощности свой цвет (vlim min..max)
    opaque = pixels[pixels[:, :, 3] > 200][:, :3]
    colors = np.unique(opaque, axis=0)
    assert len(colors) > 50, f"ожидалась палитра, найдено цветов: {len(colors)}"


def test_spectrum_job_flow(client, tmp_path):
    """202 → поллинг с прогрессом по эпохам → результат по `result_url`."""
    recording = _register(tmp_path, _alpha_edf(tmp_path))

    created = client.post(
        f"{_PREFIX}/recordings/{recording.recording_id}/spectrum",
        data={"band_min": 1, "band_max": 40, "epoch_length_ms": 1000},
    )
    assert created.status_code == 202, created.text
    job_id = created.json()["job_id"]

    status = _wait_finished(client, job_id)
    assert status["status"] == "succeeded", status
    assert status["kind"] == "spectrum"
    assert status["result_url"] == f"{_PREFIX}/recordings/{recording.recording_id}/spectrum/{job_id}"
    # Детальный прогресс эпох (срез 3.4): UI рисует по нему прогресс-бар
    assert status["epochs_total"] > 0
    assert status["epochs_done"] == status["epochs_total"]

    result = client.get(status["result_url"])
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["recording_id"] == recording.recording_id
    assert body["topomap_version"]
    assert [band["name"] for band in body["bands"]] == list(settings.freq_bands)

    # Топокарта диапазона: PNG + ETag, повторный запрос — 304
    query = {"band_min": 1, "band_max": 40, "epoch_length_ms": 1000}
    alpha_url = next(b["topomap_url"] for b in body["bands"] if b["name"] == "alpha")
    image = client.get(alpha_url, params=query)
    assert image.status_code == 200, image.text
    assert image.headers["content-type"] == "image/png"
    assert image.headers["x-spectrum-band"] == "alpha"
    again = client.get(alpha_url, params=query, headers={"If-None-Match": image.headers["etag"]})
    assert again.status_code == 304


def test_spectrum_job_validates_params(client, tmp_path):
    """Односторонняя полоса, длина эпохи вне списка и чужая запись — 400/404."""
    recording = _register(tmp_path, _alpha_edf(tmp_path))
    base = f"{_PREFIX}/recordings/{recording.recording_id}/spectrum"

    assert client.post(base, data={"band_min": 1}).status_code == 400
    assert client.post(base, data={"band_max": 40}).status_code == 400
    assert client.post(base, data={"band_min": 40, "band_max": 1}).status_code == 400
    assert client.post(base, data={"epoch_length_ms": 333}).status_code == 400
    assert client.post(f"{_PREFIX}/recordings/nope/spectrum").status_code == 404


def test_topomap_route_reports_unknown_band_and_recording(client, tmp_path):
    """Неизвестный диапазон — 400, чужая запись — 404 (ссылка не «повисает»)."""
    recording = _register(tmp_path, _alpha_edf(tmp_path))

    bad_band = client.get(f"{_PREFIX}/recordings/{recording.recording_id}/spectrum/topomap/omega.png")
    assert bad_band.status_code == 400
    assert client.get(f"{_PREFIX}/recordings/nope/spectrum/topomap/alpha.png").status_code == 404


def test_band_power_outside_frequency_axis_is_none_not_nan():
    """Диапазон вне частотной оси — ``None``; «NaN» в JSON сломал бы клиент.

    Частотная ось PSD задаётся окном и полосой всего расчёта: если частоты
    диапазона в неё не попали, мощность **не измерена**. Отдавать её нулём нельзя,
    а NaN — невалидный JSON (`JSON.parse` на клиенте упал бы).
    """
    from app.schemas.analysis import SpectrumBandOut
    from app.services.spectral import _band_powers

    freqs = np.array([2.0, 6.0, 10.0])
    psd = np.ones((2, 3))

    powers = _band_powers(freqs, psd, settings.freq_bands)

    # Один бин в полосе Simpson не интегрирует: оценка значением × шаг оси (4 Гц)
    assert powers["delta"] == 4.0
    assert powers["alpha"] == 4.0
    # Полосы сетки (β 16–32, γ 32–64, γ-high 64–128) за пределами оси — не измерены
    assert powers["beta"] is None
    assert powers["gamma"] is None
    assert powers["high_gamma"] is None
    band = SpectrumBandOut(name="gamma", fmin=32, fmax=64, power_uv2=powers["gamma"])
    dumped = band.model_dump_json()
    assert "NaN" not in dumped
    assert "null" in dumped


def test_band_power_is_integral_not_mean():
    """N15: мощность полосы — площадь под PSD, а не среднее по бинам.

    На плоском спектре (все PSD = 1 мкВ²/Гц) среднее давало бы 1.0 для всех
    диапазонов, а интеграл пропорционален ширине полосы: β (16–32) в 16/8 = 2
    раза больше α (8–16). Именно это делает мощности диапазонов сравнимыми.
    """
    from app.services.spectral import _band_powers

    freqs = np.arange(1.0, 41.0, 1.0)
    psd = np.ones((4, freqs.size))

    powers = _band_powers(freqs, psd, settings.freq_bands)

    assert powers["alpha"] == pytest.approx(8.0)
    assert powers["beta"] == pytest.approx(16.0)
    assert powers["beta"] / powers["alpha"] == pytest.approx(2.0)


def test_spectrum_reports_iaf_ratios_and_epoch_spread(tmp_path):
    """N16: IAF ≈ частоте ведущего ритма, индексы и разброс по эпохам заполнены."""
    recording = _register(tmp_path, _alpha_edf(tmp_path))

    result = compute_spectrum(
        recording, settings,
        SpectrumParams(filter_band=(1, 40), epoch_length_ms=1000.0),
    )

    # IAF: синтетический ритм ровно 10 Гц → пик в α с параболическим уточнением
    assert result["iaf_hz"] is not None
    assert abs(result["iaf_hz"] - 10.0) <= 1.0
    # Индексы посчитаны и положительны
    assert result["theta_beta_ratio"] is not None and result["theta_beta_ratio"] > 0
    assert result["theta_alpha_beta_ratio"] is not None
    assert result["theta_alpha_beta_ratio"] > result["theta_beta_ratio"]
    # Relative power: доли в (0, 1), α — ведущий ритм
    bands = {band["name"]: band for band in result["bands"]}
    measured = [b["relative_power"] for b in bands.values() if b["relative_power"] is not None]
    assert all(0.0 < value < 1.0 for value in measured)
    assert bands["alpha"]["relative_power"] == max(measured)
    # Разброс по эпохам: квартили упорядочены, медиана близка к мощности
    alpha = bands["alpha"]
    assert alpha["q25_power_uv2"] <= alpha["median_power_uv2"] <= alpha["q75_power_uv2"]
    assert alpha["median_power_uv2"] == pytest.approx(alpha["power_uv2"], rel=0.5)


def _pink_edf(tmp_path, seconds: float = 8.0):
    """EDF: «розовый» фон (случайное блуждание, PSD ∝ 1/f²) + тон α 10 Гц.

    Чистого тона мало для 1/f-разложения: фиту нужен апериодический фон, а не
    одни нули вне пика. Синтетик похож на реальный спектр ЭЭГ.
    """
    from scipy.signal import lfilter

    path = tmp_path / "pink.edf"
    channels = list(settings.standard_channels[:8])
    sfreq = 250.0
    n = int(seconds * sfreq)
    times = np.arange(n) / sfreq
    rng = np.random.default_rng(7)
    pink = lfilter([1.0], [1.0, -0.98], rng.standard_normal(n))
    pink = pink / max(float(np.std(pink)), 1e-9)
    tone = 2.0 * np.sin(2 * np.pi * 10 * times)
    gain = 2.0 + np.arange(len(channels), dtype=float) * 0.3
    data = (pink[None, :] + tone[None, :]) * gain[:, None]
    write_minimal_edf(path, channels, data, sfreq)
    return path


def test_multitaper_method_reports_alpha_tone_on_short_epochs(tmp_path):
    """N17: multitaper на коротких эпохах (250 мс) даёт тон в своём ритме.

    Welch на эпохе 250 мс берёт окно не длиннее эпохи и разрешение ≈ 4 Гц —
    α шириной в 5 Гц покрывается одним-двумя бинами. Multitaper считает ту же
    эпоху целиком и ставит альфа-максимум туда, где он есть.
    """
    recording = _register(tmp_path, _alpha_edf(tmp_path))

    result = compute_spectrum(
        recording, settings,
        SpectrumParams(filter_band=(1, 40), epoch_length_ms=250.0, psd_method="multitaper"),
    )

    assert result["psd_method"] == "multitaper"
    # Окно анализа multitaper — вся эпоха: в подписи её длина, а не усечённый `n_fft`
    assert result["n_fft"] > 250 * 250 / 1000 / 2  # больше половины эпохи, отсчётов
    powers = {band["name"]: band["power_uv2"] for band in result["bands"]}
    # δ 0.5–2 Гц на частотной сетке 4 Гц (эпоха 250 мс) не покрыт ни одним бином —
    # честный `None` («не измерено»), а не ноль; тон обязан быть в α, а не в β
    assert powers["alpha"] is not None
    assert powers["delta"] is None or powers["alpha"] > powers["delta"]
    assert powers["alpha"] > powers["beta"]
    # IAF на сетке 250 мс (< 3 бинов в α) честно `None` — N16; центр здесь
    # уточняет specparam (суббиново), а не аргмакс по грубой сетке
    assert result["iaf_hz"] is None or abs(result["iaf_hz"] - 10.0) <= 2.0
    assert result["peaks"], "specparam на тоне обязан найти пик"
    assert abs(result["peaks"][0]["center_hz"] - 10.0) <= 2.0


def test_spectrum_signature_follows_psd_method():
    """Метод PSD — часть отпечатка: топокарта multitaper не отдаётся за Welch."""
    channels = list(settings.standard_channels[:5])
    welch = SpectrumParams(filter_band=(1, 40), epoch_length_ms=1000.0, psd_method="welch")
    multitaper = SpectrumParams(
        filter_band=(1, 40), epoch_length_ms=1000.0, psd_method="multitaper",
    )

    assert spectrum_signature(welch, settings, channels) != spectrum_signature(
        multitaper, settings, channels
    )
    assert spectrum_signature(welch, settings, channels) == spectrum_signature(
        SpectrumParams(filter_band=(1, 40), epoch_length_ms=1000.0), settings, channels
    )


def test_specparam_separates_aperiodic_slope_and_alpha_peak(tmp_path):
    """specparam/FOOOF: фон 1/f и пик α 10 Гц разведены, кривая фона на сетке PSD."""
    recording = _register(tmp_path, _pink_edf(tmp_path))

    result = compute_spectrum(
        recording, settings,
        SpectrumParams(filter_band=(1, 40), epoch_length_ms=1000.0),
    )

    assert result["aperiodic_exponent"] is not None
    assert 1.0 <= result["aperiodic_exponent"] <= 3.0, result["aperiodic_exponent"]
    assert result["aperiodic_offset"] is not None
    assert result["fit_r_squared"] is not None and result["fit_r_squared"] > 0.5
    # Кривая фона — та же сетка, что и PSD: клиент рисует её поверх ломаной
    assert len(result["aperiodic_fit_uv2"]) == len(result["freqs"])
    assert all(value > 0 for value in result["aperiodic_fit_uv2"])
    # Ведущий пик — α 10 Гц, пики упорядочены по убыванию высоты
    assert result["peaks"], "на тоне фит обязан найти хотя бы один пик"
    top = result["peaks"][0]
    assert abs(top["center_hz"] - 10.0) <= 1.5
    assert top["amplitude_db"] > 0
    assert top["bandwidth_hz"] > 0
    assert result["peaks"] == sorted(
        result["peaks"], key=lambda peak: -peak["amplitude_db"]
    )


def test_specparam_failure_is_warning_not_error(tmp_path, monkeypatch):
    """Отказ фита — предупреждение и null-поля, а не упавшая задача."""
    import specparam

    recording = _register(tmp_path, _pink_edf(tmp_path))

    def _broken_fit(self, *args, **kwargs):
        raise RuntimeError("fit exploded")

    monkeypatch.setattr(specparam.SpectralModel, "fit", _broken_fit)

    result = compute_spectrum(
        recording, settings,
        SpectrumParams(filter_band=(1, 40), epoch_length_ms=1000.0),
    )

    assert result["aperiodic_exponent"] is None
    assert result["aperiodic_offset"] is None
    assert result["aperiodic_fit_uv2"] == []
    assert result["peaks"] == []
    assert result["fit_r_squared"] is None
    # Задача жива: мощности ритмов посчитаны, а фит честно помечен в warnings
    assert any("1/f-разложение не сошлось" in text for text in result["warnings"])
    assert result["bands"]


def test_spectrum_job_rejects_unknown_psd_method(client, tmp_path):
    """Неизвестный метод PSD — 400 с текстом для UI, а не фоновая ошибка."""
    recording = _register(tmp_path, _alpha_edf(tmp_path))

    response = client.post(
        f"{_PREFIX}/recordings/{recording.recording_id}/spectrum",
        data={"band_min": 1, "band_max": 40, "epoch_length_ms": 1000, "psd_method": "periodogram"},
    )

    assert response.status_code == 400
    assert "psd_method" in response.json()["detail"]


def test_topomap_etag_depends_on_psd_method(client, tmp_path):
    """ETag топокарты знает метод: картинка другого расчёта не приходит с ним."""
    recording = _register(tmp_path, _alpha_edf(tmp_path))
    base = f"{_PREFIX}/recordings/{recording.recording_id}/spectrum/topomap/alpha.png"

    welch = client.get(base, params={"band_min": 1, "band_max": 40, "epoch_length_ms": 1000})
    multitaper = client.get(
        base, params={
            "band_min": 1, "band_max": 40, "epoch_length_ms": 1000, "psd_method": "multitaper",
        },
    )

    assert welch.status_code == 200, welch.text
    assert multitaper.status_code == 200, multitaper.text
    assert welch.headers["etag"] != multitaper.headers["etag"]
    # Повторный запрос своего метода — 304, а не пересчёт
    again = client.get(
        base,
        params={"band_min": 1, "band_max": 40, "epoch_length_ms": 1000, "psd_method": "multitaper"},
        headers={"If-None-Match": multitaper.headers["etag"]},
    )
    assert again.status_code == 304


# --- С3: разведочный спектральный проход ---


def test_explore_pass_normalizes_by_band_bases():
    """С3: строки частот в долях от «полки» и пика плотности своей полосы.

    Точный расчёт на кубе 2 эпохи × 1 канал × 3 частоты: мощность бина —
    PSD × df, амплитудный диапазон частоты — min/квартили/макс по эпохам,
    всё — в долях от «полки» полосы (11 мкВ² у верхней эпохи).
    """
    from app.core.config import EXPLORE_POWER_BASIS, EXPLORE_PSD_BASIS
    from app.services.spectral import _explore_pass

    freqs = np.array([9.0, 10.0, 11.0])
    psd = np.array([[[2.0, 4.0, 1.0]], [[4.0, 8.0, 2.0]]])  # (2 эпохи, 1 канал, 3 частоты)
    psd_ch_mean = np.array([3.0, 6.0, 1.5])
    bands = {"alpha": (8.0, 16.0)}
    band_max = {"alpha": 11.0}  # трапеция полосы: эпоха 0 → 5.5, эпоха 1 → 11
    psd_peaks = {"alpha": (10.0, 6.0)}

    explore = _explore_pass(freqs, psd, psd_ch_mean, bands, band_max, psd_peaks, df=1.0)

    assert explore["df_hz"] == 1.0
    assert explore["power_basis"] == EXPLORE_POWER_BASIS
    assert explore["psd_basis"] == EXPLORE_PSD_BASIS
    lines = explore["lines"]
    assert [line["freq_hz"] for line in lines] == [9.0, 10.0, 11.0]
    peak_line = lines[1]
    assert peak_line["band_key"] == "alpha"
    assert peak_line["psd_uv2_hz"] == 6.0
    assert peak_line["power_uv2"] == 6.0
    assert peak_line["psd_share"] == pytest.approx(1.0)  # пик плотности своей полосы
    assert peak_line["power_share"] == pytest.approx(6.0 / 11.0)
    # Амплитудный диапазон частоты по эпохам: 4 и 8 мкВ² → доли от «полки» 11
    assert peak_line["amp_min_share"] == pytest.approx(4.0 / 11.0)
    assert peak_line["amp_median_share"] == pytest.approx(6.0 / 11.0)
    assert peak_line["amp_max_share"] == pytest.approx(8.0 / 11.0)


def test_explore_shares_are_none_without_base():
    """С3: без базы нормировки (нулевая «полка») доли — None, а не ноль."""
    from app.services.spectral import _explore_pass

    freqs = np.array([10.0])
    psd = np.zeros((2, 1, 1))
    explore = _explore_pass(
        freqs, psd, np.zeros(1), {"alpha": (8.0, 16.0)},
        {"alpha": 0.0}, {"alpha": (10.0, 0.0)}, df=1.0,
    )

    line = explore["lines"][0]
    assert line["psd_uv2_hz"] == 0.0
    assert line["power_uv2"] == 0.0
    for key in ("psd_share", "power_share", "amp_min_share", "amp_median_share", "amp_max_share"):
        assert line[key] is None, key


def test_band_key_of_freq_boundary_belongs_to_upper_rhythm():
    """С3: граница ритмов (2 Гц) принадлежит верхнему ритму — нормировка «своя»."""
    from app.services.spectral import _band_key_of_freq

    assert _band_key_of_freq(0.5, settings.freq_bands) == "delta"
    assert _band_key_of_freq(2.0, settings.freq_bands) == "delta_theta"
    assert _band_key_of_freq(8.0, settings.freq_bands) == "alpha"
    assert _band_key_of_freq(128.0, settings.freq_bands) == "high_gamma"
    assert _band_key_of_freq(200.0, settings.freq_bands) is None


def test_compute_spectrum_exploratory_pass_lists_frequencies(tmp_path):
    """С3: разведочный проход приходит с результатом спектра — частоты сравнимы.

    Альфа 10 Гц: строка пика несёт долю 1.0 своей полосы, поле `psd_peak_hz`
    полосы alpha указывает на пик, амплитудные диапазоны упорядочены, а ритм
    вне полосы фильтра (γ-high при 1–40 Гц) честно не измерен.
    """
    recording = _register(tmp_path, _alpha_edf(tmp_path))

    result = compute_spectrum(
        recording, settings,
        SpectrumParams(filter_band=(1, 40), epoch_length_ms=1000.0),
    )

    explore = result["explore"]
    assert explore is not None
    assert len(explore["lines"]) == len(result["freqs"])
    assert [line["freq_hz"] for line in explore["lines"]] == sorted(
        [line["freq_hz"] for line in explore["lines"]],
    )

    alpha_line = min(explore["lines"], key=lambda line: abs(line["freq_hz"] - 10.0))
    assert alpha_line["band_key"] == "alpha"
    assert alpha_line["psd_share"] == pytest.approx(1.0)
    for line in explore["lines"]:
        assert line["band_key"] is not None  # сетка δ…γ тайлинг без дыр
        ordered = [
            line["amp_min_share"], line["amp_q25_share"], line["amp_median_share"],
            line["amp_q75_share"], line["amp_max_share"],
        ]
        values = [value for value in ordered if value is not None]
        assert values == sorted(values)
        assert all(value >= 0.0 for value in values)

    bands = {band["name"]: band for band in result["bands"]}
    alpha = bands["alpha"]
    # Пик по частоте (B4) — тот же бин, что строка прохода с долей 1.0
    # (сетка Welch при эпохе 251 отсчёт — df = 250/251, бин рядом с 10 Гц)
    assert alpha["psd_peak_hz"] == pytest.approx(10.0, abs=0.5)
    assert alpha["psd_peak_hz"] == alpha_line["freq_hz"]
    assert alpha["psd_peak_uv2_hz"] == pytest.approx(max(result["psd_mean_uv2"]))
    assert alpha["band_power_max_uv2"] is not None
    assert alpha["band_power_max_uv2"] >= alpha["median_power_uv2"]
    # γ-high вне полосы фильтра (1–40): пик и «полка» — честные None
    assert bands["high_gamma"]["psd_peak_hz"] is None
    assert bands["high_gamma"]["psd_peak_uv2_hz"] is None
    assert bands["high_gamma"]["band_power_max_uv2"] is None


def test_spectrum_result_accepts_old_jobs_without_explore():
    """С3: результат прошлой версии кода (без `explore`) валиден — поле None."""
    from app.schemas.analysis import SpectrumResult

    result = SpectrumResult(
        recording_id="rec", channels=["Cz"], sfreq=250.0, epoch_length_ms=1000.0,
        n_epochs=2, n_fft=256, freqs=[1.0, 2.0], psd_mean_uv2=[1.0, 2.0],
        topomap_version="sig",
    )

    assert result.explore is None
