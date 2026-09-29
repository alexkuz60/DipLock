/**
 * 3D-вид раздела «Диполи» (срез 3.5, Niivue): том fsaverage и диполи поверх.
 *
 * Что здесь происходит:
 *
 * * **том** — `GET /surface/mri/volume/T1.mgz` (сервер отдаёт файл «как есть»,
 *   белый список + ETag; URL с `?v=` из `/meta` — `mri_volumes`);
 * * **режимы Niivue** — мультисрез и 3D-рендер из коробки (`SLICE_TYPE`);
 * * **диполи** — connectome-узлами Niivue: позиция в мировых мм тома
 *   (`mniToWorldMm`, affine из `/meta`), цвет кодирует амплитуду момента;
 * * **совместный курсор**: кроссхейр Niivue шлёт координаты в стор проекций
 *   (`onCursor` → `projectionCursor`), и обратно — положение курсора из
 *   проекций ставит кроссхейр (петля разрывается сравнением координат).
 *
 * Компонент не считает геометрию сам — вся арифметика в
 * `shared/lib/brain3d.ts` (чистая, покрыта Vitest без WebGL). Niivue в jsdom
 * мокается: рендер проверяется только на живом сервере (WebGL).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Niivue, SLICE_TYPE } from '@niivue/niivue'
import type { MriVolumeRef } from '@/shared/api/types'
import type { DipoleLayer } from '@/shared/lib/dipolePoints'
import { connectomeNodes, nodeColorScale, t1VolumeUrl } from '@/shared/lib/brain3d'
import type { MniVector } from '@/shared/lib/mriProjections'
import { Button } from '@/shared/ui/Button'
import { StatusPill } from '@/shared/ui/StatusPill'
import { cx } from '@/shared/ui/cx'

export type Brain3DProps = {
  /** Ссылка на тома из `/meta` (`null` — метаданные недоступны, вид не рисуется) */
  volumes: MriVolumeRef | null
  /** Видимый слой диполей (после порога «КД») — узлы connectome */
  layer: DipoleLayer
  /** Совместный курсор проекций: мировые мм (MNI) положения кроссхейра */
  cursor: MniVector | null
  /** Клик/движение кроссхейра Niivue → в стор проекций (мм MNI) */
  onCursor: (point: MniVector | null) => void
}

/** Допуск «то не изменилась»: гистерезис против петли кроссхейр ↔ стор. */
const CURSOR_TOLERANCE_MM = 0.5

