"""Тесты предподготовки записи (срез 2.7): стадии filter / artifacts / epochs.

Стадии раздельные (docs/ui.md): каждая считает свой слот и не обесценивает
результаты других. Здесь проверяется и сервис (`run_preprocess`), и контракт
API: 202 + задача, прогресс в ``/jobs/{id}``, результат — рядом с записью.

Правило «обработка — только по кнопке» проверяется отдельно: правка параметров
в UI не делает запросов, расчёт стартует исключительно ``POST …/preprocess``.
"""
import os
import shutil
import time

import numpy as np
import pytest

from app.core.config import settings
from app.services.preprocess import PreprocessParams, _reject_channels, run_preprocess
from app.services.recordings import recording_registry
from tests.conftest import write_minimal_edf

_PREFIX = "/api/v1"


def _upload_dirs() -> set[str]:
    """Каталоги записей в upload_dir (по одному на запись)."""
    root = settings.upload_dir
    if not os.path.isdir(root):
        return set()
    return {name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))}


@pytest.fixture(autouse=True)
def clean_state():
    """Изоляция реестра и каталогов загрузок между тестами."""
    recording_registry.clear()
    before = _upload_dirs()
    yield
    recording_registry.clear()
    for name in _upload_dirs() - before:
        shutil.rmtree(os.path.join(settings.upload_dir, name), ignore_errors=True)


def _upload(client, path, name="probe.edf") -> dict:
    with open(path, "rb") as fh:
        response = client.post(
            f"{_PREFIX}/recordings", files={"file": (name, fh, "application/octet-stream")}
        )
    assert response.status_code == 201, response.text
    return response.json()


def _wait_finished(client, job_id: str, timeout: float = 20.0) -> dict:
    """Ждёт завершения задачи предподготовки (поллинг, как это делает UI)."""
    deadline = time.time() + timeout
    body: dict = {}
    while time.time() < deadline:
        body = client.get(f"{_PREFIX}/jobs/{job_id}").json()
        if body["status"] in ("succeeded", "failed"):
            return body
        time.sleep(0.05)
    raise AssertionError(f"Задача не завершилась за {timeout} с: {body}")


def _register(tmp_path, edf_file, recording_id="rec-test"):
    """Регистрирует запись так, как это делает ``POST /recordings``."""
    upload_dir = tmp_path / recording_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    target = upload_dir / edf_file.name
    shutil.copyfile(edf_file, target)
    return recording_registry.register(str(target), str(upload_dir), edf_file.name, settings)


@pytest.fixture
def spike_edf(tmp_path):
    """EDF 10.5 с, где всплеск 250 мкВ лежит целиком внутри эпохи 5.

    Длина выбрана так, чтобы запись делилась на 10 полных эпох по 1 с без
    «TOO_SHORT» на хвосте, а всплеск был далеко от краёв: детектор
    peak-to-peak работает окном 2 с, и его зоны законно отбраковывают
    соседние эпохи (N6) — тест обязан учитывать и их, и amplitude-reject.
    """
    path = tmp_path / "spike.edf"
    sfreq = 250.0
    n_times = int(10.5 * sfreq)
    t = np.arange(n_times) / sfreq
    data = np.vstack([
        np.sin(2 * np.pi * (6 + channel) * t) * 20
        for channel in range(5)
    ])
    # Кадры 1260–1490 (эпоха 5: кадры 1250–1500) — границы эпох чистые
    data[0, 1260:1490] = 250.0
    write_minimal_edf(
        path, list(settings.standard_channels[:5]), data, sfreq, record_sec=0.5
    )
    return path


# ---------- сервис: стадии ----------

def test_filter_stage_reports_band_notch_and_reference(tmp_path, edf_file):
    recording = _register(tmp_path, edf_file)
    stages: list[str] = []

    result = run_preprocess(
        recording, settings,
        PreprocessParams(
            stage="filter",
            filter_band=(1.0, 40.0),
            notch_hz=50.0,
            reference="average",
        ),
        progress=lambda stage, *_, **__: stages.append(stage),
    )

    assert result["stage"] == "filter"
    assert result["band_hz"] == [1.0, 40.0]
    assert result["notch_hz"] == 50.0
    assert result["reference"] == "average"
    assert result["channels"] == list(settings.standard_channels[:5])
    assert result["sfreq"] == pytest.approx(250.0)
    assert result["duration_sec"] == pytest.approx(4.0, abs=0.1)
    assert result["warnings"] == []
    # Прогресс: чтение → готово (промежуточных этапов у стадии фильтра нет)
    assert stages == ["load_edf", "done"]
    assert result["duration_sec_calc"] >= 0


