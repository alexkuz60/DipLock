/**
 * Список предупреждений параметра («предупреждать, а не запрещать»): тексты
 * `shared/lib/epochRuleWarnings` у контролов «Длина эпохи» и «Окно STFT»
 * (п.4 плана — две половины правила «≥ 2 периодов» / «≥ 3C»). Пустой список —
 * компонент ничего не рисует, строка панели не «прыгает».
 */
export function WarnList({
  items,
  testId,
}: {
  items: readonly string[]
  /** Селектор для тестов: предупреждений может быть несколько (две половины правила) */
  testId?: string
}) {
  if (items.length === 0) return null
  return (
    <ul className="mt-1 list-inside list-disc text-sm text-warn" data-testid={testId}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  )
}
