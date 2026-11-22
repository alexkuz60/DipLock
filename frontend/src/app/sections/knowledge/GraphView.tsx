/**
 * Граф знаний: список подтверждённых рёбер и узлов.
 *
 * Список, а не canvas: узлов немного, а список читается с клавиатуры и
 * скринридером. Визуальная раскладка — следующий шаг, когда граф вырастет.
 */
import type { KnowledgeGraph } from '@/shared/api/types'

const KIND_LABEL: Record<string, string> = {
  document: 'документ',
  tag: 'тег',
  concept: 'понятие',
}

const RELATION_LABEL: Record<string, string> = {
  cites: 'цитирует',
  related: 'связан с',
  defines: 'определяет',
  mentions: 'упоминает',
}

export function GraphView({ graph }: { graph: KnowledgeGraph }) {
  const labels = new Map(graph.nodes.map((node) => [`${node.kind}:${node.id}`, node.label]))

  if (graph.edges.length === 0) {
    return (
      <p className="text-sm text-fg-2">
        Подтверждённых связей пока нет: добавьте ребро между документом и тегом.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-2">
        Узлов: {graph.nodes.length} · связей: {graph.edges.length}
      </p>
      <ul className="space-y-1">
        {graph.edges.map((edge) => (
          <li key={edge.id} className="text-sm text-fg-1">
            <span className="text-fg-0">
              {labels.get(`${edge.from_kind}:${edge.from_id}`) ?? edge.from_id}
            </span>{' '}
            <span className="text-fg-2">
              ({KIND_LABEL[edge.from_kind] ?? edge.from_kind})
            </span>{' '}
            {RELATION_LABEL[edge.relation] ?? edge.relation}{' '}
            <span className="text-fg-0">
              {labels.get(`${edge.to_kind}:${edge.to_id}`) ?? edge.to_id}
            </span>{' '}
            <span className="text-fg-2">({KIND_LABEL[edge.to_kind] ?? edge.to_kind})</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
