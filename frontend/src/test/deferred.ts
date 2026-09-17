/**
 * Отложенный результат для тестов: обещание, которым распоряжается сам тест.
 *
 * Нужен там, где важен порядок «ответ сервера пришёл **после** действия
 * пользователя» — например, отмена поллинга: сброс раздела или закрытие записи
 * случаются, пока задача ещё «висит» на опросе.
 */
export type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
