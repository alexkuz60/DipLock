/** Серверные действия привязаны к делу; чувствительное состояние не персистится. */
import { useMutation, useQueryClient } from '@tanstack/react-query'

export function useCaseAction<T>(caseId: string, action: (value: T) => Promise<unknown>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: action,
    retry: false,
    gcTime: 0,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['consilium', caseId] }),
        queryClient.invalidateQueries({ queryKey: ['consilium-cases'] }),
      ])
    },
  })
}
