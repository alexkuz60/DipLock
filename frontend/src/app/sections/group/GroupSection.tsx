/**
 * Рабочая область «Сравнения двух записей»: результат дифференциального
 * анализа (B9).
 *
 * Числа приходят из задачи целиком (`CompareResult`) — клиент ничего не
 * пересчитывает (правило проекта): кривые PSD — SVG-полилинии, таблицы —
 * готовые дельты, карты разности — PNG с сервера (`topomap_delta_url`,
 * версия в `?v=` против «залипания» кэша). Каветы `notes` показываются
 * под результатом без редактирования: интерпретация кластерного теста —
 * часть контракта, а не оформление.
 */
import { useQuery } from '@tanstack/react-query'
import { GitCompareArrows } from 'lucide-react'
import { api } from '@/shared/api/client'
import type { CompareResult } from '@/shared/api/types'
import { bandLabel, formatPower } from '@/shared/lib/spectrum'
import { useGroupCompare } from '@/shared/state/groupCompare'
import { Panel } from '@/shared/ui/Panel'
import { StatusPill } from '@/shared/ui/StatusPill'
import { WarnList } from '@/shared/ui/WarnList'
import { cx } from '@/shared/ui/cx'
import { BandDeltaBar, CompareStackChart, IndexDumbbell } from './GroupCharts'
import { bandDeltaScale, formatDb, formatP } from './chartFormat'

