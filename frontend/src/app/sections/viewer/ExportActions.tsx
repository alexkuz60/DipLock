/**
 * Кнопки экспорта окна вьюера (срез 2.8): PNG-снапшот треков и CSV сигналов.
 *
 * Экспорт идёт ровно по нажатию и **на клиенте**: данные уже в браузере, сервер
 * не пересчитывает то, что видно на экране. Кнопки берут состояние у вьюера
 * (окно, видимые каналы, canvas'ы треков, слои), поэтому живут рядом с ним, а не
 * в тулс-хедере раздела.
 *
 * Ошибка кодирования PNG показывается текстом: пустой файл хуже отказа, а в
 * окружениях без canvas (`toBlob` отсутствует) это реальный случай.
 */
import { FileSpreadsheet, ImageDown } from 'lucide-react'
import { useState } from 'react'
import type { SignalFrame } from '@/shared/lib/signalFrame'
import { canvasToBlob, downloadBlob, downloadText } from '@/shared/lib/download'
import { drawSnapshot, exportFileName, windowCsv } from '@/shared/lib/exportWindow'
import type { TimeWindow } from '@/shared/lib/viewerMath'
import type { ArtifactZone, EpochCell } from '@/shared/lib/viewerLayers'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { IconButton } from '@/shared/ui/IconButton'
import { StatusPill } from '@/shared/ui/StatusPill'

export type ExportActionsProps = {
  frame: SignalFrame
  window: TimeWindow
  /** Видимые каналы в порядке монтажа — ровно они попадут в файлы */
  channels: string[]
  /** Ширина области треков на экране, px (та же геометрия, что у слоёв и курсора) */
  trackWidth: number
  /** Canvas'ы треков по имени канала (uPlot рисует сигнал только в canvas) */
  canvases: Record<string, HTMLCanvasElement | null>
  zones: readonly ArtifactZone[]
  epochs: readonly EpochCell[]
  showEpochBoundaries: boolean
  showDroppedEpochs: boolean
  amplitudeMode: 'shared' | 'per_channel'
  amplitudeScaleUv: number
}

/** Подпись источника сигнала: уровень пирамиды или полный сигнал (демо) */
function sourceLabel(frame: SignalFrame): string {
  return frame.level > 0 ? `огибающая уровня ×${frame.level}` : 'полный сигнал'
}

export function ExportActions({
  frame,
  window: timeWindow,
  channels,
  trackWidth,
  canvases,
  zones,
  epochs,
  showEpochBoundaries,
  showDroppedEpochs,
  amplitudeMode,
  amplitudeScaleUv,
}: ExportActionsProps) {
  const filename = useEdfRecording((state) => state.recording?.filename)
  const [error, setError] = useState<string | null>(null)

  const span = timeWindow.t1 - timeWindow.t0
  const factor = span > 0 && frame.durationSec > 0 ? Math.round(frame.durationSec / span) : 1
  const stem = filename ?? 'demo-signal'
  const hasData = channels.length > 0 && frame.times.length > 0

  const subtitle = [
    `Окно ${timeWindow.t0.toFixed(2)}–${timeWindow.t1.toFixed(2)} с (×${factor})`,
    sourceLabel(frame),
    `каналов: ${channels.length}`,
    amplitudeMode === 'shared' ? `шкала ±${amplitudeScaleUv} мкВ` : 'шкала автоматическая',
  ].join(' · ')

  function handleCsv() {
    try {
      setError(null)
      downloadText(
        exportFileName(stem, timeWindow, frame.level, 'csv'),
        windowCsv(frame, timeWindow, channels),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить CSV')
    }
  }

  async function handlePng() {
    try {
      setError(null)
      const canvas = drawSnapshot({
        title: filename ?? 'Демо-сигнал (без записи)',
        subtitle,
        window: timeWindow,
        trackWidth,
        tracks: channels.map((name) => ({ name, canvas: canvases[name] ?? null })),
        zones,
        epochs,
        showZones: true,
        showEpochBoundaries,
        showDroppedEpochs,
        scaleLabel:
          amplitudeMode === 'shared' ? `общая шкала ±${amplitudeScaleUv} мкВ` : 'авто по каналу',
      })
      downloadBlob(exportFileName(stem, timeWindow, frame.level, 'png'), await canvasToBlob(canvas))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось собрать PNG')
    }
  }

  return (
    <>
      <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
      <IconButton
        disabled={!hasData}
        tooltip={`Скачать PNG окна: треки, зоны и эпохи одним изображением (${subtitle})`}
        label="Скачать PNG окна"
        onClick={() => void handlePng()}
        icon={<ImageDown className="size-4" />}
      />
      <IconButton
        disabled={!hasData}
        tooltip={`Скачать CSV окна: строка на (корзина × канал) с min/max в мкВ — ${subtitle}`}
        label="Скачать CSV окна"
        onClick={handleCsv}
        icon={<FileSpreadsheet className="size-4" />}
      />
      {error ? (
        <StatusPill tone="danger" title={`Экспорт окна: ${error}`}>
          Экспорт: {error}
        </StatusPill>
      ) : null}
    </>
  )
}
