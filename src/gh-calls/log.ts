import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The gh-calls v1 log (TP-1172): one JSONL line per GitHub call, from every
 * caller that can be instrumented, in one file per UTC day. Format: docs/gh-calls.md.
 */

export const KEEP_DAYS = 7

/** How a rate-limited response was limited; writers that saw stderr set it, since stderr is never stored. */
export type LimitKind = 'secondary' | 'primary'

export interface GhCallLine {
  v: 1
  at: string
  caller: string
  api: 'rest' | 'graphql'
  method: string
  route: string
  /** The HTTP status, or `ok`/`error` from a caller that never sees one. */
  status: number | 'ok' | 'error'
  ms: number
  remaining: number | null
  resource: string | null
  limit?: LimitKind
  /** Seconds from `retry-after`, when the response carried it. */
  retryAfter?: number
  /** `x-ratelimit-used`, when the call saw it. */
  used?: number
  /** `x-ratelimit-reset`, epoch seconds, when the call saw it. */
  reset?: number
  /** Only on `caller: "rate-limit"` lines: remaining per resource. */
  limits?: Record<string, number>
}

export type CallInput = Omit<GhCallLine, 'v' | 'at' | 'remaining' | 'resource'> &
  Partial<Pick<GhCallLine, 'remaining' | 'resource'>>

export interface CallsFs {
  existsSync(file: string): boolean
  mkdirSync(dir: string, options: { recursive: true }): unknown
  appendFileSync(file: string, data: string): void
  readdirSync(dir: string): string[]
  readFileSync(file: string, encoding: 'utf8'): string
  unlinkSync(file: string): void
}

export const ghCallsDir = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'gh-calls')

export const callLine = (input: CallInput, now: Date = new Date()): GhCallLine => ({
  v: 1,
  at: now.toISOString(),
  ...input,
  remaining: input.remaining ?? null,
  resource: input.resource ?? null,
})

/** Owner, repo and every number become placeholders, and the query string goes, so routes count together. */
export function routeTemplate(apiPath: string): string {
  const [pathOnly = ''] = apiPath.split('?')
  const parts = pathOnly.replace(/^\/+|\/+$/g, '').split('/')
  if (parts[0] === 'repos' && parts.length >= 3) {
    parts[1] = '{o}'
    parts[2] = '{r}'
  }
  return parts.map(part => (/^\d+$/.test(part) ? '{n}' : part)).join('/')
}

/** GitHub names its secondary limit in the message body: "You have exceeded a secondary rate limit". */
export function limitFromStderr(text: string): LimitKind | undefined {
  if (/secondary rate limit|abuse detection/i.test(text)) return 'secondary'
  if (/API rate limit exceeded/i.test(text)) return 'primary'
  return undefined
}

/**
 * Which limit a refused call hit, or null when the call was not a 403 or 429.
 * Primary exhaustion reads `remaining 0`; a refusal with quota left is the secondary limit.
 */
export function classify403(line: GhCallLine): LimitKind | 'unknown' | null {
  if (line.status !== 403 && line.status !== 429) return null
  if (line.limit !== undefined) return line.limit
  if (line.remaining === 0) return 'primary'
  if (line.remaining !== null && line.remaining > 0) return 'secondary'
  return 'unknown'
}

export const dayOf = (at: string): string => at.slice(0, 10)

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

/** Removes day files older than `KEEP_DAYS` days counting `today`. */
export function pruneDays(dir: string, today: string, fs: CallsFs = nodeFs): void {
  const cutoff = new Date(Date.parse(today) - (KEEP_DAYS - 1) * 86_400_000).toISOString().slice(0, 10)
  for (const name of fs.readdirSync(dir)) {
    const day = DAY_FILE.exec(name)?.[1]
    if (day !== undefined && day < cutoff) fs.unlinkSync(path.join(dir, name))
  }
}

/**
 * Appends one line to its day's file, pruning on the first write of a day.
 * Best effort: a GitHub call never fails because its log line could not be written.
 */
export function appendCall(line: GhCallLine, fs: CallsFs = nodeFs, dir: string = ghCallsDir()): boolean {
  try {
    const day = dayOf(line.at)
    const file = path.join(dir, `${day}.jsonl`)
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true })
      pruneDays(dir, day, fs)
    }
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`)
    return true
  } catch {
    return false
  }
}
