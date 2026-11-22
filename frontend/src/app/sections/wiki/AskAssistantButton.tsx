/**
 * «Спросить Ассистента» на статье Wiki: текст статьи сохраняется в библиотеку
 * знаний как документ и прикрепляется к нити чата, где роль «Ассистент»
 * объясняет раздел по фактическому тексту, а не по памяти модели.
 */
import { useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { apiErrorText } from '@/shared/api/client'
import { knowledgeApi } from '@/shared/api/knowledge'
import { Button } from '@/shared/ui/Button'

export function AskAssistantButton({
  articleId,
  title,
}: {
  articleId: string
  title: string
}) {
  const navigate = useNavigate()

  const ask = useMutation({
    mutationFn: async () => {
      const article = document.getElementById('wiki-article')
      const text = (article?.textContent ?? '').trim()
      if (!text) throw new Error('Текст статьи не найден на странице')
      const file = new File([text], `wiki-${articleId}.txt`, { type: 'text/plain' })
      return knowledgeApi.upload(file, null, `Wiki: ${title}`)
    },
    onSuccess: (document) => {
      const params = new URLSearchParams({
        view: 'chat',
        attach: document.id,
        ask: `Объясни подробнее раздел документации «${title}»`,
      })
      navigate({ pathname: '/consilium', search: `?${params.toString()}` })
    },
  })

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="secondary"
        disabled={ask.isPending}
        onClick={() => ask.mutate()}
      >
        {ask.isPending ? 'Готовим контекст...' : 'Спросить Ассистента'}
      </Button>
      {ask.error != null && (
        <p className="text-xs text-danger">{apiErrorText(ask.error)}</p>
      )}
    </div>
  )
}