export function Brain3D({ volumes, layer, cursor, onCursor }: Brain3DProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const niivueRef = useRef<Niivue | null>(null)
  const cursorRef = useRef<MniVector | null>(cursor)
  const onCursorRef = useRef(onCursor)
  const [sliceType, setSliceType] = useState<SLICE_TYPE>(SLICE_TYPE.RENDER)
  const [status, setStatus] = useState<string>('Загрузка тома…')
  const [failed, setFailed] = useState(false)

  onCursorRef.current = onCursor
  cursorRef.current = cursor

  // affine и URL — из /meta: раздел не догадывается о пространстве тома сам
  const affine = volumes?.affine ?? null
  const t1Url = useMemo(() => (volumes ? t1VolumeUrl(volumes) : null), [volumes])
  // Узлы и шкала — чистая арифметика (мемо: пересчёт только при смене слоя/affine)
  const nodes = useMemo(
    () => (volumes ? connectomeNodes(layer, affine, nodeColorScale(layer)) : []),
    [layer, affine, volumes],
  )

  // Инициализация Niivue: один экземпляр на жизнь компонента (canvas фиксирован)
  useEffect(() => {
    if (!canvasRef.current || !t1Url) return undefined
    let disposed = false
    const nv = new Niivue({ show3Dcrosshair: true })
    niivueRef.current = nv
    nv.attachToCanvas(canvasRef.current)
    // Кроссхейр Niivue → совместный курсор проекций (мировые мм = мм MNI)
    nv.onLocationChange = (location: unknown) => {
      const mm = (location as { mm?: number[] } | null)?.mm
      if (!Array.isArray(mm) || mm.length < 3 || !mm.every(Number.isFinite)) return
      const current = cursorRef.current
      if (
        current &&
        Math.abs(current.x - mm[0]) <= CURSOR_TOLERANCE_MM &&
        Math.abs(current.y - mm[1]) <= CURSOR_TOLERANCE_MM &&
        Math.abs(current.z - mm[2]) <= CURSOR_TOLERANCE_MM
      ) {
        return // свой же отклик — петля замкнулась
      }
      onCursorRef.current({ x: mm[0], y: mm[1], z: mm[2] })
    }
    setStatus('Загрузка тома…')
    nv.loadVolumes([{ url: t1Url, name: 'T1.mgz', colorMap: 'gray' }])
      .then(() => {
        if (disposed) return
        setFailed(false)
        setStatus('T1 загружен')
      })
      .catch((error: unknown) => {
        if (disposed) return
        setFailed(true)
        setStatus(`Том не загрузился: ${error instanceof Error ? error.message : String(error)}`)
      })
    return () => {
      disposed = true
      niivueRef.current = null
    }
    // t1Url меняется только при смене версии ассета — пересоздание редкое
  }, [t1Url])

  // Режим вида Niivue (мультисрез / 3D-рендер)
  useEffect(() => {
    niivueRef.current?.setSliceType(sliceType)
    niivueRef.current?.drawScene()
  }, [sliceType])

  // Узлы диполей: перезагрузка connectome при смене слоя (тонн точек не бывает)
  useEffect(() => {
    const nv = niivueRef.current
    if (!nv || failed || nodes.length === 0) return
    try {
      nv.loadConnectome({
        name: 'dipoles',
        nodes: nodes.map((node) => ({
          name: node.name,
          x: node.x,
          y: node.y,
          z: node.z,
          colorValue: node.colorValue,
          sizeValue: node.sizeValue,
        })),
        edges: [],
        nodeColormap: 'warmiron',
        nodeColormapNegative: '',
        nodeMinColor: 0,
        nodeMaxColor: 1,
        nodeScale: 3,
        edgeColormap: 'warmiron',
        edgeColormapNegative: '',
        edgeMin: 0,
        edgeMax: 1,
        edgeScale: 1,
      })
      nv.drawScene()
    } catch {
      // Connectome — вспомогательный слой: его сбой не должен ломать вид тома
    }
  }, [nodes, failed])

  // Совместный курсор: положение из проекций → кроссхейр Niivue
  useEffect(() => {
    const nv = niivueRef.current
    if (!nv || !cursor) return
    try {
      nv.scene.crosshairPos = nv.mm2frac([cursor.x, cursor.y, cursor.z])
      nv.drawScene()
    } catch {
      // Том ещё не готов — кроссхейр встанет при следующем движении курсора
    }
  }, [cursor])

  if (!volumes) {
    return (
      <div
        data-testid="brain3d-unavailable"
        className="flex min-h-40 flex-1 items-center justify-center"
      >
        <StatusPill tone="warn">
          3D-вид недоступен: сервер не прислал ссылку на том (mri_volumes в /meta)
        </StatusPill>
      </div>
    )
  }

  return (
    <div data-testid="brain3d" className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-testid="brain3d-mode-multiplanar"
          title="Мультисрез: три плоскости тома (как в проекциях, но в объёме)"
          className={cx(
            sliceType === SLICE_TYPE.MULTIPLANAR && 'border-accent/60 bg-accent-soft',
          )}
          onClick={() => setSliceType(SLICE_TYPE.MULTIPLANAR)}
        >
          Мультисрез
        </Button>
        <Button
          data-testid="brain3d-mode-render"
          title="3D-рендер: объёмная отрисовка тома с диполи (узлами connectome)"
          className={cx(sliceType === SLICE_TYPE.RENDER && 'border-accent/60 bg-accent-soft')}
          onClick={() => setSliceType(SLICE_TYPE.RENDER)}
        >
          3D-рендер
        </Button>
        <StatusPill
          tone={failed ? 'warn' : 'neutral'}
          title="Том отдаёт сервер «как есть» (GET /surface/mri/volume), ETag по файлам fsaverage"
        >
          {status}
        </StatusPill>
        <StatusPill
          tone="neutral"
          title="Кроссхейр 3D и курсор проекций — одно состояние: метка видна на всех фигурах"
        >
          {`Диполей в 3D: ${nodes.length}`}
        </StatusPill>
      </div>
      <canvas
        ref={canvasRef}
        data-testid="brain3d-canvas"
        className="min-h-0 w-full flex-1 rounded-lg border border-border bg-bg-1"
      />
    </div>
  )
}
