/**
 * Зеркало общих параметров URL и сторов (3.2б, N33): ссылка воспроизводит
 * состояние — запись, полосу фильтра диполей и срезы MNI.
 *
 * Правила:
 * - **URL → сторы — один раз при старте**: параметры чужой ссылки применяются
 *   до того, как пользователь что-то нажал; дальше источник истины — сторы;
 * - **сторы → URL** — подписки на три стора + debounce (слайдер среза шлёт
 *   частые обновления): перезапись через `replace`, история не засоряется;
 * - **смена секции не теряет параметры**: `Link` в рейле не несёт `search`,
 *   поэтому смена `location.pathname` дозаписывает зеркало из сторов;
 * - правка параметра по-прежнему **не** запускает расчёт (`docs/ui.md`,
 *   «Обработка — только по кнопке»): синхронизация только пишет URL.
 */
import { useEffect, useRef } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { PROJECTION_PLANES } from '@/shared/lib/mriProjections'
import { parseSharedUrl, serializeSharedUrl, type SharedUrlState } from '@/shared/lib/urlState'
import { openRecordingById, useEdfRecording } from '@/shared/state/edfRecording'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { useDipoleParams } from '@/shared/state/dipoleParams'

/** Пауса перед перезаписью URL: слайдер и ввод частят, история — `replace`. */
const SYNC_DEBOUNCE_MS = 250

/** Ключи, которыми владеет синхронизация (чужие query-параметры не трогаем). */
const SHARED_KEYS = ['rec', 'band', 'slice'] as const

/** Текущее «зеркало»: что сторы хотели бы видеть в URL. */
function currentSharedState(): SharedUrlState {
  const recording = useEdfRecording.getState().recording
  const band = useDipoleCalc.getState().params.filterBandHz
  return {
    rec: recording?.recording_id ?? null,
    band: band === null ? null : [band[0], band[1]],
    slices: useDipoleParams.getState().params.slices,
  }
}

export function UrlSync() {
  const location = useLocation()
  const [, setSearchParams] = useSearchParams()
  const setSearchRef = useRef(setSearchParams)
  setSearchRef.current = setSearchParams
  // Актуальный location под рукой и в эффектах с пустыми deps, и в подписках:
  // в тестах (MemoryRouter) он, а не window.location, — источник истины
  const locationRef = useRef(location)
  locationRef.current = location
  const appliedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // URL → сторы: однократное применение при старте приложения
  useEffect(() => {
    if (appliedRef.current) return
    appliedRef.current = true
    const shared = parseSharedUrl(locationRef.current.search)
    if (shared.rec) void openRecordingById(shared.rec)
    if (shared.band) useDipoleCalc.getState().setFilterBand(shared.band)
    if (shared.slices) {
      const { setSlice } = useDipoleParams.getState()
      for (const plane of PROJECTION_PLANES) {
        const mm = shared.slices[plane]
        if (mm !== undefined) setSlice(plane, mm)
      }
    }
  }, [])

  // сторы → URL: debounce-перезапись + дозапись после смены секции
  useEffect(() => {
    const flush = () => {
      timerRef.current = null
      const current = locationRef.current.search.replace(/^\?/, '')
      const next = new URLSearchParams(current)
      for (const key of SHARED_KEYS) next.delete(key)
      for (const [key, value] of serializeSharedUrl(currentSharedState())) {
        next.set(key, value)
      }
      if (next.toString() === current) return
      setSearchRef.current(next, { replace: true })
    }
    const schedule = () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(flush, SYNC_DEBOUNCE_MS)
    }

    const unsubscribes = [
      useEdfRecording.subscribe(schedule),
      useDipoleParams.subscribe(schedule),
      useDipoleCalc.subscribe(schedule),
    ]
    // Первый проход (маунт) и любая смена секции: Link не несёт search —
    // дописываем параметры из сторов обратно
    schedule()
    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe())
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    }
  }, [location.pathname])

  return null
}