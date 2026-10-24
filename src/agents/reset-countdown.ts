/** A rate-limit window as the usage readouts print it (CC-1589). */
export interface UsageWindow {
  used_pct: number
  resets_at?: number
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** `1h28m`, `2d3h`, `45m`: the two largest units, so the reader never does the arithmetic. */
export function countdown(ms: number): string {
  if (ms < MINUTE_MS) return '<1m'
  const days = Math.floor(ms / DAY_MS)
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS)
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS)
  if (days > 0) return `${days}d${hours}h`
  return hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`
}

/** A reset a day or more out carries its weekday, since a bare clock time would name the wrong day. */
function clockTime(atMs: number, nowMs: number, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(atMs - nowMs >= DAY_MS ? { weekday: 'short' } : {}),
  }
  return new Intl.DateTimeFormat('en-US', options).format(new Date(atMs)).replace(',', '')
}

/** `(resets 18:00 MDT, in 1h28m)`, `(reset due)` once passed, or nothing without a resets_at. */
export function resetSuffix(resetsAt: number | undefined, nowMs: number, timeZone?: string): string {
  if (resetsAt === undefined) return ''
  const atMs = resetsAt * 1000
  if (atMs <= nowMs) return ' (reset due)'
  return ` (resets ${clockTime(atMs, nowMs, timeZone)}, in ${countdown(atMs - nowMs)})`
}

/** One window, e.g. `seven_day 90% (resets 18:00 MDT, in 1h28m)`; the time zone defaults to the machine's. */
export const formatUsageWindow = (
  name: string,
  window: UsageWindow,
  nowMs: number,
  timeZone?: string,
): string =>
  `${name} ${Math.round(window.used_pct * 10) / 10}%${resetSuffix(window.resets_at, nowMs, timeZone)}`
