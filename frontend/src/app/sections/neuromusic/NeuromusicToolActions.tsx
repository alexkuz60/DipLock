/**
 * Тулс-хедер «Нейромузыки»: запуск рендера одной кнопкой-иконкой.
 *
 * Параметры живут в правом сайдбаре («Опции раздела»), прогресс и плеер —
 * в рабочей области: кнопка только стартует стор (`useNeuromusic.start()` —
 * запись и параметры он читает сам). Правка параметра рендер не запускает
 * (правило UI), без открытой записи кнопка выключена с объяснением.
 */
import { AudioLines } from 'lucide-react'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { useNeuromusic } from '@/shared/state/neuromusic'
import { IconButton } from '@/shared/ui/IconButton'

export function NeuromusicToolActions() {
  const recording = useEdfRecording((state) => state.recording)
  const busy = useNeuromusic((state) => state.busy)
  const status = useNeuromusic((state) => state.status)
  const start = useNeuromusic((state) => state.start)
  const running = busy || status?.status === 'running'

  return (
    <IconButton
      icon={<AudioLines className="size-5" />}
      label="Создать аудио"
      tooltip={
        !recording
          ? 'Создать аудио: сначала откройте ЭЭГ-запись в разделе EDF'
          : running
            ? 'Идёт рендер партитуры…'
            : 'Создать аудио: рендер партитуры ЭЭГ → стерео (7 треков ×128 + мастер)'
      }
      disabled={!recording || running}
      onClick={() => void start()}
    />
  )
}
