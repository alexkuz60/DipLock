"""Психоакустика «Нейромузыки»: кривые равной громкости ISO 226:2003.

Нормализация всех треков к одному RMS даёт равенство **электрическое**, а не
субъективное: слух слышит частоты неравномерно («яма» 2–4 кГц — резонанс
слухового канала, глухие басы), поэтому середина аудиоспектра (alpha/beta
после ×128 = 1–4 кГц) воспринимается чересчур громко, а delta (64–256 Гц)
— тихо (приёмка 05.10.2026, `docs/rules/neuromusic.md` §«Психоакустика»).

Модуль считает **статические гейны-смещения** целевого RMS трека: полоса
трека звучит на своих аудио-частотах (×128), значит и поправка берётся по
кривой на аудио-диапазоне полосы::

    offset(band) = среднее SPL(полоса) − SPL(1 кГц) по лог-сетке
    target_rms(band) = −18 + boost + offset(band)   # mix.normalize_track

Положительный offset (глухая для уха полоса) — подъём, отрицательный
(чувствительная «яма») — опускание. Это **эквалайзер-компенсация, не
динамика**: гейны статические и детерминированы (ТЗ §3 запрещает
компрессоры/лимитеры; динамическая тонкомпенсация не используется — уровень
прослушивания неизвестен, зависимость от громкости зафиксирована в docs).

Формула и таблицы — ISO 226:2003 (α(f), L_U(f), L_T(f) на 29 частотах
20 Гц … 12.5 кГц + формула A_f/L_p из стандарта; сверено с двумя открытыми
эталонными реализациями, тест на 1 кГц и точку 100 Гц/60 фон). Выше 12.5 кГц
(до 20 кГц) таблицы продолжаются повтором пороговой строки 20 Гц — так же,
как в известной реализации ISO226 (chummersone): стандарт выше 12.5 кГц
не даёт данных, но краю high_gamma (16.4 кГц) нужна конечная поправка.
Сторонние аудиобиблиотеки (librosa — запрещён ТЗ) не используются.
"""
from collections.abc import Mapping, Sequence

import numpy as np
from scipy.interpolate import PchipInterpolator

from app.services.audio_render.mix import PEAK_CEILING

# Диапазон опорного уровня прослушивания (вопрос приёмки 05.10.2026: параметр
# «фон» в API/UI). ISO 226 валиден 0…90 фон; для музыки берём 60…90.
LOUDNESS_PHON_MIN = 60.0
LOUDNESS_PHON_MAX = 90.0
LOUDNESS_PHON_DEFAULT = 75.0

# «Яма» середины слуха: полосы, чей **аудио**-диапазон (×128) целиком лежит
# в 0.5…4 кГц — при наших freq_bands это θ (512–1024), α (1024–2048),
# β (2048–4096 Гц). Именно их выравнивает автобаза (стратегия A приёмки).
PIT_AUDIO_HZ = (500.0, 4096.0)

# Таблицы ISO 226:2003 (29 точек стандарта, 20 Гц … 12.5 кГц).
_FREQS = np.array([
    20.0, 25.0, 31.5, 40.0, 50.0, 63.0, 80.0, 100.0, 125.0, 160.0, 200.0,
    250.0, 315.0, 400.0, 500.0, 630.0, 800.0, 1000.0, 1250.0, 1600.0, 2000.0,
    2500.0, 3150.0, 4000.0, 5000.0, 6300.0, 8000.0, 10000.0, 12500.0,
])
_ALPHA = np.array([
    0.532, 0.506, 0.480, 0.455, 0.432, 0.409, 0.387, 0.367, 0.349, 0.330,
    0.315, 0.301, 0.288, 0.276, 0.267, 0.259, 0.253, 0.250, 0.246, 0.244,
    0.243, 0.243, 0.243, 0.242, 0.242, 0.245, 0.254, 0.271, 0.301,
])
_LU = np.array([
    -31.6, -27.2, -23.0, -19.1, -15.9, -13.0, -10.3, -8.1, -6.2, -4.5,
    -3.1, -2.0, -1.1, -0.4, 0.0, 0.3, 0.5, 0.0, -2.7, -4.1, -1.0, 1.7,
    2.5, 1.2, -2.1, -7.1, -11.2, -10.7, -3.1,
])
_TF = np.array([
    78.5, 68.7, 59.5, 51.1, 44.0, 37.5, 31.5, 26.5, 22.1, 17.9, 14.4, 11.4,
    8.6, 6.2, 4.4, 3.0, 2.2, 2.4, 3.5, 1.7, -1.3, -4.2, -6.0, -5.4, -1.5,
    6.0, 12.6, 13.9, 12.3,
])

# Логарифмическая сетка усреднения offset'а внутри октавы полосы.
_BAND_GRID_POINTS = 32


def _interpolators() -> tuple[PchipInterpolator, PchipInterpolator, PchipInterpolator]:
    """PCHIP-интерполяторы α, L_U, L_T по таблице стандарта (+ 20 кГц)."""
    # Продление до 20 кГц повтором пороговой строки 20 Гц (см. докстринг).
    freqs = np.concatenate([_FREQS, [20000.0]])
    alpha = np.concatenate([_ALPHA, [_ALPHA[0]]])
    lu = np.concatenate([_LU, [_LU[0]]])
    tf = np.concatenate([_TF, [_TF[0]]])
    return (
        PchipInterpolator(freqs, alpha),
        PchipInterpolator(freqs, lu),
        PchipInterpolator(freqs, tf),
    )


