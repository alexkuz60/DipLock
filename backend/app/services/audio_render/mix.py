"""Шины и сведение «Нейромузыки»: миксы L/C/R по карте монтажа, треки, мастер.

Сцена партитуры (концепция, docs/rules/neuromusic.md):

* **L/C/R** — три виртуальных шины по карте монтажа 10-20: левые электроды
  (нечётный номер), правые (чётный) и срединные (``Fz``/``Cz``/``Pz``/``Oz``…).
  Срединные идут в оба канала стерео с весом 0.5 (ТЗ §2) — «центр сцены»;
  распределение даёт ``services/channel_mix`` (это и есть карта монтажа,
  проверено тестами: см. ``tests/test_channel_mix.py``).
* Веса шины — **равные внутри группы** (среднее): ``mono = mean(L) + 0.5·mean(C)``.
  Формально это ``w @ eeg`` с ``w[i] = 1/n_group`` — ядро (``core.band_stem``)
  не меняется. Сумма весов **всех** срединных по обоим buss = 1.0 (по 0.5 на
  шину — ТЗ §2); для одиночного срединного канала вклад по buss тоже 1.0.
  Потомки «весов из топокарт» (sqrt-мощности) — задел на будущее, сейчас
  баланс задают нормализацией треков и гейнами.
* **Нормализация трека** к RMS = −18 dBFS + базовое усиление ``boost_db``
  (приёмка 05.10.2026: «внешние анализаторы показывают запас −22…−18 дБ —
  увеличивать сигнал на +6…+12 дБ»): все семь «инструментов» должны быть
  различимы в общей партитуре (критерий приёмки M6) — иначе тихий γ-high
  растворяется, а δ-крошечка перекрывает всё. Повышение улучшает SQNR
  записи PCM_24 (главный шум выхода — квантование 24 бит; ресемпл ядра идёт
  в float64 и SNR не портит — тест ``test_pcm24_sqnr_improves_with_boost``).
  Сверху — пользовательский гейн (dB, диапазон −24…+12 валидируется в API).

  **Потолок трека:** после масштабирования пик каждого трека прижимается к
  −1 dBFS (0.891) — при boost пик может перевалить шкалу, а PCM_24 клипует
  значения >1.0. Это масштабирование вниз (ТЗ §3: без компрессоров), его
  величина возвращается в ``applied_gain_db``/``rms_out_dbfs`` партитуры.

  **Отклонение от ТЗ §3.1 (обосновано):** буквальный потолок «суммарного гейна
  +24 дБ от исходного уровня» неприменим к ЭЭГ в вольтах: нормализация
  микровольтового трека до −18 dBFS требует ~76 дБ, все полосы упёрлись бы в
  потолок и баланс инструментов пропал. Защита «от раздувания тихой γ-high»
  реализована **порогом тишины**: трек с RMS ниже ``AUDIO_SILENCE_FLOOR_V``
  (математическая тишина/мёртвые каналы, а не физиологически тихая полоса)
  не нормализуется вовсе.
* **Мастер** = сумма треков; контроль пика — масштабирование **вниз** к
  −1 dBFS (0.891), без компрессоров/лимитеров (ТЗ §3). Тихий мастер не
  раздувается: потолок — только сверху.
"""
import numpy as np

from app.core.config import settings
from app.services.channel_mix import channel_group, channel_hemisphere

# Канонический порядок схемы 10-20 (единый источник — core/config, не дублировать).
# Фактический порядок каналов записи фиксируется в sidecar (channel_order).
CHANNEL_ORDER: tuple[str, ...] = tuple(settings.standard_channels)

# Уровень нормализации трека и потолок мастера (−1 dBFS = 0.891).
TRACK_RMS_DBFS = -18.0
PEAK_CEILING = 0.891

# Порог тишины (В RMS): ниже — трек не нормализуется (защита от раздувания
# «пустой» полосы). Физиологический сигнал ЭЭГ ≥ 0.1 мкВ = 1e-7 В, поэтому
# 1 нВ заведомо ниже любого сигнала и выше численного шума фильтрации.
AUDIO_SILENCE_FLOOR_V = 1e-9

