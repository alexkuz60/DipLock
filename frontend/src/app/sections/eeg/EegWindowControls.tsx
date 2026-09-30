/**
 * Навигация по окну, зум и амплитудный зум раздела «ЭЭГ» в тулс-хедере.
 *
 * Общая разметка — `shared/ui/ZoomNavControls` (тот же контрол, что в EDF), а
 * состояние у раздела своё: уровень зума и режим навигатора в `eegParams`
 * (расчёт от них не устаревает), шаг режима «Навигация» — `artifactNav`,
 * команда листания — через `eegNav` с монотонным `seq`, потому что окно раздела
 * живёт в состоянии, а не в компоненте: его видят обе половины.
 *
 * Кнопки амплитудного зума (просьба владельца 30.09.2026, «по аналогии с EDF»)
 * шагают шкалу трека по ряду `AMPLITUDE_UV_PER_DIV` той же функцией, что и
 * перетаскивание правой линейки (`stepAmplitudeUv`): «приблизить» уменьшает
 * мкВ/дел (сигнал крупнее), «отдалить» — увеличивает. Кнопка **автозума**
 * подгоняет шкалу под пики видимого окна (`windowMaxAbsUv` → `fitAmplitudeUv`)
 * — аналог «Авто» в EDF. Шкала — параметр просмотра: расчёт не пересчитывается
 * и не устаревает. Текущее значение подписано между кнопками.
 *
 * Данные для автозума берутся из тех же мест, что и у рабочей области:
 * демо-кадр или ближайший загруженный уровень активного слоя
 * (`useSignalLayerFrames`), окно и канал — параметры раздела. Правка не делает
 * запросов: кадр уже в кэше.
 */
import { useQuery } from '@tanstack/react-query'
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import { api } from '@/shared/api/client'
import { channelFrame, channelSourceChannels, resolveChannel } from '@/shared/lib/eegChannels'
import { eegWindow, fitAmplitudeUv, stepAmplitudeUv, windowMaxAbsUv } from '@/shared/lib/eegView'
import { resolveSignalLevel, selectFrame } from '@/shared/lib/signalFrame'
import { TIME_LEVELS, useEegParams } from '@/shared/state/eegParams'
import { useEdfRecording, useSignalLayerFrames } from '@/shared/state/edfRecording'
import { IconButton } from '@/shared/ui/IconButton'
import { ZoomNavControls } from '@/shared/ui/ZoomNavControls'

export function EegWindowControls() {
  const level = useEegParams((state) => state.params.timeLevel)
  const navMode = useEegParams((state) => state.params.navMode)
  const step = useEegParams((state) => state.artifactNav)
  const setParams = useEegParams((state) => state.setParams)
  const requestNav = useEegParams((state) => state.requestNav)
  const amplitudeUv = useEegParams((state) => state.params.amplitudeUv)
  const setAmplitudeUv = useEegParams((state) => state.setAmplitudeUv)
  const windowCenterSec = useEegParams((state) => state.params.windowCenterSec)
  const savedChannel = useEegParams((state) => state.params.channel)
  const recording = useEdfRecording((state) => state.recording)
  const demo = useEdfRecording((state) => state.demo)
  const { frames } = useSignalLayerFrames()

  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => api.meta(signal),
    staleTime: 60_000,
    retry: false,
  })
  const levels = meta.data?.signal_levels?.length ? meta.data.signal_levels : [...TIME_LEVELS]

  // Следующие ступени ряда: на краю совпадают с текущим — кнопка выключается
  const closer = stepAmplitudeUv(amplitudeUv, -1)
  const farther = stepAmplitudeUv(amplitudeUv, 1)

  // Вход автозума: демо-кадр или ближайший загруженный уровень активного слоя —
  // ровно то, что показывает трек (уровень решается как в `EegRecording`)
  const factor = TIME_LEVELS[level] ?? 1
  const autoFrame = demo ?? selectFrame(frames, resolveSignalLevel(factor, levels))
  const canAuto = autoFrame !== null

  /** Подгонка шкалы под пики видимого окна: запросов не делает (кадр в кэше) */
  function handleAutoAmplitude() {
    if (!autoFrame) return
    const demoChannels = demo?.channels ?? []
    const channel = resolveChannel(recording, demoChannels, savedChannel)
    const track = channelFrame(autoFrame, channel, channelSourceChannels(recording, channel))
    const lows = track.min[channel]
    const highs = track.max[channel]
    if (!lows || !highs) return
    const window = eegWindow(autoFrame.durationSec, factor, windowCenterSec)
    const peak = windowMaxAbsUv(track.times, lows, highs, window)
    if (peak > 0) setAmplitudeUv(fitAmplitudeUv(peak))
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <ZoomNavControls
        timeLevel={level}
        navMode={navMode}
        step={step}
        onTimeLevel={(next) => setParams({ timeLevel: next })}
        onNav={requestNav}
        zoomLabel="Зум окна ЭЭГ и спектрограммы"
        zoomTitle="Масштаб по времени: ×1 — вся сессия, ×16 — максимальное приближение (действует на обе половины)"
      />
      <div className="flex items-center gap-1" aria-label="Амплитудный зум трека">
        <IconButton
          label="Увеличить масштаб амплитуды"
          tooltip={
            closer === amplitudeUv
              ? `Шкала уже максимально приближена: ${amplitudeUv} мкВ/дел — минимум ряда`
              : `Сигнал крупнее: ${amplitudeUv} → ${closer} мкВ/дел (то же, что потянуть линейку вверх)`
          }
          icon={<ZoomIn className="size-5" />}
          disabled={closer === amplitudeUv}
          onClick={() => setAmplitudeUv(closer)}
        />
        <span
          title="Шкала трека: мкВ на деление — параметр просмотра, расчёт от неё не устаревает"
          className="tnum rounded-lg border border-border bg-bg-2 px-2 py-1.5 text-sm text-fg-1"
        >
          {amplitudeUv} мкВ/дел
        </span>
        <IconButton
          label="Уменьшить масштаб амплитуды"
          tooltip={
            farther === amplitudeUv
              ? `Шкала уже максимально отдалена: ${amplitudeUv} мкВ/дел — максимум ряда`
              : `Сигнал мельче: ${amplitudeUv} → ${farther} мкВ/дел (то же, что потянуть линейку вниз)`
          }
          icon={<ZoomOut className="size-5" />}
          disabled={farther === amplitudeUv}
          onClick={() => setAmplitudeUv(farther)}
        />
        <IconButton
          label="Автозум амплитуды"
          tooltip="Подогнать шкалу под сигнал видимого окна: ближайшее деление ряда, вмещающее пики (аналог «Авто» в EDF)"
          icon={<Maximize2 className="size-5" />}
          disabled={!canAuto}
          onClick={handleAutoAmplitude}
        />
      </div>
    </div>
  )
}