_ALPHA_I, _LU_I, _TF_I = _interpolators()


def equal_loudness_spl_db(freqs: np.ndarray | list[float], phon: float) -> np.ndarray:
    """SPL (дБ) кривой равной громкости ``phon`` на частотах ``freqs`` (Гц).

    ISO 226:2003: ``A_f = 4.47e-3·(10^(0.025·L_N) − 1.15) +
    (0.4·10^((L_T+L_U)/10 − 9))^α``; ``L_p = (10/α)·log10(A_f) − L_U + 94``.
    На 1 кГц результат совпадает с ``phon`` (определение фона).
    """
    if not 0.0 <= phon <= 90.0:
        raise ValueError(f"ISO 226 валиден для 0…90 фон, получено {phon}")
    f = np.asarray(freqs, dtype=np.float64)
    if f.size and (f.min() < 20.0 or f.max() > 20000.0):
        raise ValueError("ISO 226 валиден для частот 20 Гц … 20 кГц")
    alpha = np.asarray(_ALPHA_I(f), dtype=np.float64)
    lu = np.asarray(_LU_I(f), dtype=np.float64)
    tf = np.asarray(_TF_I(f), dtype=np.float64)
    a_f = 4.47e-3 * (10.0 ** (0.025 * phon) - 1.15) + (
        0.4 * 10.0 ** ((tf + lu) / 10.0 - 9.0)
    ) ** alpha
    return (10.0 / alpha) * np.log10(a_f) - lu + 94.0


def band_loudness_offsets(
    freq_bands: Mapping[str, tuple[float, float]],
    phon: float,
    pitch_steps: int,
) -> dict[str, float]:
    """Смещения целевого RMS по полосам для равной субъективной громкости.

    ``freq_bands`` — полосы ЭЭГ (Гц) из ``settings.freq_bands``; аудио-частоты
    треков = полоса × 2**``pitch_steps``. Offset = среднее по лог-сетке
    ``SPL(полоса) − SPL(1 кГц)``: знак «+» — ухо слышит полосу тише (поднять),
    «−» — чувствительная зона (опустить). Полосы вне ISO 226 (крайние края
    после ×128 вне 20 Гц … 20 кГц) получают offset от зажатой частоты.
    """
    reference = float(equal_loudness_spl_db([1000.0], phon)[0])
    scale = float(2**pitch_steps)
    offsets: dict[str, float] = {}
    for band, (fmin, fmax) in freq_bands.items():
        audio_min = float(np.clip(fmin * scale, 20.0, 20000.0))
        audio_max = float(np.clip(fmax * scale, 20.0, 20000.0))
        grid = np.geomspace(audio_min, audio_max, _BAND_GRID_POINTS)
        spl = equal_loudness_spl_db(grid, phon)
        offsets[band] = float(np.mean(spl) - reference)
    return offsets


def pit_bands(
    freq_bands: Mapping[str, tuple[float, float]], pitch_steps: int,
) -> list[str]:
    """Полосы «ямы» середины: аудиодиапазон ×2**``pitch_steps`` ⊆ ``PIT_AUDIO_HZ``."""
    low, high = PIT_AUDIO_HZ
    scale = float(2**pitch_steps)
    return [
        name
        for name, (fmin, fmax) in freq_bands.items()
        if fmin * scale >= low and fmax * scale <= high
    ]


def autobase_db(
    base_db: float,
    crests_db: Mapping[str, float],
    offsets: Mapping[str, float],
    pit: Sequence[str],
) -> float:
    """Ограничивает базу рендера потолком «ямы» — стратегия A (приёмка 05.10.2026).

    Потолок полосы: ``bound = 20·log10(PEAK_CEILING) − crest`` — максимум RMS,
    пока пик не упирается в −1 dBFS. Пока цель ``база + offset`` выше bound,
    RMS определяется только crest'ом и **ни boost, ни компенсация не работают**
    (приёмочный прогон 05.10.2026: «все в потолке» → дельта 0.00 дБ). Базу
    нужно опустить ниже «худшего» ``(bound − offset)`` по полосам «ямы» — тогда
    θ/α/β выходят из потолка и выравниваются по перцептиву ``P = база``
    (середина ровно, басы/верх остаются crest-ограниченными — без компрессии
    поднять их нельзя).

    ``crests_db`` — crest-факторы стемов (20·log10(peak/rms), инвариантен
    нормализации), считаются в ``render``. Тихие/неконечные стемы в расчёт
    не участвуют (crest не рушит базу).
    """
    ceiling_db = 20.0 * float(np.log10(PEAK_CEILING))
    limits = [
        ceiling_db - float(crests_db[band]) - float(offsets[band])
        for band in pit
        if band in crests_db and band in offsets and np.isfinite(crests_db[band])
    ]
    if not limits:
        return base_db
    return float(min(base_db, min(limits)))
