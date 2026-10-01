/**
 * Согласование длины эпохи/окна спектра с частотной полосой (п.4 плана в
 * `todo.md`; §8.3 `docs/strategy/01-signal-quality.md`).
 *
 * Две половины одного правила читаются вместе (обсуждение 01.10.2026):
 *
 * - **≥ 2 периодов нижней частоты полосы** — требование к достоверности пика:
 *   короче — «пик» оказывается куском монотонного подъёма, а не волной. Таблица
 *   §8.3 нормирована на δ 1 Гц (для 0.5 Гц strict ≥ 4 с, но 4000 мс в
 *   `epoch_lengths_ms` не добавляются — решение владельца 01.10.2026), поэтому
 *   нижняя частота в формуле не опускается ниже 1 Гц;
 * - **≥ 3C отсчётов** (C — каналов) — требование к обратимости ковариации:
 *   18 каналов → ≥ 54 отсчётов, при 250 Гц — ≥ 216 мс; короче — ковариационная
 *   матрица вырождена и координаты обратной задачи случайны.
 *
 * Обе половины — **предупреждением, а не запретом** («предупреждать, а не
 * запрещать»): `epochRuleWarnings` возвращает готовые тексты, панели их рисуют.
 * `recommendedEpochLengthMs` — авто-подстановка «короче для высоких» при смене
 * пресета полосы (короткая эпоха переживает больше эпох: +16…+23 п.п. по замеру
 * `backend/scripts/epoch_survival.py`); ручная правка после подстановки не
 * блокируется — перезаписывает её только следующая смена пресета.
 */

/** Сведения о записи для правила N ≥ 3C (без записи — половина правила молчит) */
export type EpochSignalInfo = {
  /** Частота дискретизации, Гц */
  sfreq?: number | null
  /** Число каналов расчёта (монтаж 10-20; fallback — каналы файла) */
  nChannels?: number | null
}

/**
 * Минимум длины по правилу «≥ 2 периодов нижней частоты», мс.
 *
 * `null` — полосы нет («без фильтра»): правило к ней неприменимо. Нижняя
 * частота нормируется на 1 Гц (§8.3): для δ 0.5 Гц минимум 2000 мс, а не 4000.
 */
export function periodMinMs(bandLoHz: number | null | undefined): number | null {
  if (bandLoHz === null || bandLoHz === undefined || !Number.isFinite(bandLoHz) || bandLoHz <= 0) {
    return null
  }
  return 2000 / Math.max(bandLoHz, 1)
}

/**
 * Минимум длины по правилу «≥ 3C отсчётов» для ковариационной матрицы», мс.
 *
 * `null` — sfreq или число каналов неизвестны (запись не загружена): половина
 * правила не выдумывается без данных записи.
 */
export function covarianceMinMs(
  sfreq: number | null | undefined,
  nChannels: number | null | undefined,
): number | null {
  if (
    sfreq === null ||
    sfreq === undefined ||
    nChannels === null ||
    nChannels === undefined ||
    !Number.isFinite(sfreq) ||
    sfreq <= 0 ||
    nChannels <= 0
  ) {
    return null
  }
  return (3 * nChannels * 1000) / sfreq
}

/**
 * Авто-длина эпохи для выбранной полосы: кратчайшая из `lengths`, которая
 * проходит обе половины правила (периоды — по полосе, N ≥ 3C — по записи).
 *
 * `null` — подстановки нет: полосы нет («без фильтра») или список длин пуст
 * (метаданные ещё не пришли). Если не проходит ни одна длина списка, берётся
 * максимальная — предупреждение панели объяснит, что её всё равно мало.
 */
export function recommendedEpochLengthMs(
  bandLoHz: number | null | undefined,
  lengths: readonly number[],
  signal?: EpochSignalInfo,
): number | null {
  const period = periodMinMs(bandLoHz)
  if (period === null || lengths.length === 0) return null
  const covariance = covarianceMinMs(signal?.sfreq, signal?.nChannels)
  const min = covariance === null ? period : Math.max(period, covariance)
  const fitting = lengths.filter((value) => value >= min - 1e-9)
  if (fitting.length === 0) return Math.max(...lengths)
  return Math.min(...fitting)
}

export type EpochRuleWarningInput = {
  /** Длина эпохи или окна спектра, мс */
  lengthMs: number
  /** Нижняя частота полосы, Гц; `null` — период-правило не применяется */
  bandLoHz?: number | null
  /** Слово в начале сообщения: «Эпоха» (по умолчанию) или «Окно» */
  subject?: string
  sfreq?: number | null
  nChannels?: number | null
}

/**
 * Тексты предупреждений для контролей «Длина эпохи» и «Окно STFT».
 *
 * Пустой массив — обе половины правила выполнены, панель ничего не показывает.
 * Пороговые значения проверяются с допуском `1e-9`, чтобы длина «ровно на
 * минимуме» не считалась нарушением.
 */
export function epochRuleWarnings(input: EpochRuleWarningInput): string[] {
  const subject = input.subject ?? 'Эпоха'
  const { lengthMs } = input
  const warnings: string[] = []

  const period = periodMinMs(input.bandLoHz)
  if (period !== null && lengthMs < period - 1e-9) {
    const lo = input.bandLoHz as number
    const basis = lo < 1 ? `${lo} Гц, нормировано на 1 Гц` : `${lo} Гц`
    warnings.push(
      `${subject} ${fmtNumber(lengthMs)} мс короче двух периодов нижней частоты полосы ` +
        `(${basis} — минимум ${fmtNumber(period)} мс): достоверность пика под вопросом, ` +
        `низкие частоты волной не укладываются.`,
    )
  }

  const covariance = covarianceMinMs(input.sfreq, input.nChannels)
  if (covariance !== null && lengthMs < covariance - 1e-9) {
    const samples = Math.round((lengthMs * (input.sfreq as number)) / 1000)
    const needSamples = 3 * (input.nChannels as number)
    warnings.push(
      `${subject} ${fmtNumber(lengthMs)} мс = ${samples} отсчётов при ${input.sfreq} Гц ` +
        `меньше 3C (3 × ${input.nChannels} = ${needSamples} отсчётов — минимум ` +
        `${fmtNumber(Math.ceil(covariance))} мс): обратимость ковариации под вопросом, ` +
        `матрица вырождена.`,
    )
  }

  return warnings
}

/** Целые миллисекунды без хвоста `.0` (153.846… → 154, 2000 → 2000) */
function fmtNumber(value: number): string {
  return String(Math.round(value))
}
