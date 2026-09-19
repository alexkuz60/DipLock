/**
 * Топокарты ритмов δ…γ (срез 3.4): картинки распределения мощности по скальпу.
 *
 * Ничего не считается на клиенте: сервер отдаёт готовые PNG, они рисуются как
 * `<img>` и кэшируются браузером по URL (в URL — параметры расчёта и версия
 * ассета, см. `shared/lib/spectrum.ts`). Полоса диапазона — из результата, а не
 * из панели: картинка обязана соответствовать тому расчёту, который показан.
 *
 * Недоступная картинка (сервер вернул ошибку) показывается текстом под фигурой:
 * «сломанная» иконка браузера ничего не объясняет, а причина обычно во временно
 * недоступном томе или в каналах без позиций в монтаже.
 */
import { useState } from 'react'
import type { SpectrumResult } from '@/shared/api/types'
import { bandLabel, bandRangeLabel, formatPower, topomapUrl, type SpectrumQuery } from '@/shared/lib/spectrum'
import { cx } from '@/shared/ui/cx'

export type BandTopomapsProps = {
  spectrum: SpectrumResult
  /** Параметры расчёта: уходят в URL картинки (и в её ETag на сервере) */
  query: SpectrumQuery
  className?: string
}

export function BandTopomaps({ spectrum, query, className }: BandTopomapsProps) {
  /** URL картинок, которые не загрузились: держим именно URL, а не флаг */
  const [failed, setFailed] = useState<Record<string, boolean>>({})

  return (
    <div className={cx('flex flex-wrap gap-3', className)} data-testid="band-topomaps">
      {spectrum.bands.map((band) => {
        const url = topomapUrl(spectrum, band, query)
        const broken = failed[band.name] === true
        return (
          <figure
            key={band.name}
            data-testid={`topomap-${band.name}`}
            className="flex w-40 flex-col items-center gap-1 rounded-lg border border-border bg-bg-2 p-2"
          >
            {url && !broken ? (
              <img
                src={url}
                alt={`Топокарта ${bandLabel(band.name)} (${bandRangeLabel(band)})`}
                width={144}
                height={144}
                loading="lazy"
                onError={() => setFailed((state) => ({ ...state, [band.name]: true }))}
                className="size-36 rounded-full"
              />
            ) : (
              <div
                data-testid={`topomap-unavailable-${band.name}`}
                className="flex size-36 items-center justify-center rounded-full border border-dashed border-border px-2 text-center text-sm text-fg-2"
              >
                {url ? 'топокарта не загрузилась' : 'нет позиций каналов'}
              </div>
            )}
            <figcaption className="text-center text-sm text-fg-1">
              <span className="font-medium">{bandLabel(band.name)}</span>
              <br />
              <span className="tnum text-fg-2">
                {bandRangeLabel(band)} · {formatPower(band.power_uv2)} мкВ²
                {band.relative_power !== null
                  ? ` · ${Math.round(band.relative_power * 100)} %`
                  : ''}
              </span>
            </figcaption>
          </figure>
        )
      })}
    </div>
  )
}
