/**
 * 3D-вид «Куб» раздела «Диполи» (срез 3.13): срезы МРТ на трёх стенках куба,
 * облако диполей внутри — совмещённый вид по фигуре MNE
 * (`auto_tutorials/inverse/20_dipole_fit.html`).
 *
 * Вид заменил режимы Niivue «Мультисрез» и «3D-рендер» (правка 19.10.2026):
 * мультисрез дублировал 2D-проекции, а 3D-рендер прятал облако за черепом.
 * Вместе с Niivue ушла и его легенда connectome — вертикальная колонка диполей
 * на правом крае канваса; выбор диполя теперь идёт через **индикатор эпох**
 * (пакет эпохи приходит пропом `focus`) и клик по точке облака.
 *
 * Устройство вида:
 *
 * * **стенки** — картинки срезов по общему состоянию «Срезы MNI» (`slices`: те
 *   же значения, что в 2D-проекциях и панели «Опции»); когда в фокусе несколько
 *   диполей (пакет из нескольких полос, анимация нескольких полос) — проекции
 *   силуэта мозга (MIP), срезы честны только для одного диполя
 *   (`resolveWallsMode`, ручной тумблер «Стенки» переопределяет авто-правило);
 * * **фокус** — один выделенный диполь даёт три красных линии проекции на
 *   стенки с крестами (как на фигуре MNE), пакет эпохи — линии цветом полосы
 *   каждой точки; остальное облако приглушается;
 * * **анимация** — общий кадр воспроизведения (`PlaybackFrameProvider`):
 *   маркеры всех полос «Полосы в анимации и облаке» со шлейфами, цветом своей
 *   полосы (та же механика, что у проекций);
 * * **слои** — чекбоксы панели «Опции»: точки, векторы, спираль момента, кадр
 *   и картинки стенок (срез МРТ / границы мозга) включаются и выключаются;
 * * **курсор** — маркер совместного курсора проекций (мм MNI); сам куб пишет в
 *   стор только кликом по точке (`onPickPoint`), перетаскивание занято поворотом.
 *
 * Поворот — перетаскиванием (азимут/тангаж), «Сбросить ракурс» возвращает
 * стартовый. Геометрия — чистая (`shared/lib/dipoleCube.ts`), рисование —
 * `dipoleCubeDraw.ts`; здесь состояние, события и загрузка картинок стенок.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { RotateCcw } from 'lucide-react'
import type { MriSliceRef } from '@/shared/api/types'
import {
  CUBE_DEFAULT_VIEW,
  cubeProjector,
  cubeWalls,
  cssTokenOf,
  resolveWallsMode,
  type CubeSize,
  type CubeView,
  type CubeWallsSetting,
} from '@/shared/lib/dipoleCube'
import { DOT_HIT_RADIUS_PX, type DipoleLayer, type DipolePoint } from '@/shared/lib/dipolePoints'
import type { MniVector, ProjectionPlane, SliceTriplet } from '@/shared/lib/mriProjections'
import { mriMipUrl, mriSliceUrl } from '@/shared/lib/mriSlices'
import { SPIRAL_SENSE_COLORS } from '@/shared/lib/spiralTrail'
import { themeColor } from '@/shared/lib/theme'
import { layerVisible, type DipoleLayerId } from '@/shared/state/dipoleParams'
import { Button } from '@/shared/ui/Button'
import { SegmentedControl, type SegmentedOption } from '@/shared/ui/SegmentedControl'
import { StatusPill } from '@/shared/ui/StatusPill'
import { drawCubeScene, type CubeColors, type CubeScene } from './dipoleCubeDraw'
import { usePlaybackFrame } from './playbackClock'
import { useSpiralTrail } from './useSpiralTrail'

/** Клик против перетаскивания: движение меньше порога — это выбор точки. */
const DRAG_THRESHOLD_PX = 3

/** Чувствительность поворота: градусы азимута/тангажа на пиксель перетаскивания. */
const DRAG_SENSITIVITY = 0.5

/** Тангаж зажимается ниже полюсов: на ±90° базис камеры вырождается. */
const MAX_ELEVATION_DEG = 89

const WALLS_OPTIONS: SegmentedOption<CubeWallsSetting>[] = [
  {
    value: 'auto',
    label: 'Авто',
    title: 'Стенки сами выбирают вид: срезы — когда в фокусе один диполь, силуэт — когда несколько',
  },
  {
    value: 'slices',
    label: 'Срезы',
    title: 'Всегда срезы МРТ по «Срезам MNI» (общим с 2D-проекциями)',
  },
  {
    value: 'silhouette',
    label: 'Силуэт',
    title: 'Всегда проекции силуэта мозга (glass brain) — координата среза не нужна',
  },
]