# Пользовательский гейн трека (dB): диапазон валидируется в API рендера.
GAIN_MIN_DB = -24.0
GAIN_MAX_DB = 12.0

# Базовое усиление полосовых стерео-треков (dB): приёмка 05.10.2026 —
# «при создании полосовых стерео-ЭЭГ увеличивать сигнал на +6…+12 дБ»
# (запас RMS −22…−18 дБ, видимый внешними анализаторами). Сдвигает целевой
# уровень трека: −18 + boost; мастер вырастает насколько позволяет потолок
# пика (сумма семи полос с высоким crest-фактором почти всегда упирается
# в −1 dBFS — RMS мастера вверх двигает только снижение crest, не boost).
BOOST_MIN_DB = 0.0
BOOST_MAX_DB = 12.0
BOOST_DEFAULT_DB = 6.0


def bus_weights(
    channels: list[str],
) -> tuple[np.ndarray, np.ndarray, dict[str, list[str]]]:
    """Веса шин L и R для канонического ``w @ eeg``: (K,) + (K,) и группы каналов.

    Правила (ТЗ §2): левые только в L, правые только в R, срединные — 0.5 в
    оба buss; веса неотрицательные; ``w = 1/n_group`` (среднее по группе,
    0.5 — для срединных). Канал вне схемы 10-20 — ошибка входа: молча
    терять электроды нельзя, рендер не должен «петь» неполный оркестр.
    """
    index = {name: i for i, name in enumerate(channels)}
    left: list[str] = []
    right: list[str] = []
    mid: list[str] = []
    strangers: list[str] = []
    for name in channels:
        if channel_group(name) is None:
            strangers.append(name)
            continue
        hemisphere = channel_hemisphere(name)
        if hemisphere == "left":
            left.append(name)
        elif hemisphere == "right":
            right.append(name)
        else:
            mid.append(name)
    if strangers:
        raise ValueError(
            f"Каналы вне схемы монтажа 10-20 не могут войти в микс: {', '.join(strangers)}"
        )
    if not left and not right and not mid:
        raise ValueError("Нет каналов 10-20 для построения микса L/C/R")

    w_left = np.zeros(len(channels), dtype=np.float64)
    w_right = np.zeros(len(channels), dtype=np.float64)
    for name in left:
        w_left[index[name]] = 1.0 / len(left)
    for name in right:
        w_right[index[name]] = 1.0 / len(right)
    for name in mid:
        # Срединные — по 0.5 в оба buss: сумма долей канала ровно 1.0.
        w_left[index[name]] = 0.5 / len(mid)
        w_right[index[name]] = 0.5 / len(mid)
    return w_left, w_right, {"left": left, "right": right, "midline": mid}


def track_rms(track: np.ndarray) -> float:
    """Среднеквадратичный уровень трека (оба канала), линейно."""
    if track.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(track, dtype=np.float64))))


def normalize_track(
    track: np.ndarray, gain_db: float = 0.0, boost_db: float = 0.0,
    loudness_db: float = 0.0,
) -> tuple[np.ndarray, float | None, float | None]:
    """Трек → RMS −18 dBFS + boost + психоакустическая поправка + гейн.

    Возвращает (трек, gain, rms).

    Трек с уровнем ниже ``AUDIO_SILENCE_FLOOR_V`` считается пустым и не
    нормализуется (иначе математическая тишина раздулась бы до −18 dBFS) —
    ``gain``/``rms`` = None, сигнал остаётся нулём.

    ``boost_db`` — базовое усиление полос (0…12): целевой RMS = −18 + boost.
    ``loudness_db`` — статическое смещение ISO 226 (``loudness``): полоса
    звучит на своих аудио-частотах ×128, ухо слышит их неравномерно — поправка
    выравнивает субъективную громкость инструментов (приёмка 05.10.2026,
    ``services/audio_render/loudness.py``). После масштабирования пик трека
    прижимается к ``PEAK_CEILING`` (0.891) — при boost громкий трек мог бы
    перевалить 1.0 и клипнуть в PCM_24; это масштабирование вниз, его
    величина возвращается в ``gain``/``rms``.
    """
    current = track_rms(track)
    if current < AUDIO_SILENCE_FLOOR_V:
        return np.zeros_like(track), None, None
    target = 10.0 ** ((TRACK_RMS_DBFS + boost_db + loudness_db) / 20.0)
    total_db = 20.0 * float(np.log10(target / current)) + gain_db
    out = track * (10.0 ** (total_db / 20.0))
    peak = float(np.max(np.abs(out))) if out.size else 0.0
    if peak > PEAK_CEILING:
        scale = PEAK_CEILING / peak
        out *= scale
        total_db += 20.0 * float(np.log10(scale))
    return out, total_db, track_rms(out)


