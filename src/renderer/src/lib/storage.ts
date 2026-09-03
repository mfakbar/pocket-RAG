export function readLocalValue(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function readLocalJson<T>(key: string, fallback: T): unknown {
  const value = readLocalValue(key)
  if (value === null) return fallback
  try {
    return JSON.parse(value) as unknown
  } catch {
    return fallback
  }
}

export function writeLocalValue(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch (error) {
    console.warn(`Could not save ${key}:`, error)
    return false
  }
}

export function writeLocalJson(key: string, value: unknown): boolean {
  return writeLocalValue(key, JSON.stringify(value))
}
