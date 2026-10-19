/**
 * Провайдер кадра воспроизведения (срез 3.7): считает часы один раз на раздел и
 * раздаёт кадр проекциям через контекст.
 *
 * Здесь только компонент — сами часы и контекст лежат в `playbackClock.ts`:
 * правило `react-refresh/only-export-components` требует, чтобы файл с
 * компонентом не экспортировал ничего, кроме компонентов.
 *
 * Провайдер оборачивает ряд проекций и 3D-вид «Куб», и это существенно: он
 * перерисовывается на каждом кадре (~60 раз в секунду), а проекции приходят ему
 * как `children` — то есть остаются теми же элементами, и React не трогает ни
 * срез, ни поля, ни облако из сотен точек («Куб» сам читает кадр контекстом и
 * перерисовывает свой canvas).
 */
import type { ReactNode } from 'react'
import { PlaybackFrameContext, usePlaybackClock } from './playbackClock'

export function PlaybackFrameProvider({ children }: { children: ReactNode }) {
  const frame = usePlaybackClock()
  return <PlaybackFrameContext.Provider value={frame}>{children}</PlaybackFrameContext.Provider>
}
