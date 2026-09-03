export function formatBytes(
  bytes: number | null,
  {
    decimals = 1,
    unavailable = 'Unavailable',
    zero = '0 MB'
  }: { decimals?: number; unavailable?: string; zero?: string } = {}
): string {
  if (bytes === null || bytes <= 0) return bytes === 0 ? zero : unavailable
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  const precision = exponent === 0 ? 0 : decimals
  return `${value.toFixed(precision)} ${units[exponent]}`
}

export function formatDateTime(value: string | null, fallback = 'Not synced yet'): string {
  if (!value) return fallback
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return fallback
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date)
}

export function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function formatLatency(value: number | null): string {
  if (value === null) return '-'
  return value < 1_000
    ? `${value.toFixed(value < 100 ? 1 : 0)} ms`
    : `${(value / 1_000).toFixed(2)} s`
}

export function formatTokenSpeed(value: number | null): string {
  return value === null ? '-' : `${value.toFixed(1)} tok/s`
}