def test_filter_stage_without_band_warns_but_succeeds(tmp_path, edf_file):
    recording = _register(tmp_path, edf_file)

    result = run_preprocess(
        recording, settings,
        PreprocessParams(stage="filter", filter_band=None),
        progress=lambda *_, **__: None,
    )

    assert result["band_hz"] is None
    assert any("без band-pass" in warning for warning in result["warnings"])


def test_artifacts_stage_returns_zones_with_channels(tmp_path, edf_file):
    """Низкий порог peak-to-peak делает зоны непустыми и с каналами."""
    recording = _register(tmp_path, edf_file)

    result = run_preprocess(
        recording, settings,
        PreprocessParams(stage="artifacts", pp_threshold_uv=10.0, run_ica=False),
        progress=lambda *_, **__: None,
    )

    kinds = {zone["kind"] for zone in result["artifacts"]}
    # Низкий порог делает непустыми зоны peak-to-peak; другие детекторы
    # (мышечный, сетевой) могут добавить информационные зоны — каталог открыт.
    assert "peak_to_peak" in kinds
    for kind in kinds:
        assert result["artifact_types"][kind] == sum(
            1 for zone in result["artifacts"] if zone["kind"] == kind
        ), f"счётчик {kind} должен равняться числу зон вида"
    for zone in result["artifacts"]:
        assert zone["duration_sec"] > 0
        assert zone["channels"], "зона должна знать свои каналы (тултип слоя)"
        for name in zone["channels"]:
            assert name in result["channels"]


def test_artifacts_stage_uses_flat_line_params(tmp_path, edf_file):
    """Порог flat-line приходит из параметров стадии, а не из конфига сервера."""
    recording = _register(tmp_path, edf_file)

    result = run_preprocess(
        recording, settings,
        PreprocessParams(stage="artifacts", flat_line_uv=1000.0, flat_line_ms=200.0),
        progress=lambda *_, **__: None,
    )

    flat = [zone for zone in result["artifacts"] if zone["kind"] == "flat_line"]
    assert flat, "при пороге 1000 мкВ весь сигнал — плоская линия"
    assert {name for zone in flat for name in zone["channels"]} == set(result["channels"])


def test_artifacts_stage_returns_channel_qc(tmp_path, edf_file):
    """Стадия artifacts отдаёт QC-сводку по всем каналам + пороги из конфига."""
    recording = _register(tmp_path, edf_file)

    result = run_preprocess(
        recording, settings,
        PreprocessParams(stage="artifacts", run_ica=False),
        progress=lambda *_, **__: None,
    )

    qc = result["channel_qc"]
    assert [row["channel"] for row in qc] == result["channels"]
    assert result["qc_warn_share"] == settings.qc_channel_warn_share
    assert result["qc_bad_share"] == settings.qc_channel_bad_share
    for row in qc:
        assert 0.0 <= row["artifact_share"] <= 1.0


def test_artifacts_stage_qc_marks_flat_recording(tmp_path):
    """Запись «замирает» на секунду (нули 1 с из 4): у всех каналов доля ≥ 0.2.

    Проверяется связка «детектор → зоны → по-канальная сводка». По-канальная
    избирательность покрыта юнит-тестом ``channel_qc_summary``; на уровне стадии
    её не проверяем, потому что средний референс (всегда применяется в
    предподготовке) превращает один «мёртвый» канал в минус-среднее живых —
    flat-line после референса его уже не увидит (известное ограничение: искать
    отвалившийся электрод надо до референса).
    """
    path = tmp_path / "dead.edf"
    sfreq = 250.0
    t = np.arange(int(4 * sfreq)) / sfreq
    data = np.vstack(
        [np.sin(2 * np.pi * (6 + i) * t) * 20 for i in range(5)]
    )
    data[:, int(sfreq) : 2 * int(sfreq)] = 0.0  # вся запись «замерла» на секунду
    from tests.conftest import write_minimal_edf

    write_minimal_edf(path, list(settings.standard_channels[:5]), data, sfreq)
    recording = _register(tmp_path, path)

    result = run_preprocess(
        recording, settings,
        PreprocessParams(stage="artifacts", run_ica=False),
        progress=lambda *_, **__: None,
    )

    qc = {row["channel"]: row for row in result["channel_qc"]}
    assert len(qc) == len(result["channels"])
    for row in qc.values():
        assert row["artifact_share"] >= 0.2
        assert row["by_kind"].get("flat_line", 0.0) > 0