/** Цвета сцены: токены темы резолвятся в готовые цвета (canvas не знает `var(...)`). */
function cubeColors(doc: Document): CubeColors {
  const color = (token: string, fallback: string): string => themeColor(doc, token, fallback)
  const spiral = (sense: keyof CubeColors['spiral'], fallback: string): string =>
    color(cssTokenOf(SPIRAL_SENSE_COLORS[sense]), fallback)
  return {
    bg: color('--color-bg-1', '#101821'),
    wall: color('--color-bg-2', '#17222e'),
    border: color('--color-border', '#2c3a4d'),
    text: color('--color-fg-2', '#8695a8'),
    accent: color('--color-accent', '#4da3ff'),
    danger: color('--color-danger', '#ff6b6b'),
    dipole: color('--color-mri-dipole', '#ffb454'),
    vector: color('--color-mri-dipole-vector', '#b25a5a'),
    white: color('--color-mri-dipole-point', '#ffffff'),
    spiral: {
      ccw: spiral('ccw', '#2f9e6f'),
      cw: spiral('cw', '#d6493e'),
      none: spiral('none', '#7d8590'),
    },
  }
}

export type DipoleCubeProps = {
  /** Ссылки на ассеты срезов/MIP из `/meta` (`mri_slices`; `null` — вид без картинок) */
  mri: MriSliceRef | null
  /** Срезы стенок — общее состояние «Срезы MNI» (2D-проекции и панель «Опции») */
  slices: SliceTriplet
  /** Видимость слоёв (чекбоксы панели «Опции») */
  visibility: Record<DipoleLayerId, boolean>
  /** Облако диполей (после порогов отображения, с `overlapCount`) */
  layer: DipoleLayer
  /** Точки в фокусе: [выделенная точка] или пакет выбранной эпохи (индикатор эпох) */
  focus: DipolePoint[]
  /** Совместный курсор проекций, мм MNI (`null` — курсора нет) */
  cursor: MniVector | null
  /** Клик по точке облака (`point`) или мимо точек (`null` — снять выделение) */
  onPickPoint: (point: DipolePoint | null) => void
  /** Плей активен — облако приглушается (как в проекциях) */
  dimmed: boolean
}

