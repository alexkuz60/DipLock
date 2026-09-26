/**
 * Карта каналов панели EDF: силуэт головы с именованными датчиками отведения.
 *
 * Вместо чекбоксов: клик по датчику (точка или подпись) включает/выключает
 * канал для просмотра — тот же `toggleChannel`, что и раньше, ни один запрос
 * не выполняется (правило «правка параметров ничего не запускает»).
 *
 * Геометрия (точки, подписи, выравнивание ряда и раздвижка боковых электродов)
 * целиком считается в `shared/lib/headMapLayout.ts`; позиции приходят из
 * `/meta` (`channel_positions`: нормированные координаты монтажа 10-20, единица
 * — край электродов, нос `+y`, поэтому экранная ось y инвертируется).
 *
 * Каналы без позиции (вне монтажа) не пропадают — остаются чекбоксами под
 * картой. Если позиций нет вовсе (`/meta` ещё не ответил или монтаж
 * недоступен), показывается прежний список чекбоксов.
 */
import { CENTER, DOT_R, HEAD_R, HIT_R, VIEW, layoutSensors } from '@/shared/lib/headMapLayout'
import { CheckboxRow } from './CheckboxRow'

export type HeadChannelMapProps = {
  /** Каналы панели: запись, иначе монтаж из `/meta` */
  channels: string[]
  /** Нормированные позиции датчиков из `/meta` (`channel_positions`) */
  positions: Record<string, number[]>
  /** Видимые каналы (`params.visibleChannels`) */
  selected: string[]
  /** Вкл/выкл канала для просмотра */
  onToggle: (name: string) => void
}

export function HeadChannelMap({ channels, positions, selected, onToggle }: HeadChannelMapProps) {
  const { sensors, rest } = layoutSensors(channels, positions)

  // Позиций нет — прежний список чекбоксов (ответ /meta ещё не пришёл или
  // монтаж недоступен): прятать каналы нельзя
  if (sensors.length === 0) {
    return (
      <>
        {channels.map((name) => (
          <CheckboxRow
            key={name}
            mono
            label={name}
            checked={selected.includes(name)}
            onChange={() => onToggle(name)}
          />
        ))}
      </>
    )
  }

  const visible = new Set(selected)
  return (
    <>
      <svg
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        className="w-full"
        role="group"
        aria-label="Карта датчиков отведения"
        data-testid="head-channel-map"
      >
        {/* Силуэт головы вид сверху: контур, нос и уши */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={HEAD_R}
          fill="var(--color-bg-1)"
          stroke="var(--color-border)"
          strokeWidth={1.5}
        />
        <path
          d={`M ${CENTER - 39} 27 L ${CENTER} 6 L ${CENTER + 39} 27`}
          fill="var(--color-bg-1)"
          stroke="var(--color-border)"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
        <path d="M 19 96 A 9 14 0 0 0 19 124" fill="none" stroke="var(--color-border)" strokeWidth={1.5} />
        <path d="M 201 96 A 9 14 0 0 1 201 124" fill="none" stroke="var(--color-border)" strokeWidth={1.5} />
        {sensors.map(({ name, x, y, labelX, labelY }) => {
          const on = visible.has(name)
          return (
            <g
              key={name}
              role="button"
              tabIndex={0}
              aria-label={name}
              aria-pressed={on}
              className="group cursor-pointer outline-none"
              onClick={() => onToggle(name)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onToggle(name)
                }
              }}
            >
              <title>{`${name} — ${on ? 'виден' : 'скрыт'}, клик: переключить`}</title>
              {/* Зона клика больше точки и держит кольцо фокуса/ховера */}
              <circle
                cx={x}
                cy={y}
                r={HIT_R}
                fill="transparent"
                stroke="var(--color-accent)"
                strokeWidth={1.5}
                className="opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-100"
              />
              <circle
                cx={x}
                cy={y}
                r={DOT_R}
                fill={on ? 'var(--color-accent)' : 'var(--color-bg-3)'}
                stroke={on ? 'var(--color-accent)' : 'var(--color-fg-2)'}
                strokeWidth={1.5}
              />
              <text
                x={labelX}
                y={labelY}
                fontSize={9}
                textAnchor="middle"
                dominantBaseline="middle"
                className="font-mono"
                fill={on ? 'var(--color-fg-0)' : 'var(--color-fg-2)'}
              >
                {name}
              </text>
            </g>
          )
        })}
      </svg>
      <p className="mt-1 text-xs text-fg-2">
        Клик по датчику (точка или подпись) включает/выключает канал для просмотра.
      </p>
      {rest.length ? (
        <>
          <p className="mt-2 text-xs text-fg-2">Вне монтажа — без точки на карте:</p>
          {rest.map((name) => (
            <CheckboxRow
              key={name}
              mono
              label={name}
              checked={visible.has(name)}
              onChange={() => onToggle(name)}
            />
          ))}
        </>
      ) : null}
    </>
  )
}

