/** Выбранные результаты и снимки: раскрытие деталей не запускает пересчёт. */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiErrorText } from '@/shared/api/client'
import { consiliumApi } from '@/shared/api/consilium'
import type {
  ConsiliumCase,
  ConsiliumEvidence,
  ConsiliumEvidenceDeletion,
  ConsiliumEvidenceCreate,
  ConsiliumSnapshotCreate,
} from '@/shared/api/types'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { ErrorBlock } from '@/shared/ui/StateViews'
import { PageButtons, QueryState } from './common'
import { useCaseAction } from './useCaseAction'

export function EvidenceDetails({ material }: { material: ConsiliumEvidence }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-accent">На чём основано? · {material.title}</summary>
      <p>
        Источник: {material.source_kind} / {material.source_id} · полнота: {material.completeness}
      </p>
      <p>Состояние сигнала: {material.signal_state ?? 'не установлено'}</p>
      <p>Неизвестно: {material.missing?.join(', ') || 'не указано'}</p>
      <p>Хеш результата: {material.sha256}</p>
      <pre className="max-h-80 overflow-auto rounded bg-bg-2 p-2">
        {JSON.stringify(
          {
            parameters: material.parameters,
            versions: material.versions,
            units: material.units,
            result: material.payload,
          },
          null,
          2,
        )}
      </pre>
    </details>
  )
}