def master_mix(tracks: list[np.ndarray]) -> np.ndarray:
    """Мастер-трек: сумма нормированных треков (float64, без компрессии)."""
    if not tracks:
        raise ValueError("Нет треков для сведения")
    master = np.zeros_like(tracks[0], dtype=np.float64)
    for track in tracks:
        master += np.asarray(track, dtype=np.float64)
    return master


def normalize_group(
    tracks: list[np.ndarray], gain_db: float = 0.0, boost_db: float = 0.0,
    loudness_db: float = 0.0,
) -> tuple[list[np.ndarray], float | None, float | None]:
    """Один масштаб на группу треков одной полосы (вариант «Монтаж»: 4 ряда).

    Групповой гейн — принципиальное отличие от :func:`normalize_track`:
    RMS считается по **объединённой энергии** всех треков группы и общий
    множитель приводит её к целевому уровню (−18 + boost + ISO 226), а
    потолок ``PEAK_CEILING`` применяется по **максимальному пику группы** —
    так относительные уровни рядов внутри полосы (фронт/тыл/лево/право)
    сохраняются точно: тихий ряд остаётся тихим, громкий — громким. Отдельная
    нормализация каждого ряда (как ``normalize_track``) выровняла бы ряды
    по громкости и убила бы пространственный контраст сцены.

    Тишина **всей группы** (ниже ``AUDIO_SILENCE_FLOOR_V``) → нули без
    раздувания (как в ``normalize_track``). Возвращает
    ``(треки, gain, rms)``: gain/rms по группе (``None`` при тишине).
    """
    if not tracks:
        raise ValueError("Нет треков для нормализации")
    sizes = sum(track.size for track in tracks)
    energy = sum(float(np.sum(np.square(track, dtype=np.float64))) for track in tracks)
    current = float(np.sqrt(energy / sizes)) if sizes else 0.0
    if current < AUDIO_SILENCE_FLOOR_V:
        return [np.zeros_like(track) for track in tracks], None, None
    target = 10.0 ** ((TRACK_RMS_DBFS + boost_db + loudness_db) / 20.0)
    total_db = 20.0 * float(np.log10(target / current)) + gain_db
    scale = 10.0 ** (total_db / 20.0)
    out = [track * scale for track in tracks]
    peak = max((float(np.max(np.abs(track))) for track in out), default=0.0)
    if peak > PEAK_CEILING:
        down = PEAK_CEILING / peak
        out = [track * down for track in out]
        total_db += 20.0 * float(np.log10(down))
    group_rms = float(np.sqrt(
        sum(float(np.sum(np.square(track, dtype=np.float64))) for track in out) / sizes,
    ))
    return out, total_db, group_rms


def apply_peak_ceiling(master: np.ndarray) -> float:
    """Масштабирует мастер вниз к −1 dBFS (0.891); возвращает применённый множитель."""
    peak = float(np.max(np.abs(master))) if master.size else 0.0
    if peak <= PEAK_CEILING or peak == 0.0:
        return 1.0
    master *= PEAK_CEILING / peak
    return PEAK_CEILING / peak
