/** Общая лента раундов: «Обсуждение» и дерево навигации читают одну подписку. */
import { useQuery } from '@tanstack/react-query'
import { consiliumApi } from '@/shared/api/consilium'

/**
 * Раунды советников дела (append-only) с поллингом, пока идёт запуск: живой
 * стрим — только удобство, готовые ответы приходят из БД (`docs/rules/consilium.md`).
 */
export function useCaseRounds(caseId: string) {
  return useQuery({
    queryKey: ['consilium', caseId, 'rounds'],
    queryFn: ({ signal }) => consiliumApi.rounds(caseId, 0, signal),
    gcTime: 0,
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.status === 'running') ? 2000 : false,
  })
}