export function CaseMaterials({ current }: { current: ConsiliumCase }) {
  const [sourceOffset, setSourceOffset] = useState(0)
  const [materialOffset, setMaterialOffset] = useState(0)
  const [contextOffset, setContextOffset] = useState(0)
  const [snapshotOffset, setSnapshotOffset] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [contextIds, setContextIds] = useState<string[]>([])
  const [preview, setPreview] = useState<ConsiliumEvidenceDeletion | null>(null)
  const readOnly = current.status !== 'open'
  const sources = useQuery({
    queryKey: ['consilium', current.id, 'sources', sourceOffset],
    queryFn: ({ signal }) => consiliumApi.sources(current.id, sourceOffset, signal),
    gcTime: 0,
  })
  const evidence = useQuery({
    queryKey: ['consilium', current.id, 'evidence', materialOffset],
    queryFn: ({ signal }) => consiliumApi.evidence(current.id, materialOffset, signal),
    gcTime: 0,
  })
  const context = useQuery({
    queryKey: ['consilium', current.id, 'context', contextOffset],
    queryFn: ({ signal }) => consiliumApi.context(current.id, contextOffset, signal),
    gcTime: 0,
  })
  const snapshots = useQuery({
    queryKey: ['consilium', current.id, 'snapshots', snapshotOffset],
    queryFn: ({ signal }) => consiliumApi.snapshots(current.id, snapshotOffset, signal),
    gcTime: 0,
  })
  const add = useCaseAction(current.id, (payload: ConsiliumEvidenceCreate) =>
    consiliumApi.addEvidence(current.id, payload),
  )
  const publish = useCaseAction(current.id, (payload: ConsiliumSnapshotCreate) =>
    consiliumApi.publish(current.id, payload),
  )
  const checkDeletion = useCaseAction(current.id, async (id: string) => {
    setPreview(await consiliumApi.evidenceDeletion(current.id, id))
  })
  const deletion = useCaseAction(current.id, ({ id, version }: { id: string; version: number }) =>
    consiliumApi.deleteEvidence(current.id, id, version),
  )
  const toggle = (ids: string[], id: string, checked: boolean) =>
    checked ? [...ids, id] : ids.filter((value) => value !== id)

  return (
    <div className="space-y-4">
      <h3 className="font-semibold">Доступные результаты связанных записей</h3>
      <p className="text-sm text-fg-2">
        Добавление фиксирует результат конкретного прогона. Оно не запускает анализ ЭЭГ; группа
        фиксируется по текущим пакетам.
      </p>
      <Button
        onClick={() => {
          void sources.refetch()
        }}
      >
        Обновить источники
      </Button>
      <QueryState
        loading={sources.isPending}
        error={sources.error}
        retry={() => {
          void sources.refetch()
        }}
      />
      {sources.data?.warnings?.map((warning) => (
        <p key={warning} className="text-sm text-warning">
          {warning}
        </p>
      ))}
      {sources.data?.items.map((source) => (
        <article
          key={`${source.kind}:${source.id}`}
          className="space-y-1 rounded-lg border border-border p-3"
        >
          <p>{source.title}</p>
          {source.warnings?.map((warning) => (
            <p key={warning} className="text-sm text-fg-2">
              {warning}
            </p>
          ))}
          <Button
            disabled={readOnly || add.isPending || !source.available}
            onClick={() =>
              add.mutate({
                request_id: crypto.randomUUID(),
                expected_version: current.version,
                source_kind: source.kind,
                source_id: source.id,
              })
            }
          >
            {source.available ? 'Добавить материал' : 'Результат недоступен'}
          </Button>
        </article>
      ))}
      <PageButtons
        offset={sourceOffset}
        total={sources.data?.total ?? 0}
        onChange={setSourceOffset}
      />
      {add.error && (
        <ErrorBlock
          message={apiErrorText(add.error)}
          onRetry={() => {
            if (add.variables) add.mutate(add.variables)
          }}
        />
      )}
      <h3 className="font-semibold">Принятые материалы</h3>
      <QueryState
        loading={evidence.isPending}
        error={evidence.error}
        retry={() => {
          void evidence.refetch()
        }}
      />
      {evidence.data?.items.map((material) => (
        <article key={material.id} className="space-y-2 rounded-lg border border-border p-3">
          <CheckboxRow
            label={`В досье: ${material.title}`}
            checked={selected.includes(material.id)}
            disabled={readOnly || publish.isPending}
            onChange={(checked) => setSelected(toggle(selected, material.id, checked))}
          />
          {material.warnings?.map((warning) => (
            <p key={warning} className="text-sm text-fg-2">
              {warning}
            </p>
          ))}
          <EvidenceDetails material={material} />
          <Button
            variant="ghost"
            disabled={checkDeletion.isPending}
            onClick={() => checkDeletion.mutate(material.id)}
          >
            Посмотреть удаление материала
          </Button>
        </article>
      ))}
      <PageButtons
        offset={materialOffset}
        total={evidence.data?.total ?? 0}
        onChange={setMaterialOffset}
      />
      <h3 className="font-semibold">Контекст для досье</h3>
      <p className="text-sm text-fg-2">
        При публикации берётся последняя ревизия выбранной записи. Снимок сохраняет её отдельно от
        будущих исправлений.
      </p>
      <QueryState
        loading={context.isPending}
        error={context.error}
        retry={() => {
          void context.refetch()
        }}
      />
      {context.data?.items
        .filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index)
        .map((item) => (
          <CheckboxRow
            key={item.id}
            label={`Контекст: ${item.text}`}
            checked={contextIds.includes(item.id)}
            disabled={readOnly || publish.isPending}
            onChange={(checked) => setContextIds(toggle(contextIds, item.id, checked))}
          />
        ))}
      <PageButtons
        offset={contextOffset}
        total={context.data?.total ?? 0}
        onChange={setContextOffset}
      />
      <Button
        variant="primary"
        disabled={readOnly || publish.isPending || !selected.length}
        onClick={() =>
          publish.mutate(
            {
              request_id: crypto.randomUUID(),
              expected_version: current.version,
              evidence_ids: selected,
              context_ids: contextIds,
            },
            {
              onSuccess: () => {
                setSelected([])
                setContextIds([])
              },
            },
          )
        }
      >
        Опубликовать снимок досье
      </Button>
      {publish.error && (
        <ErrorBlock
          message={apiErrorText(publish.error)}
          onRetry={() => {
            if (publish.variables) publish.mutate(publish.variables)
          }}
        />
      )}
      {(checkDeletion.error || deletion.error) && (
        <ErrorBlock message={apiErrorText(checkDeletion.error ?? deletion.error)} />
      )}
      {preview && (
        <div
          role="dialog"
          aria-label="Удаление материала"
          className="space-y-2 rounded-lg border border-danger p-3"
        >
          <p>Будет удалён материал и снимков: {preview.snapshot_ids.length}.</p>
          {preview.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          <Button
            disabled={deletion.isPending}
            onClick={() =>
              deletion.mutate(
                { id: preview.evidence_id, version: preview.version },
                {
                  onSuccess: () => {
                    setSelected(selected.filter((id) => id !== preview.evidence_id))
                    setPreview(null)
                  },
                },
              )
            }
          >
            Удалить материал и зависимые снимки
          </Button>
          <Button disabled={deletion.isPending} onClick={() => setPreview(null)}>
            Отмена
          </Button>
        </div>
      )}
      <h3 className="font-semibold">История досье</h3>
      <QueryState
        loading={snapshots.isPending}
        error={snapshots.error}
        retry={() => {
          void snapshots.refetch()
        }}
      />
      {snapshots.data?.items.map((snapshot) => (
        <details key={snapshot.id} className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer">
            Досье · {snapshot.created_at} · материалов {snapshot.evidence.length}
          </summary>
          <p>{snapshot.question}</p>
          <p className="text-sm text-fg-2">
            Версия дела {snapshot.case_version} · хеш {snapshot.sha256}
          </p>
          {snapshot.warnings?.map((warning) => (
            <p key={warning} className="text-sm text-fg-2">
              {warning}
            </p>
          ))}
          {snapshot.context.map((item) => (
            <p key={item.id} className="whitespace-pre-wrap">
              {item.author}: {item.text} · ревизия {item.revision}
            </p>
          ))}
          {snapshot.evidence.map((material) => (
            <EvidenceDetails key={material.id} material={material} />
          ))}
        </details>
      ))}
      <PageButtons
        offset={snapshotOffset}
        total={snapshots.data?.total ?? 0}
        onChange={setSnapshotOffset}
      />
    </div>
  )
}
