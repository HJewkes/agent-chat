import nodeFs from 'node:fs'
import path from 'node:path'
import { classify403, dayOf, ghCallsDir, type CallsFs, type GhCallLine } from './log.js'

export const RATE_LIMIT_CALLER = 'rate-limit'

export interface Count {
  name: string
  count: number
}

export interface CallsSummary {
  since: string
  total: number
  callers: Count[]
  routes: Count[]
  refused: { secondary: number; primary: number; unknown: number }
  /** The newest `caller: "rate-limit"` reading in the window. */
  rateLimit: { at: string; limits: Record<string, number> } | null
}

const isLine = (value: unknown): value is GhCallLine =>
  typeof value === 'object' && value !== null && (value as GhCallLine).v === 1

function parseLines(text: string): GhCallLine[] {
  return text.split('\n').flatMap(raw => {
    if (raw.trim() === '') return []
    try {
      const value: unknown = JSON.parse(raw)
      return isLine(value) ? [value] : []
    } catch {
      return []
    }
  })
}

/** Every line at or after `since`, reading only the day files that can hold one. */
export function readCalls(since: Date, fs: CallsFs = nodeFs, dir: string = ghCallsDir()): GhCallLine[] {
  if (!fs.existsSync(dir)) return []
  const fromDay = dayOf(since.toISOString())
  const sinceIso = since.toISOString()
  return fs
    .readdirSync(dir)
    .filter(name => name.endsWith('.jsonl') && name.slice(0, 10) >= fromDay)
    .sort()
    .flatMap(name => parseLines(fs.readFileSync(path.join(dir, name), 'utf8')))
    .filter(line => line.at >= sinceIso)
}

function topCounts(keys: string[], top: number): Count[] {
  const counts = new Map<string, number>()
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, top)
}

export function summarize(lines: GhCallLine[], since: Date, top: number): CallsSummary {
  const calls = lines.filter(line => line.caller !== RATE_LIMIT_CALLER)
  const refused = { secondary: 0, primary: 0, unknown: 0 }
  for (const line of calls) {
    const kind = classify403(line)
    if (kind !== null) refused[kind] += 1
  }
  const reading = lines.filter(line => line.caller === RATE_LIMIT_CALLER && line.limits).at(-1)
  return {
    since: since.toISOString(),
    total: calls.length,
    callers: topCounts(
      calls.map(line => line.caller),
      top,
    ),
    routes: topCounts(
      calls.map(line => `${line.method} ${line.route}`),
      top,
    ),
    refused,
    rateLimit: reading?.limits ? { at: reading.at, limits: reading.limits } : null,
  }
}

const countLines = (counts: Count[]): string[] => counts.map(({ name, count }) => `  ${count}  ${name}`)

export function renderSummary(summary: CallsSummary): string[] {
  const { refused, rateLimit } = summary
  const limits = rateLimit
    ? Object.entries(rateLimit.limits)
        .map(([resource, remaining]) => `${resource} ${remaining}`)
        .join(', ')
    : ''
  return [
    `${summary.total} GitHub calls since ${summary.since}`,
    'top callers:',
    ...countLines(summary.callers),
    'top routes:',
    ...countLines(summary.routes),
    `403/429: ${refused.secondary} secondary, ${refused.primary} primary, ${refused.unknown} unknown`,
    rateLimit ? `rate_limit at ${rateLimit.at}: ${limits}` : 'rate_limit: no reading in window',
  ]
}
