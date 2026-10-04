/**
 * Блок «Ковариация (QC)» в отчёте стадии «Фильтр и референс» (п.6 todo.md).
 *
 * Числа (собственные значения, % дисперсии, эффективный ранг) и картинки
 * (heatmap корреляций, топокарты ведущих ПК) приходят base64-строками **в
 * самом отчёте стадии** — одного пересчёта с L1/L3: сервер отдаёт ровно то,
 * что посчитал, а отдельный эндпоинт мог бы показать другой срез
 * (`docs/rules/artifacts.md`, «Ковариация как QC-слой»).
 *
 * Правка параметра ничего не пересчитывает — считает кнопка шапки (общее
 * правило UI, `docs/rules/frontend-state.md`).
 */
import type { CleanReport } from '@/shared/api/types'

type Covariance = NonNullable<CleanReport['covariance']>

/** data-URI из base64-строки PNG; null/пустая строка — картинки нет */
function dataUri(b64: string | null | undefined): string | null {
  return b64 ? `data:image/png;base64,${b64}` : null
}

/** Порог шумового хвоста в процентах: 0.01 → «1 %», 0.005 → «0.5 %» */
function tailPercent(tailRatio: number): string {
  return `${Number((tailRatio * 100).toFixed(2))} %`
}

export function CleanCovariance({ covariance }: { covariance: Covariance }) {
  const { before, after } = covariance
  const warnings = covariance.warnings ?? []
  const beforeComponents = before.components ?? []
  const afterComponents = after.components ?? []
  const rows = before.variance_percent.map((percent, index) => ({
    index: index + 1,
    eigenBefore: before.eigenvalues_uv2[index],
    eigenAfter: after.eigenvalues_uv2[index],
    percentBefore: percent,
    percentAfter: after.variance_percent[index],
  }))
  const heatmapBefore = dataUri(before.heatmap_png_b64)
  const heatmapAfter = dataUri(after.heatmap_png_b64)

  return (
    <div className="mt-1 space-y-1" data-testid="clean-covariance">
      <p className="text-sm font-medium text-fg-2">Ковариация (QC): «до» → «после»</p>
      {warnings.map((text) => (
        <p key={text} className="text-xs text-warn" data-testid="clean-covariance-warning">
          {text}
        </p>
      ))}
      <p className="text-xs text-fg-2" data-testid="clean-covariance-rank">
        {`Эфф. ранг: ${before.effective_rank} → ${after.effective_rank} — компонент с λ ≥ ${tailPercent(covariance.tail_ratio)} от λ1; шумовой хвост λ ≈ 0 — некоррелированный аппаратный шум.`}
      </p>
      <div className="flex flex-wrap gap-3" data-testid="clean-covariance-heatmaps">
        {heatmapBefore ? (
          <figure className="w-44">
            <img
              src={heatmapBefore}
              alt="Корреляции каналов до чистки"
              data-testid="clean-covariance-heatmap-before"
              className="w-full"
            />
            <figcaption className="text-xs text-fg-2">Корреляции каналов: до</figcaption>
          </figure>
        ) : null}
        {heatmapAfter ? (
          <figure className="w-44">
            <img
              src={heatmapAfter}
              alt="Корреляции каналов после чистки"
              data-testid="clean-covariance-heatmap-after"
              className="w-full"
            />
            <figcaption className="text-xs text-fg-2">Корреляции каналов: после</figcaption>
          </figure>
        ) : null}
      </div>
      {afterComponents.length ? (
        <ul className="space-y-1" data-testid="clean-covariance-components">
          {afterComponents.map((component, order) => {
            const beforePc = beforeComponents[order]
            const imageBefore = dataUri(beforePc?.topomap_png_b64)
            const imageAfter = dataUri(component.topomap_png_b64)
            return (
              <li key={component.index} className="flex items-center gap-2 text-xs text-fg-2">
                <span className="w-8 font-medium">{`PC${component.index}`}</span>
                {imageBefore ? (
                  <img
                    src={imageBefore}
                    alt={`Топокарта PC${component.index} до чистки`}
                    data-testid={`clean-covariance-pc${component.index}-before`}
                    className="h-16 w-16"
                  />
                ) : (
                  <span className="h-16 w-16 text-center">нет карты</span>
                )}
                <span aria-hidden="true">→</span>
                {imageAfter ? (
                  <img
                    src={imageAfter}
                    alt={`Топокарта PC${component.index} после чистки`}
                    data-testid={`clean-covariance-pc${component.index}-after`}
                    className="h-16 w-16"
                  />
                ) : (
                  <span className="h-16 w-16 text-center">нет карты</span>
                )}
                <span data-testid={`clean-covariance-pc${component.index}-share`}>
                  {`${beforePc?.variance_percent ?? '—'} % → ${component.variance_percent} %`}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
      {rows.length ? (
        <table className="w-full text-xs" data-testid="clean-covariance-table">
          <thead>
            <tr className="text-left text-fg-2">
              <th className="py-0.5">ПК</th>
              <th className="py-0.5">λ до, мкВ²</th>
              <th className="py-0.5">λ после, мкВ²</th>
              <th className="py-0.5">% до</th>
              <th className="py-0.5">% после</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.index} data-testid={`clean-covariance-row-${row.index}`}>
                <td className="py-0.5">{row.index}</td>
                <td className="py-0.5">{row.eigenBefore}</td>
                <td className="py-0.5">{row.eigenAfter}</td>
                <td className="py-0.5">{row.percentBefore}</td>
                <td className="py-0.5">{row.percentAfter}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p className="text-xs text-fg-2">
        λ — собственные значения ковариации каналов (мкВ²), % — доля дисперсии компоненты;
        топокарта ПК подписана честно: PC1 с фронтальным максимумом и инверсией фазы —
        «моргание» в эпохе. Числа считаются для текущей конфигурации (с отменами), как и L1/L3.
      </p>
    </div>
  )
}
