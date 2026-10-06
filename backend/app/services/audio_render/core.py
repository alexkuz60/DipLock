"""Математическое ядро «Нейромузыки»: полоса ЭЭГ (500 Гц) → стерео-трек 48 кГц.

Порядок операций зафиксирован ТЗ (§1) и меняться **не может**:

1. ``mono = w @ eeg`` — взвешенная сумма каналов полосы (веса — из ``mix``);
2. ``hilbert(mono)`` — аналитический сигнал (``scipy.signal.hilbert`` уже
   возвращает его, руками через FFT не собираем);
3. ресемпл ×96 **по Re/Im отдельно** (``resample_poly``, kaiser(10)) — до
   питч-шифта, иначе частоты ×2**``pitch_steps`` уйдут за Найквист 500 Гц
   (алиасинг);
4. питч-шифт ×2**``pitch_steps`` = ``pitch_steps`` последовательных комплексных
   квадратов (``u**2``): фаза умножается на 2**``pitch_steps``, ``y = a·Re(u)``
   (дефолт 7 → ×128 = семь октав; выбор 5/6/7 октав — параметр запроса
   ``octave_shift``, эксперимент 06.10.2026);
5. ``stack([yL, yR])`` → стерео-трек формы ``(N*96, 2)``.

Запрещено (ловушки из ТЗ §5): фазовый вокодер/гранулярные методы, интерполяция
модуля/фазы вместо Re/Im, zero-order hold, питч **после** ресемплера.

Запрещено (точность): float32 в тракте — фаза после квадратов чувствительна
к округлениям; на вход подаётся float64. Входные массивы не мутируются.
"""
import numpy as np
from scipy.signal import hilbert, resample_poly

# Частотная сетка ядра: 500 Гц × 96 = 48000 Гц; октавы — параметр
# ``pitch_steps`` (5/6/7, дефолт 7 → ×128).
FS_EEG = 500
FS_AUDIO = 48000
RESAMPLE_UP = 96
PITCH_STEPS = 7  # дефолт: 2**7 = 128 (×128, семь октав)
# Допустимые значения выбора транспонирования (запрос ``octave_shift``).
PITCH_STEPS_CHOICES: tuple[int, ...] = (5, 6, 7)

# Окно ресемплера (жёстко по ТЗ: kaiser с beta=10).
RESAMPLE_WINDOW: tuple[str, float] = ("kaiser", 10.0)

# Относительный eps нормировки фазы: 1e-12 от пика огибающей, но не меньше 1e-30
# (иначе на полностью нулевом входе деление на ноль). Точки с малой огибающей
# не требуют маски фазы: выход домножается на a и вклад таких отсчётов ~0.
_PHASE_EPS_REL = 1e-12
_PHASE_EPS_FLOOR = 1e-30


def band_stem(
    eeg_band: np.ndarray, w_left: np.ndarray, w_right: np.ndarray,
    pitch_steps: int = PITCH_STEPS,
) -> np.ndarray:
    """Стерео-трек одной полосы: (K, N) float64 @500 Гц → (N*96, 2) @48000 Гц.

    ``w_left``/``w_right`` — веса каналов полосы (длины K): ``mono = w @ eeg``.
    Разные шины (L/R) дают разные моно-сигналы → после ядра стерео-эффект
    панорамы; одинаковые веса дают идентичные каналы (моно-случай).

    ``pitch_steps`` — число октав транспонирования (5/6/7 → ×32/×64/×128,
    дефолт 7): фаза умножается ровно на 2**``pitch_steps`` — столько же
    последовательных квадратов, форма выхода не зависит от выбора.
    """
    data = np.asarray(eeg_band, dtype=np.float64)
    if data.ndim != 2:
        raise ValueError(f"eeg_band должен быть (K, N), получено {data.shape}")
    steps = int(pitch_steps)
    if steps < 1:
        raise ValueError(f"pitch_steps должен быть >= 1, получено {pitch_steps}")
    weights = [np.asarray(w_left, dtype=np.float64), np.asarray(w_right, dtype=np.float64)]
    for w in weights:
        if w.shape != (data.shape[0],):
            raise ValueError(f"веса должны иметь длину K={data.shape[0]}, получено {w.shape}")

    stems: list[np.ndarray] = []
    for w in weights:
        mono = w @ data
        z = hilbert(mono)
        # Ресемпл ×96: Re и Im независимо (комплексный resample_poly не меняет
        # математику, но эталон ТЗ требует явного разноса вещественной/мнимой).
        z48 = (
            resample_poly(z.real, RESAMPLE_UP, 1, window=RESAMPLE_WINDOW)
            + 1j * resample_poly(z.imag, RESAMPLE_UP, 1, window=RESAMPLE_WINDOW)
        )
        a = np.abs(z48)
        eps = _PHASE_EPS_REL * max(float(a.max()), _PHASE_EPS_FLOOR)
        u = z48 / np.maximum(a, eps)
        for _ in range(steps):  # дефолт 7 → 2**7 = 128
            u = u * u
        stems.append(a * u.real)

    stem = np.stack(stems, axis=1)
    # Длина ресемплинга — контракт ТЗ (§5): все треки обязаны иметь N*96 строк.
    expected = (data.shape[1] * RESAMPLE_UP, 2)
    if stem.shape != expected:
        raise AssertionError(f"Неверная длина трека: {stem.shape}, ожидалось {expected}")
    return stem
