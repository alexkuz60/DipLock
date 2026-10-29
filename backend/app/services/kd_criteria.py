"""КД — критерий годности диполя (С0): вердикт и базис нормировки (concept.md §3).

Один владелец правила «момент ≥ X % максимума **своего поддиапазона** И
GOF ≥ порога **своей полосы**»: раньше оно жило только в
``results_store._persist_report``, а пакетный прогон (С1, ``dipole_batch``)
считает те же вердикты для кластеров и сопоставления полос — вторая копия
формулы разъехалась бы молча.

Правила (``docs/rules/results-db.md`` §8.4 п.5, ``docs/data-blocks.md`` §2.2):

* без порогов методики (``kd_moment_share``/``kd_gof_min``) вердикт —
  честный ``None`` («не оценено»), а не ``False``;
* базис (``kd_basis``) несёт оба базиса нормировки — иначе числа разных
  поддиапазонов молча встанут в один ряд;
* максимум момента — **внутри своей полосы** (``moment_max_nam``);
* порог GOF — **по-полосный** (29.10.2026): значение прогона →
  ``cfg.kd_gof_min_by_band`` → ``cfg.kd_gof_min`` → экспертная интерполяция
  ``default_gof_min`` (якоря δ/γ — ``core/config.py`` KD_GOF_DEFAULT_*).
"""
import math
from typing import Any

from app.core.config import (
    KD_GOF_BASIS,
    KD_GOF_DEFAULT_DELTA,
    KD_GOF_DEFAULT_GAMMA,
    KD_GOF_DEFAULT_MAX,
    KD_GOF_DEFAULT_MIN,
    KD_MOMENT_BASIS,
    Settings,
)

# Имя внутреннего ключа точек пакета/отчёта, где лежат точки одной полосы
# (плоские словари ``DipoleScanPointOut``: ``amplitude_nam``, ``gof``).


def default_gof_min(lo_hz: float, hi_hz: float, cfg: Settings) -> float | None:
    """Экспертный дефолт порога GOF полосы — лог-линейная интерполяция.

    Якоря — центры полос δ и γ конфига со значениями ``KD_GOF_DEFAULT_DELTA`` /
    ``KD_GOF_DEFAULT_GAMMA`` (середины экспертных диапазонов 85–95 % и 75–80 %,
    консультация методики 29.10.2026); между и вне якорей — лог-линейно по
    центру полосы (геометрическое среднее границ), зажим к
    [``KD_GOF_DEFAULT_MIN``, ``KD_GOF_DEFAULT_MAX``]. ``None`` — якоря нет
    (δ/γ отсутствуют в ``freq_bands``): порог остаётся честно незаданным.
    """
    delta = cfg.freq_bands.get("delta")
    gamma = cfg.freq_bands.get("gamma")
    if not delta or not gamma:
        return None
    anchor_lo = math.sqrt(float(delta[0]) * float(delta[1]))
    anchor_hi = math.sqrt(float(gamma[0]) * float(gamma[1]))
    if anchor_lo <= 0 or anchor_hi <= anchor_lo:
        return None
    center = math.sqrt(max(lo_hz, 1e-9) * max(hi_hz, 1e-9))
    t = (math.log10(center) - math.log10(anchor_lo)) / (
        math.log10(anchor_hi) - math.log10(anchor_lo)
    )
    value = KD_GOF_DEFAULT_DELTA + t * (KD_GOF_DEFAULT_GAMMA - KD_GOF_DEFAULT_DELTA)
    return max(KD_GOF_DEFAULT_MIN, min(KD_GOF_DEFAULT_MAX, value))


def resolve_gof_min(
    cfg: Settings,
    *,
    band_key: str | None = None,
    band_hz: tuple[float, float] | None = None,
    gof_min: float | None = None,
    gof_min_by_band: dict[str, float] | None = None,
) -> float | None:
    """Порог GOF полосы: значение прогона → карта прогона → методика → дефолт.

    Явный ``gof_min`` (одиночный расчёт) и ``gof_min_by_band`` (карта формы
    пакета/отчёта) перекрывают порог методики (``cfg.kd_gof_min_by_band`` →
    ``cfg.kd_gof_min``); полоса без записи везде получает экспертную
    интерполяцию ``default_gof_min``.
    """
    if gof_min is not None:
        return float(gof_min)
    for source in (gof_min_by_band, cfg.kd_gof_min_by_band):
        if source and band_key in source:
            return float(source[band_key])
    if cfg.kd_gof_min is not None:
        return float(cfg.kd_gof_min)
    if band_hz is not None:
        return default_gof_min(float(band_hz[0]), float(band_hz[1]), cfg)
    return None

    if band_hz is not None:
        return default_gof_min(float(band_hz[0]), float(band_hz[1]), cfg)
    return None


