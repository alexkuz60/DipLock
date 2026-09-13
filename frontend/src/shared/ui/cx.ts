/** Утилита склейки классов: clsx + tailwind-merge (без конфликтующих классов). */
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cx(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
