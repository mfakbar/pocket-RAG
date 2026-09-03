function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '')
}

function cleanErrorMessage(error: unknown): string {
  return rawErrorMessage(error)
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '')
    .replace(/\/(?:Users|home)\/[^\s:]+/g, '[local path]')
    .replace(/(?:[A-Za-z]:\\Users\\)[^\\\s:]+/g, '[local path]')
    .trim()
}

export function friendlyActionError(error: unknown, fallback: string): string {
  const message = cleanErrorMessage(error)
  if (!message || message.length > 240) return fallback
  if (
    /(?:Traceback|ConnectError|\bat\s+\S+\s*\(|ECONN|ENOTFOUND|ERR_|\[SSL:|certificate verify|NoneType|python|node:|private\/var|_ssl\.c)/i.test(
      message
    )
  ) {
    return fallback
  }
  return message
}

export function safeTechnicalDetails(error: unknown): string | undefined {
  const message = cleanErrorMessage(error)
  return message ? message.slice(0, 800) : undefined
}