def effective_gof_map(
    cfg: Settings, overrides: dict[str, float] | None = None,
) -> dict[str, float]:
    """Фактический по-полосный порог GOF: каталог полос + «свои» ключи карты.

    Каталог — ``freq_bands`` + ``functional_bands``; перекрытие — ``overrides``
    (форма прогона) → ``cfg.kd_gof_min_by_band`` → ``cfg.kd_gof_min`` →
    экспертная интерполяция. Один источник для `/meta` (дефолты полей «Опций
    расчётов диполов») и паспорта критерия манифеста (manifest v3).
    """
    extra: dict[str, float] = dict(overrides or {})
    catalog: dict[str, tuple[float, float]] = {}
    for source in (cfg.freq_bands, cfg.functional_bands):
        for key, bounds in dict(source).items():
            catalog[str(key)] = (float(bounds[0]), float(bounds[1]))
    out: dict[str, float] = {}
    for key, (lo_hz, hi_hz) in catalog.items():
        value = extra.pop(key, None)
        if value is None:
            value = cfg.kd_gof_min_by_band.get(key)
        if value is None:
            value = cfg.kd_gof_min
        if value is None:
            value = default_gof_min(lo_hz, hi_hz, cfg)
        if value is not None:
            out[key] = round(float(value), 6)
    for key, value in extra.items():  # «свои» полосы формы вне каталога
        out[key] = round(float(value), 6)
    return out

def kd_basis_for(
    points: list[dict[str, Any]], cfg: Settings,
    *,
    band_key: str | None = None,
    band_hz: tuple[float, float] | None = None,
    gof_min: float | None = None,
    gof_min_by_band: dict[str, float] | None = None,
    moment_share: float | None = None,
) -> tuple[dict[str, Any], list[int | None], int | None]:
    """Считает базис КД и вердикты точек одной полосы.

    Возвращает ``(kd_basis, verdicts, n_kd_passed)``:

    * ``kd_basis`` — ``{moment_share_x, gof_min, moment_max_nam, moment_basis,
      gof_basis}`` (``KdBasisOut``); ``gof_min`` — **фактически применённый**
      порог полосы (``resolve_gof_min``);
    * ``verdicts`` — по одному на точку: ``1`` — прошёл, ``0`` — нет,
      ``None`` — «не оценено» (пороги методики не заданы);
    * ``n_kd_passed`` — число прошедших; ``None`` — вердикт не считался.
    """
    amplitudes = [
        float(p["amplitude_nam"]) for p in points if p.get("amplitude_nam") is not None
    ]
    moment_max = max(amplitudes) if amplitudes else None
    share = cfg.kd_moment_share if moment_share is None else float(moment_share)
    gof_threshold = resolve_gof_min(
        cfg, band_key=band_key, band_hz=band_hz,
        gof_min=gof_min, gof_min_by_band=gof_min_by_band,
    )
    evaluated = share is not None and gof_threshold is not None and moment_max is not None
    kd_basis: dict[str, Any] = {
        "moment_share_x": share,
        "gof_min": gof_threshold,
        "moment_max_nam": moment_max,
        # Базисы нормировки (concept.md §3): обязательная часть описания порога
        "moment_basis": KD_MOMENT_BASIS,
        "gof_basis": KD_GOF_BASIS,
    }

    verdicts: list[int | None] = []
    for point in points:
        amplitude = point.get("amplitude_nam")
        gof = point.get("gof")
        verdict: int | None = None
        if (
            share is not None and gof_threshold is not None and moment_max is not None
            and amplitude is not None and gof is not None
        ):
            verdict = int(
                float(amplitude) >= share * moment_max
                and float(gof) >= gof_threshold
            )
        verdicts.append(verdict)
    n_kd_passed = sum(v for v in verdicts if v) if evaluated else None
    return kd_basis, verdicts, n_kd_passed


def kd_meta(params: Any) -> dict[str, Any]:
    """Поля КД параметров задачи → ``meta`` файла задачи (паспорт манифеста).

    ``build_manifest`` (manifest v3) читает их, чтобы блок ``criteria`` говорил
    о **фактически** применённых порогах прогона, а не только о дефолтах
    методики. Параметры без полей КД (спектр, препроцессинг) дают пустой dict.
    """
    out: dict[str, Any] = {}
    share = getattr(params, "kd_moment_share", None)
    by_band = getattr(params, "kd_gof_min_by_band", None)
    if share is not None:
        out["kd_moment_share"] = float(share)
    if by_band:
        out["kd_gof_min_by_band"] = {str(k): float(v) for k, v in dict(by_band).items()}
    return out
