/**
 * Доставка файла пользователю (срез 2.8): Blob → временная ссылка → скачивание.
 *
 * Скачивание инициирует сам браузер, сервер в экспорте не участвует — данные
 * уже в памяти страницы (кадр сигналов, слои, снапшот canvas). Здесь только
 * техническая часть: создать ссылку, кликнуть по ней и не забыть освободить URL.
 *
 * Функции принимают `document` параметром (по умолчанию — текущий): так же, как
 * `drawSnapshot`, они остаются тестируемыми и не тянут глобальный DOM в модуль.
 */

/** Скачивает готовый Blob под именем ``name``. */
export function downloadBlob(name: string, blob: Blob, doc: Document = document): void {
  const url = URL.createObjectURL(blob)
  const link = doc.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  link.style.display = 'none'
  doc.body.appendChild(link)
  try {
    link.click()
  } finally {
    link.remove()
    // Файл уже отдан браузеру — держать ссылку в памяти незачем
    URL.revokeObjectURL(url)
  }
}

/** Скачивает текст (CSV/JSON) как файл с заданным MIME. */
export function downloadText(
  name: string,
  text: string,
  mime = 'text/csv;charset=utf-8',
  doc: Document = document,
): void {
  downloadBlob(name, new Blob([text], { type: mime }), doc)
}

/**
 * Кодирует холст в PNG. Ошибки кодирования отдаются исключением с понятным
 * текстом: экспорт — действие по кнопке, и пользователь должен увидеть причину,
 * а не пустой файл (в jsdom/старых браузерах `toBlob` может отсутствовать).
 */
export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') {
      reject(new Error('PNG-экспорт не поддерживается браузером'))
      return
    }
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Не удалось собрать PNG'))
    }, 'image/png')
  })
}