import { PocketRagError } from './errors'

export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = 10_000
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new PocketRagError(`Request timed out: ${input}`, 'HTTP_TIMEOUT', error)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function readJson<T>(response: Response): Promise<T> {
  const body = await response.text()
  let parsed: unknown = null

  if (body) {
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = body
    }
  }

  if (!response.ok) {
    const detail =
      typeof parsed === 'object' && parsed !== null && 'detail' in parsed
        ? String(parsed.detail)
        : body || response.statusText
    throw new PocketRagError(detail, `HTTP_${response.status}`)
  }

  return parsed as T
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 1_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}
