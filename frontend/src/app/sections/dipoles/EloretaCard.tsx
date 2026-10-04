/**
 * Карточка результата eLORETA (остаток B9): пик распределения + ROI-доли.
 *
 * Полные карты не показываются — их и нет в контракте (dipoles.md п.5):
 * карточка честно ограничена пиком (координата, анатомия) и долями энергии по
 * структурам. Пустой список результатов — карточка не рисуется вовсе.
 */
import type { EloretaResult } from '@/shared/api/types'
import { StatusPill } from '@/shared/ui/StatusPill'

function formatShare(value: number): string {
  return `${(value * 100).toFixed(1)} %`
}

export function EloretaCard({
  epochIndex,
  result,
}: {
  /** Номер эпохи (с 0) — подпись карточки берётся из ключа, не из ответа */
  epochIndex: number
  result: EloretaResult
}) {
  const peak = result.peak
  return (
    <section
      className="space-y-2 rounded-md border border-border p-3"
      data-testid={`eloreta-card-${epochIndex}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-fg-1">
          {`eLORETA — эпоха ${epochIndex + 1}`}
        </h3>
        <StatusPill tone="accent" title="Кадр координат — fsaverage-MNI, как у диполей">
          {`пик: [${peak.mni_mm.map((value) => value.toFixed(0)).join(', ')}] мм`}
        </StatusPill>
        {peak.structure_name ? (
          <StatusPill
            tone="ok"
            title={`Расстояние до структуры: ${peak.structure_distance_mm ?? '—'} мм`}
          >
            {peak.structure_name}
          </StatusPill>
        ) : (
          <StatusPill tone="warn">Анатомия недоступна</StatusPill>
        )}
        {peak.area_name ? <StatusPill tone="neutral">{peak.area_name}</StatusPill> : null}
        {peak.outside_brain ? (
          <StatusPill tone="warn">Пик вне маски мозга</StatusPill>
        ) : null}
        <StatusPill tone="neutral" title="Условные единицы eLORETA (не нАм)">
          {`сила: ${peak.value.toExponential(2)}`}
        </StatusPill>
      </div>

      {result.roi && result.roi.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid={`eloreta-roi-${epochIndex}`}>
            <thead>
              <tr className="border-b border-border text-left text-fg-2">
                <th className="py-1.5 pr-3 font-normal">Структура</th>
                <th className="py-1.5 pr-3 text-right font-normal">Доля энергии</th>
              </tr>
            </thead>
            <tbody>
              {(result.roi ?? []).map((row) => (
                <tr key={row.structure} className="border-b border-border/50 text-fg-1">
                  <td className="py-1.5 pr-3">{row.structure}</td>
                  <td className="tnum py-1.5 pr-3 text-right">{formatShare(row.share)}</td>
                </tr>
              ))}
              <tr className="text-fg-2" data-testid={`eloreta-other-${epochIndex}`}>
                <td className="py-1.5 pr-3">Прочие (вне топа)</td>
                <td className="tnum py-1.5 pr-3 text-right">{formatShare(result.other_share)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-fg-2">ROI-доли не посчитаны (атлас недоступен)</p>
      )}

      {(result.warnings ?? []).length > 0 ? (
        <ul className="list-inside list-disc space-y-1 text-sm text-fg-2">
          {(result.warnings ?? []).map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