export function DipoleCube({
  mri,
  slices,
  visibility,
  layer,
  focus,
  cursor,
  onPickPoint,
  dimmed,
}: DipoleCubeProps) {
  const frame = usePlaybackFrame()
  const spiral = useSpiralTrail()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  /** Картинки стенок: кэш по URL (повторная перерисовка — без запросов). */
  const imagesRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const [, setImagesReady] = useState(0)
  const [view, setView] = useState<CubeView>(CUBE_DEFAULT_VIEW)
  const [wallsSetting, setWallsSetting] = useState<CubeWallsSetting>('auto')
  const [size, setSize] = useState<CubeSize>({ width: 0, height: 0 })

  /**
   * Кадры анимации — те же фильтры, что у `FrameMarker` проекций: слабые точки
   * скрыты порогами отображения, но их шлейфы остаются.
   */
  const activeFrames = useMemo(
    () =>
      (frame?.frames ?? []).filter(
        (bandFrame) => bandFrame.point !== null || bandFrame.trail.length > 0,
      ),
    [frame],
  )
  /** Кадр показан: слой «Кадр воспроизведения» включён и есть что рисовать. */
  const frameActive = activeFrames.length > 0 && layerVisible(visibility, 'playback')
  /** Режим стенок: авто-правило «один диполь — срезы, несколько — силуэт». */
  const wallsMode = resolveWallsMode(wallsSetting, {
    focusCount: focus.length,
    frameBandCount: activeFrames.length,
    frameActive,
  })

  /** URL картинок стенок: срезы по «Срезам MNI» или силуэт (MIP) — по режиму. */
  const wallImages = useMemo(() => {
    const urls = new Map<ProjectionPlane, string>()
    if (!mri) return urls
    for (const wall of cubeWalls()) {
      urls.set(
        wall.plane,
        wallsMode === 'silhouette'
          ? mriMipUrl(mri, wall.plane)
          : mriSliceUrl(mri, wall.plane, slices[wall.plane]),
      )
    }
    return urls
  }, [mri, slices, wallsMode])

  // Загрузка картинок стенок: одна на URL, ставит перерисовку по готовности
  useEffect(() => {
    for (const url of wallImages.values()) {
      if (imagesRef.current.has(url)) continue
      const image = new Image()
      imagesRef.current.set(url, image)
      image.onload = () => setImagesReady((stamp) => stamp + 1)
      image.src = url
    }
  }, [wallImages])

  /**
   * Размер канваса — по контейнеру (`ResizeObserver`). В jsdom его нет: размер
   * остаётся нулевым и отрисовка не начинается (тесты подменяют наблюдателя).
   */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      setSize({
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      })
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

  /**
   * Отрисовка — один кадр на каждый рендер: входы (ракурс, слои, срезы, фокус,
   * кадр анимации) меняются ровно тогда, когда перерисовка нужна, а часы
   * анимации шлют кадр через контекст 60 раз в секунду — канвас следует за ним
   * без React-перерисовок облака (точки рисует `drawCubeScene`).
   */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.width <= 0 || size.height <= 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const pixelWidth = Math.round(size.width * dpr)
    const pixelHeight = Math.round(size.height * dpr)
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight
    const imageOf = (plane: ProjectionPlane): HTMLImageElement | undefined => {
      const url = wallImages.get(plane)
      return url ? imagesRef.current.get(url) : undefined
    }
    const scene: CubeScene = {
      size,
      projector: cubeProjector(view, size),
      wallsMode,
      wallImages: {
        axial: imageOf('axial'),
        sagittal: imageOf('sagittal'),
        coronal: imageOf('coronal'),
      },
      showSliceImages: layerVisible(visibility, 'mri'),
      showSilhouette: layerVisible(visibility, 'brain'),
      points: layer.points,
      showPoints: layerVisible(visibility, 'dipoles'),
      showVectors: layerVisible(visibility, 'vectors'),
      spiral,
      showSpiral: layerVisible(visibility, 'spiral'),
      frames: activeFrames,
      showPlayback: frameActive,
      focus,
      cursor,
      // Облако приглушается в Плей и под фокусом — движение и выделение читаются
      dimmed: dimmed || focus.length > 0,
      colors: cubeColors(canvas.ownerDocument),
    }
    drawCubeScene(ctx, scene, dpr)
  })


  /** Перетаскивание мышью: азимут/тангаж; движение меньше порога — это клик. */
  const dragRef = useRef<{ x: number; y: number; view: CubeView; moved: boolean } | null>(null)

  /** Ближайшая точка облака под курсором (радиус — как у клика на проекциях). */
  const hitTest = (x: number, y: number): DipolePoint | null => {
    const projector = cubeProjector(view, size)
    let best: DipolePoint | null = null
    let bestDistance = DOT_HIT_RADIUS_PX
    for (const point of layer.points) {
      const projected = projector.project(point.position)
      const distance = Math.hypot(projected.x - x, projected.y - y)
      if (distance <= bestDistance) {
        best = point
        bestDistance = distance
      }
    }
    return best
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = { x: event.clientX, y: event.clientY, view, moved: false }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    drag.moved = true
    setView({
      azimuthDeg: drag.view.azimuthDeg + dx * DRAG_SENSITIVITY,
      elevationDeg: Math.max(
        -MAX_ELEVATION_DEG,
        Math.min(MAX_ELEVATION_DEG, drag.view.elevationDeg - dy * DRAG_SENSITIVITY),
      ),
    })
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (drag?.moved) return
    const rect = event.currentTarget.getBoundingClientRect()
    onPickPoint(hitTest(event.clientX - rect.left, event.clientY - rect.top))
  }

  return (
    <div
      data-testid="dipole-cube"
      data-azimuth={Math.round(view.azimuthDeg)}
      data-elevation={Math.round(view.elevationDeg)}
      className="flex min-h-0 flex-1 flex-col gap-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          layout="inline"
          label="Стенки"
          value={wallsSetting}
          options={WALLS_OPTIONS}
          onChange={setWallsSetting}
          hint="Срезы МРТ по «Срезам MNI» (тем же, что в 2D-проекциях) честны для одного диполя; пакет из нескольких полос и анимация полос живут в разных срезах — им стенки показывают силуэт мозга"
        />
        <StatusPill
          tone="neutral"
          title="Авто-правило: один диполь в фокусе — срезы MNI, несколько — силуэт мозга; ручной выбор «Стенки» переопределяет его"
        >
          {`Стенки: ${wallsMode === 'slices' ? 'срезы MNI' : 'силуэт мозга'}`}
        </StatusPill>
        <StatusPill
          tone="neutral"
          title="Облако цветом своей полосы; выбор диполя — индикатором эпох или кликом по точке"
        >
          {`Диполей в 3D: ${layer.points.length}`}
        </StatusPill>
        {mri === null ? (
          <StatusPill tone="warn">
            Срезы недоступны: сервер не прислал ссылки (mri_slices в /meta)
          </StatusPill>
        ) : null}
        <Button
          icon={<RotateCcw className="size-4" />}
          title="Вернуть стартовый ракурс (вид спереди-сверху-справа)"
          onClick={() => setView(CUBE_DEFAULT_VIEW)}
        >
          Сбросить ракурс
        </Button>
      </div>
      <canvas
        ref={canvasRef}
        data-testid="dipole-cube-canvas"
        className="min-h-0 w-full flex-1 touch-none rounded-lg border border-border bg-bg-1"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
    </div>
  )
}