/** Паспорт пары: что сравнивается и что совпало (B9 «совпадение параметров»). */
function PairPassport({ result }: { result: CompareResult }) {
  const match = result.match
  return (
    <Panel title="Пара и совпадение параметров" hint="B9: сравнение корректно только при одинаковой обработке обеих сторон.">
      <div className="grid gap-2 sm:grid-cols-2">
        {[result.side_a, result.side_b].map((side, index) => (
          <div
            key={side.recording_id}
            className="rounded-lg border border-border bg-bg-2 p-3"
            data-testid={`compare-side-${index === 0 ? 'a' : 'b'}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-fg-0">{index === 0 ? 'A' : 'B'}</span>
              <StatusPill tone="neutral">{side.label}</StatusPill>
            </div>
            <p className="mt-1 truncate text-sm text-fg-1" title={side.filename}>
              {side.filename}
            </p>
            <p className="tnum mt-1 text-sm text-fg-2">
              {`Эпох: ${side.n_epochs}, каналов: ${side.n_channels}`}
            </p>
          </div>
        ))}
      </div>
      <ul className="mt-3 space-y-1 text-sm text-fg-2">
        <li>{`sfreq: ${match.sfreq} Гц · длина эпохи: ${match.epoch_length_ms} мс · PSD: ${match.psd_method}`}</li>
        <li>{`Фильтр: ${match.filter_band_hz ? `${match.filter_band_hz[0]}–${match.filter_band_hz[1]} Гц` : 'без фильтра'}${match.notch_hz ? ` · notch ${match.notch_hz} Гц` : ''} · референс: ${match.reference}`}</li>
        <li>{`Общих каналов: ${match.channels.length}`}</li>
        {(match.channels_only_a ?? []).length > 0 ? (
          <li className="text-warn">{`Только в A: ${(match.channels_only_a ?? []).join(', ')} — исключены из сравнения`}</li>
        ) : null}
        {(match.channels_only_b ?? []).length > 0 ? (
          <li className="text-warn">{`Только в B: ${(match.channels_only_b ?? []).join(', ')} — исключены из сравнения`}</li>
        ) : null}
      </ul>
    </Panel>
  )
}

/** Таблица дельт по полосам: мощности сторон, Δ, CI, p/q + правая колонка-график. */
function BandDeltas({ result }: { result: CompareResult }) {
  const maxAbs = bandDeltaScale(result.bands)
  return (
    <Panel
      title="Дельты по полосам (B − A)"
      hint="ΔдБ = 10·log10(B/A); CI — 95% bootstrap по эпохам (ноль внутри интервала — различие не подтверждено); q — FDR-поправка p по полосам; «каналы» — значимые после FDR внутри полосы."
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="compare-bands-table">
          <thead>
            <tr className="border-b border-border text-left text-fg-2">
              <th className="py-1.5 pr-3 font-normal">Полоса</th>
              <th className="py-1.5 pr-3 text-right font-normal">A, мкВ²</th>
              <th className="py-1.5 pr-3 text-right font-normal">B, мкВ²</th>
              <th className="py-1.5 pr-3 text-right font-normal">Δ, дБ</th>
              <th className="py-1.5 pr-3 font-normal">95% ИИ дБ</th>
              <th className="py-1.5 pr-3 text-right font-normal">p</th>
              <th className="py-1.5 pr-3 text-right font-normal">q (FDR)</th>
              <th className="py-1.5 pr-3 text-right font-normal">Эффект</th>
              <th className="py-1.5 pr-3 font-normal">Значимые каналы</th>
              <th className="py-1.5 font-normal">Δ (график, дБ)</th>
            </tr>
          </thead>
          <tbody>
            {result.bands.map((band) => {
              const significant = band.q_value !== null && band.q_value < result.stats.alpha
              return (
                <tr
                  key={band.name}
                  className="border-b border-border/50 text-fg-1"
                  data-testid={`compare-band-${band.name}`}
                >
                  <td className="py-1.5 pr-3" title={`${band.fmin}–${band.fmax} Гц`}>
                    {bandLabel(band.name)}
                  </td>
                  <td className="tnum py-1.5 pr-3 text-right">{formatPower(band.power_a_uv2)}</td>
                  <td className="tnum py-1.5 pr-3 text-right">{formatPower(band.power_b_uv2)}</td>
                  <td
                    className={cx(
                      'tnum py-1.5 pr-3 text-right font-medium',
                      significant ? (band.delta_db && band.delta_db > 0 ? 'text-ok' : 'text-warn') : '',
                    )}
                  >
                    {formatDb(band.delta_db)}
                  </td>
                  <td className="tnum py-1.5 pr-3 text-fg-2">
                    {band.ci95_delta_db
                      ? `[${formatDb(band.ci95_delta_db[0])}, ${formatDb(band.ci95_delta_db[1])}]`
                      : '—'}
                  </td>
                  <td className="tnum py-1.5 pr-3 text-right text-fg-2">{formatP(band.p_value)}</td>
                  <td className="tnum py-1.5 pr-3 text-right text-fg-2">{formatP(band.q_value)}</td>
                  <td className="tnum py-1.5 pr-3 text-right text-fg-2">
                    {(band.effect ?? null) === null ? '—' : (band.effect as number).toFixed(2)}
                  </td>
                  <td className="py-1.5 pr-3 text-fg-2">
                    {(band.fdr_significant_channels ?? []).length > 0
                      ? (band.fdr_significant_channels ?? []).join(', ')
                      : '—'}
                  </td>
                  {/* Вертикальный график: строка строки таблицы, общая шкала */}
                  <td className="py-1.5">
                    <BandDeltaBar band={band} maxAbs={maxAbs} alpha={result.stats.alpha} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-sm text-fg-2">
        Правая колонка — столбик ΔдБ (B − A) от нуля и ус 95% bootstrap-ИИ на общей шкале
        всех полос; яркий цвет — значимость после FDR (q &lt; α), приглушённый — различие
        не подтверждено.
      </p>
    </Panel>
  )
}

/**
 * Совмещённая панель: PSD обеих сторон + дельта + кластеры на **общей**
 * частотной оси (один график `CompareStackChart`), ниже — легенда и оба
 * пояснительных комментария, затем числовые карточки кластеров.
 */
function SpectrumStats({ result }: { result: CompareResult }) {
  const stats = result.stats
  const clusters = stats.clusters ?? []
  // freq_bands из /meta — подпись «Диапазон» под курсором графика
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.meta() })
  return (
    <Panel
      title="PSD обеих сторон и статистика различий"
      hint="Общая частотная ось: кривые PSD → дельта (B − A) → прямоугольники кластеров. Числа сервера, без пересчёта на клиенте."
    >
      <div className="mb-2 flex flex-wrap gap-2">
        <StatusPill tone={stats.n_significant > 0 ? 'ok' : 'neutral'}>
          {`Значимых кластеров: ${stats.n_significant} из ${stats.n_clusters}`}
        </StatusPill>
        <StatusPill tone="neutral">{`${result.side_a.label} → ${result.side_b.label}`}</StatusPill>
        <StatusPill tone="neutral">{`пермутации: ${stats.n_permutations}, α = ${stats.alpha}`}</StatusPill>
      </div>

      <CompareStackChart result={result} freqBands={meta.data?.freq_bands ?? null} />

      {/* Легенда — ниже графиков */}
      <div className="mt-1 flex flex-wrap gap-3 text-sm text-fg-2" data-testid="compare-legend">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-accent" />
          {`PSD ${result.side_a.label}`}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 border-t-2 border-dashed border-fg-1" />
          {`PSD ${result.side_b.label}`}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-3 rounded-sm bg-danger opacity-80" />
          Δ &gt; 0 (рост в B)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-3 rounded-sm bg-accent opacity-80" />
          Δ &lt; 0 (спад в B)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-3 rounded-sm bg-accent" />
          значимый кластер
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-3 rounded-sm bg-fg-2 opacity-40" />
          незначимый кластер
        </span>
      </div>

      {/* Оба комментария — ниже графиков */}
      <p className="mt-2 text-sm text-fg-2">
        Ряд «дБ» — дельта той же сетки частот (B − A): столбик вверх — мощность выше в B,
        вниз — в A; шкала ряда своя, знак читается цветом. Шкала PSD логарифмическая —
        подписи тиков честные значения мкВ².
      </p>
      <p className="mt-1 text-sm text-fg-2">
        Прямоугольники — кластеры пермутационного теста MNE (значимый — цветом направления
        Δ, незначимый — приглушённый). Кластер указывает связку «частота × канал», но не
        доказывает значимость каждой её точки отдельно (Sassenhagen &amp; Draschkow, 2019);
        эпохи внутри записи автокоррелированы — p-значения могут быть оптимистичными.
      </p>

      {clusters.length === 0 ? (
        <p className="mt-2 text-sm text-fg-2" data-testid="compare-no-clusters">
          Кластерный тест не нашёл различий на уровне α = {stats.alpha}.
        </p>
      ) : (
        <ul className="mt-3 space-y-1.5" data-testid="compare-clusters">
          {clusters.map((cluster, index) => (
            <li
              key={`${cluster.freq_min_hz}-${cluster.freq_max_hz}-${index}`}
              className={cx(
                'rounded-lg border bg-bg-2 p-2 text-sm',
                cluster.significant ? 'border-accent/60' : 'border-border',
              )}
              data-testid={cluster.significant ? 'compare-cluster-significant' : undefined}
            >
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill tone={cluster.significant ? 'ok' : 'neutral'}>
                  {cluster.significant ? 'значим' : `p = ${formatP(cluster.p_value)}`}
                </StatusPill>
                <span className="tnum text-fg-1">
                  {`${cluster.freq_min_hz.toFixed(1)}–${cluster.freq_max_hz.toFixed(1)} Гц`}
                </span>
                <span className="tnum text-fg-2">{`p = ${formatP(cluster.p_value)}`}</span>
                <span className="tnum text-fg-2">{`Δ ${formatDb(cluster.mean_delta_db)} дБ (${cluster.direction})`}</span>
                <span className="tnum text-fg-2">{`${cluster.n_points} точек`}</span>
              </div>
              <p className="mt-1 truncate text-fg-2" title={cluster.channels.join(', ')}>
                {cluster.channels.join(', ')}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/** Карты разности B−A по полосам: PNG с сервера, версия в `?v=` (против кэша). */
function DeltaTopomaps({ result }: { result: CompareResult }) {
  const withUrl = result.bands.filter((band) => band.topomap_delta_url)
  if (withUrl.length === 0) return null
  return (
    <Panel
      title="Карты разности по полосам (B − A)"
      hint="Дивергентная палитра: красный — рост в B, синий — спад; шкала симметрична (−m, m) в дБ по каналам полосы."
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {withUrl.map((band) => (
          <figure key={band.name} className="text-center">
            <img
              src={`${band.topomap_delta_url}&v=${result.topomap_version}`}
              alt={`Карта разности ${bandLabel(band.name)}`}
              width={128}
              height={128}
              className="mx-auto"
              loading="lazy"
              data-testid={`compare-topomap-${band.name}`}
            />
            <figcaption className="mt-1 text-sm text-fg-2">
              {`${bandLabel(band.name)} ${formatDb(band.delta_db)} дБ`}
            </figcaption>
          </figure>
        ))}
      </div>
    </Panel>
  )
}

/** Скалярные индексы сторон: IAF и отношения ритмов с дельтами + стрелки A→B. */
function IndicesPanel({ result }: { result: CompareResult }) {
  const { indices, specparam } = result
  const rows: {
    label: string
    rawA: number | null
    rawB: number | null
    digits: number
    delta: string
  }[] = [
    {
      label: 'IAF, Гц',
      rawA: indices.iaf_a_hz ?? null,
      rawB: indices.iaf_b_hz ?? null,
      digits: 1,
      delta: indices.delta_iaf_hz?.toFixed(1) ?? '—',
    },
    {
      label: 'θ/β',
      rawA: indices.theta_beta_a ?? null,
      rawB: indices.theta_beta_b ?? null,
      digits: 2,
      delta: indices.delta_theta_beta?.toFixed(2) ?? '—',
    },
    {
      label: '(θ+α)/β',
      rawA: indices.theta_alpha_beta_a ?? null,
      rawB: indices.theta_alpha_beta_b ?? null,
      digits: 2,
      delta: indices.delta_theta_alpha_beta?.toFixed(2) ?? '—',
    },
    {
      label: '1/f наклон',
      rawA: specparam.exponent_a ?? null,
      rawB: specparam.exponent_b ?? null,
      digits: 2,
      delta: specparam.delta_exponent?.toFixed(2) ?? '—',
    },
  ]
  const fmt = (value: number | null, digits: number) =>
    value === null ? '—' : value.toFixed(digits)
  return (
    <Panel
      title="Индексы сторон"
      hint="IAF (N16) и отношения ритмов по интегральным мощностям; 1/f — specparam (фиксированная модель). Стрелка A → B: синяя точка — A, цветная — B, цвет — направление сдвига."
    >
      <table className="w-full text-sm" data-testid="compare-indices">
        <thead>
          <tr className="border-b border-border text-left text-fg-2">
            <th className="py-1.5 pr-3 font-normal">Индекс</th>
            <th className="py-1.5 pr-3 text-right font-normal">A</th>
            <th className="py-1.5 pr-3 text-right font-normal">B</th>
            <th className="py-1.5 text-right font-normal">Δ (B − A)</th>
            <th className="py-1.5 font-normal">A → B</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b border-border/50 text-fg-1">
              <td className="py-1.5 pr-3">{row.label}</td>
              <td className="tnum py-1.5 pr-3 text-right">{fmt(row.rawA, row.digits)}</td>
              <td className="tnum py-1.5 pr-3 text-right">{fmt(row.rawB, row.digits)}</td>
              <td className="tnum py-1.5 text-right font-medium">{row.delta}</td>
              <td className="py-1.5">
                <IndexDumbbell a={row.rawA} b={row.rawB} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}

export function GroupSection() {
  const result = useGroupCompare((state) => state.result)
  const error = useGroupCompare((state) => state.error)
  const job = useGroupCompare((state) => state.job)
  // Сессии — только для подсказки пустого состояния (кандидаты рисуют панель)
  useQuery({ queryKey: ['sessions', 200], queryFn: ({ signal }) => api.sessions({ limit: 200 }, signal) })

  if (!result) {
    const running = job?.status === 'running'
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <GitCompareArrows className="size-10 text-fg-2" aria-hidden />
        <h2 className="text-lg font-medium text-fg-0">Дифференциальный анализ двух записей</h2>
        <p className="max-w-xl text-sm text-fg-2">
          {running
            ? job.message
            : 'Выберите пару записей (например, покой и умственную деятельность) в панели справа и нажмите «Сравнить». Результат: дельты мощностей по полосам (B − A), кластерный тест MNE и карты разности.'}
        </p>
        {error ? (
          <p className="max-w-xl text-sm text-warn" data-testid="group-error">
            {error}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="space-y-4 p-4" data-testid="group-result">
      <PairPassport result={result} />
      <BandDeltas result={result} />
      <SpectrumStats result={result} />
      <DeltaTopomaps result={result} />
      <IndicesPanel result={result} />
      <Panel title="Каветы и предупреждения" hint="Интерпретация результата — часть контракта: показывается без редактирования.">
        <ul className="list-inside list-disc space-y-1 text-sm text-fg-2" data-testid="compare-notes">
          {(result.notes ?? []).map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
        <WarnList items={result.warnings ?? []} testId="compare-warnings" />
      </Panel>
    </div>
  )
}