def test_epochs_stage_reports_rejected_indices(tmp_path, spike_edf):
    """Инвариант N6: отброшены эпохи с всплеском И пересекающие зоны детектора.

    Ожидание не хардкодится: сначала стадия artifacts возвращает зоны, затем
    стадия epochs обязана отбросить ровно эпохи, пересекающие эти зоны
    (отбраковка — только аннотации ``BAD_``; amplitude reject MNE отключён,
    всплеск 250 мкВ попадает в зоны детекторов — это эпоха 5).
    """
    recording = _register(tmp_path, spike_edf)

    artifacts = run_preprocess(
        recording, settings,
        PreprocessParams(stage="artifacts", pp_threshold_uv=100.0, run_ica=False),
        progress=lambda *_, **__: None,
    )
    zones = [
        (zone["onset_sec"], zone["onset_sec"] + zone["duration_sec"])
        for zone in artifacts["artifacts"]
    ]
    assert zones, "всплеск 250 мкВ обязан дать зоны peak_to_peak"

    result = run_preprocess(
        recording, settings,
        PreprocessParams(
            stage="epochs", pp_threshold_uv=100.0, epoch_length_ms=1000.0,
        ),
        progress=lambda *_, **__: None,
    )

    # Касание края зоны зависит от округления onset до мс и частоты, поэтому
    # точное множество граничных эпох не хардкодим: инвариант — «ядро зон и
    # эпоха всплеска отброшены, далёкие эпохи сохранены, счётчики согласованы».
    zone_core = {
        start for start in range(10)
        if any(onset < start + 1.0 and start < end for onset, end in zones)
    }
    rejected = set(result["rejected_epochs"])

    assert result["epoch_length_ms"] == 1000.0
    assert result["n_epochs_total"] == 10
    assert 5 in rejected, "эпоха со всплеском обязана быть отброшена"
    assert zone_core <= rejected, "эпохи, пересекающие зоны, обязаны отбраковываться (N6)"
    assert {0, 1, 2, 9}.isdisjoint(rejected), "далёкие от всплеска эпохи сохраняются"
    assert result["n_epochs_used"] == 10 - len(rejected)
    assert any("Отброшено эпох" in warning for warning in result["warnings"])


def test_epochs_stage_rejects_all_epochs_with_clear_error(tmp_path, edf_file):
    """Все эпохи отброшены BAD_-аннотациями — понятная ошибка стадии, а не пустой результат.

    Детекторы помечают BAD_ всю запись (``z_threshold=0`` — любое отклонение от
    медианы выброс): каждая эпоха пересекает зону и уходит в отбраковку.
    """
    from app.services.preprocess import PreprocessError

    recording = _register(tmp_path, edf_file)

    with pytest.raises(PreprocessError, match="Все эпохи отброшены аннотациями BAD_"):
        run_preprocess(
            recording, settings,
            PreprocessParams(
                stage="epochs", epoch_length_ms=1000.0,
                z_threshold=0.0, pp_threshold_uv=1e9, flat_line_uv=-1.0,
            ),
            progress=lambda *_, **__: None,
        )


# ---------- API: контракт задачи предподготовки ----------

def test_preprocess_job_returns_result_next_to_recording(client, edf_file):
    """202 + задача → поллинг → результат по ``result_url`` (не ``/jobs/{id}/result``)."""
    meta = _upload(client, edf_file)
    recording_id = meta["recording_id"]

    created = client.post(
        f"{_PREFIX}/recordings/{recording_id}/preprocess",
        data={"stage": "artifacts", "pp_threshold_uv": "10", "band_min": "1", "band_max": "40"},
    )
    assert created.status_code == 202, created.text
    payload = created.json()
    assert payload["status"] in ("queued", "running")
    assert payload["poll_url"] == f"{_PREFIX}/jobs/{payload['job_id']}"
    assert payload["result_url"] == (
        f"{_PREFIX}/recordings/{recording_id}/preprocess/{payload['job_id']}"
    )

    status = _wait_finished(client, payload["job_id"])
    assert status["status"] == "succeeded", status
    assert status["kind"] == "preprocess"
    assert status["result_url"] == payload["result_url"]

    result = client.get(payload["result_url"])
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["recording_id"] == recording_id
    assert body["stage"] == "artifacts"
    assert body["artifacts"], "низкий порог peak-to-peak должен дать зоны"
    assert body["band_hz"] == [1.0, 40.0] or body["band_hz"] is None
    assert body["channels"] == meta["channels"]


def test_preprocess_result_is_scoped_to_recording(client, edf_file):
    """Результат нельзя вытащить по чужому/неизвестному id — 404."""
    meta = _upload(client, edf_file)
    created = client.post(
        f"{_PREFIX}/recordings/{meta['recording_id']}/preprocess", data={"stage": "filter"},
    ).json()
    _wait_finished(client, created["job_id"])

    wrong = client.get(f"{_PREFIX}/recordings/other/preprocess/{created['job_id']}")
    assert wrong.status_code == 404

    unknown = client.get(f"{_PREFIX}/recordings/{meta['recording_id']}/preprocess/nope")
    assert unknown.status_code == 404


