/** Соответствие меток ролей и ключей ролей советников (Jev, §5.3). */
import type { ConsiliumJevMark } from '@/shared/api/types'

export const ROLE_MARKS: Record<string, string> = {
  role_psychological: 'psychological',
  role_neurophysiological: 'neurophysiological',
  role_methodological: 'methodological',
}

/** Роль советника метки; для не-ролевых меток — null. */
export function roleMarkLabel(name: string): string | null {
  return ROLE_MARKS[name] ?? null
}

/** Рекомендованные роли метки: только метки, достигшие порога настроек. */
export function recommendedRoles(mark: ConsiliumJevMark): string[] {
  return (mark.present ?? [])
    .map((name) => ROLE_MARKS[name])
    .filter((role): role is string => role != null)
}