def test_preprocess_validates_band_and_epoch_length(client, edf_file):
    """Понятные 400 до запуска задачи: половина полосы и длина вне списка."""
    meta = _upload(client, edf_file)
    url = f"{_PREFIX}/recordings/{meta['recording_id']}/preprocess"

    half_band = client.post(url, data={"stage": "filter", "band_min": "1"})
    assert half_band.status_code == 400
    assert "band_min и band_max" in half_band.json()["detail"]

    inverted = client.post(url, data={"stage": "filter", "band_min": "40", "band_max": "1"})
    assert inverted.status_code == 400
    assert "меньше" in inverted.json()["detail"]

    bad_epoch = client.post(url, data={"stage": "epochs", "epoch_length_ms": "123"})
    assert bad_epoch.status_code == 400
    assert "epoch_length_ms" in bad_epoch.json()["detail"]


def test_preprocess_unknown_recording_is_404(client):
    response = client.post(f"{_PREFIX}/recordings/nope/preprocess", data={"stage": "filter"})
    assert response.status_code == 404


def test_filter_stage_cleaning_reports_interpolation(tmp_path, edf_file):
    """Опции очистки стадии filter → отчёт «что сделано» + метрика до/после."""
    recording = _register(tmp_path, edf_file)

    result = run_preprocess(
        recording, settings,
        PreprocessParams(stage="filter", bad_channels=["C3"], interpolate_bads=True),
        progress=lambda *_, **__: None,
    )

    clean = result["clean"]
    assert clean["interpolated_channels"] == ["C3"]
    # Метрика «до/после» присутствует (сплайн может слегка повысить p95 —
    # числа показывают динамику, а не гарантируют убывание)
    assert clean["amplitude_p95_uv_before"] is not None
    assert clean["amplitude_p95_uv_after"] is not None


def test_filter_stage_ssp_warns_in_result(tmp_path, edf_file):
    """SSP-метод помечен предупреждением — UI обязан его показать."""
    recording = _register(tmp_path, edf_file)

    result = run_preprocess(
        recording, settings,
        PreprocessParams(stage="filter", clean_method="ssp"),
        progress=lambda *_, **__: None,
    )

    assert any("SSP" in warning for warning in result["warnings"])


def test_artifacts_stage_returns_qc_numbers(tmp_path, edf_file):
    """Стадия artifacts отдаёт числа QC и светофор записи (шаг 2.2/N10)."""
    recording = _register(tmp_path, edf_file)

    result = run_preprocess(
        recording, settings,
        PreprocessParams(stage="artifacts", run_ica=False),
        progress=lambda *_, **__: None,
    )

    assert 0.0 <= result["good_data_percent"] <= 100.0
    assert isinstance(result["artifact_share_by_kind"], dict)
    assert all(name in result["channels"] for name in result["bad_channels"])
    # Светофор записи: SNR, мёртвые каналы и вердикт по категориям
    assert result["snr_db_median"] is None or isinstance(result["snr_db_median"], float)
    assert all(name in result["channels"] for name in result["dead_channels"])
    assert result["record_status"] in ("ok", "warn", "bad")
    assert isinstance(result["record_status_reasons"], list)


def test_reject_channels_filters_service_drop_log_entries():
    """Служебные записи drop_log виновниками не считаются — только каналы записи."""
    names = ["Fp1", "Fp2"]
    assert _reject_channels(("Fp2", "TOO_SHORT"), names) == ["Fp2"]
    assert _reject_channels(("NO_DATA", "Fp1"), names) == ["Fp1"]
    assert _reject_channels(("USER",), names) == []
    assert _reject_channels(("EQUALIZED_COUNTS",), names) == []
    assert _reject_channels((), names) == []


def test_epochs_stage_returns_reject_channels_without_amplitude_reject(tmp_path, spike_edf):
    """Отбраковка — только BAD_-аннотации: каналы-виновники пусты, порога в ответе нет.

    Amplitude reject MNE отключён (``reject=None``): ``drop_log`` несёт описание
    аннотации (``BAD_…``), а не имя канала, поэтому ``rejected_epoch_channels``
    приходит с пустыми списками — рамки в треках не рисуются, зоны детекторов
    видны отдельными слоями. Всплеск 250 мкВ на первом канале ловит z-score
    (дефолтный порог, его зона целиком внутри эпохи 5): отброшена только эпоха 5,
    соседние остаются — «все отброшены» дал бы ошибку стадии.
    """
    recording = _register(tmp_path, spike_edf)

    result = run_preprocess(
        recording, settings,
        PreprocessParams(
            stage="epochs", epoch_length_ms=1000.0,
            pp_threshold_uv=1e9, flat_line_uv=-1.0,
        ),
        progress=lambda *_, **__: None,
    )

    assert result["rejected_epochs"] == [5]
    assert result["rejected_epoch_channels"] == [{"index": 5, "channels": []}]
    assert "reject_threshold_uv" not in result
