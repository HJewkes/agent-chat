import fs from 'node:fs'
import { PRICE_TABLE_VERSION, priceRequest } from '@titan-design/session-analytics'

/**
 * What a whole session spent, summed from its transcript (CC-329).
 *
 * `transcript-usage.ts` reads the last usage record, which is the context fill. Spend is every request the
 * session made, so this reads the whole file, streamed because a long session's transcript runs to many
 * megabytes. A subagent's turns are spend too, so sidechain records count.
 */

export interface SpendUsage {
  input: number
  cache_read: number
  cache_write_5m: number
  cache_write_1h: number
  output: number
}

export interface TranscriptSpend {
  ok: true
  path: string
  /** Every class of `usage` summed. */
  tokens: number
  /** List price to 4 places, or null when any request's model has no price row: a partial sum would under-read. */
  usd_est: number | null
  usage: SpendUsage
  models: string[]
  /** The models that made `usd_est` null. */
  unpriced: string[]
  price_table: number
}

export type TranscriptSpendRead = TranscriptSpend | { ok: false; path: string; reason: string }

interface Request {
  model: string
  ts: string
  usage: SpendUsage
}

const SYNTHETIC = '<synthetic>'
const USAGE_KEYS = ['input', 'cache_read', 'cache_write_5m', 'cache_write_1h', 'output'] as const

/** Never rejects: the transcript belongs to another program and may be anything, or absent. */
export async function readTranscriptSpend(file: string): Promise<TranscriptSpendRead> {
  try {
    const requests = await readRequests(file)
    if (requests.length === 0) {
      return { ok: false, path: file, reason: 'no assistant usage record in the transcript' }
    }
    return { ok: true, path: file, ...spendOf(requests) }
  } catch (error) {
    return { ok: false, path: file, reason: missReason(error) }
  }
}

/** The error's code and not its message, which holds the path. */
function missReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOENT') return 'no transcript written'
  return `unreadable transcript (${code ?? (error as Error | null)?.name ?? 'unknown'})`
}

/** Claude Code writes one record per content block of a response, each with the response's usage, so the last per id stands. */
async function readRequests(file: string): Promise<Request[]> {
  const byMessage = new Map<string, Request>()
  let unnamed = 0
  for await (const line of transcriptLines(file)) {
    const found = requestOf(line)
    if (found !== undefined) byMessage.set(found.id ?? `#${unnamed++}`, found.request)
  }
  return [...byMessage.values()]
}

async function* transcriptLines(file: string): AsyncGenerator<string> {
  let rest = ''
  for await (const chunk of fs.createReadStream(file, 'utf8') as AsyncIterable<string>) {
    const lines = (rest + chunk).split('\n')
    rest = lines.pop() ?? ''
    yield* lines
  }
  if (rest !== '') yield rest
}

function requestOf(line: string): { id: string | undefined; request: Request } | undefined {
  // Most of a transcript's bytes are tool output; only a record naming usage is worth parsing.
  if (!line.includes('"usage"')) return undefined
  const record = parseLine(line)
  const message = isRecord(record?.message) ? record.message : undefined
  if (record?.type !== 'assistant' || message === undefined || message.model === SYNTHETIC) return undefined
  if (!isRecord(message.usage)) return undefined
  return {
    id: text(message.id),
    request: {
      model: text(message.model) ?? 'unknown',
      ts: text(record.timestamp) ?? '',
      usage: usageOf(message.usage),
    },
  }
}

/** A record without the 5m/1h split counts its whole cache write as 5m, as the price table does. */
function usageOf(usage: Record<string, unknown>): SpendUsage {
  const split = isRecord(usage.cache_creation) ? usage.cache_creation : {}
  const write5m = count(split.ephemeral_5m_input_tokens)
  const write1h = count(split.ephemeral_1h_input_tokens)
  return {
    input: count(usage.input_tokens),
    cache_read: count(usage.cache_read_input_tokens),
    cache_write_5m: write5m + write1h === 0 ? count(usage.cache_creation_input_tokens) : write5m,
    cache_write_1h: write1h,
    output: count(usage.output_tokens),
  }
}

function spendOf(requests: readonly Request[]): Omit<TranscriptSpend, 'ok' | 'path'> {
  const usage: SpendUsage = { input: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, output: 0 }
  const models = new Set<string>()
  const unpriced = new Set<string>()
  let usd = 0
  for (const request of requests) {
    for (const key of USAGE_KEYS) usage[key] += request.usage[key]
    models.add(request.model)
    const price = priceOf(request)
    if (price === null) unpriced.add(request.model)
    else usd += price
  }
  return {
    tokens: USAGE_KEYS.reduce((total, key) => total + usage[key], 0),
    usd_est: unpriced.size > 0 ? null : Math.round(usd * 1e4) / 1e4,
    usage,
    models: [...models],
    unpriced: [...unpriced],
    price_table: PRICE_TABLE_VERSION,
  }
}

/** Each request prices by its own model and timestamp; null when the platform's table has no row for it. */
function priceOf({ model, ts, usage }: Request): number | null {
  const priced = priceRequest(
    {
      inputTokens: usage.input,
      cacheReadTokens: usage.cache_read,
      cacheCreation5mTokens: usage.cache_write_5m,
      cacheCreation1hTokens: usage.cache_write_1h,
      outputTokens: usage.output,
    },
    model,
    ts,
  )
  return priced.priced ? priced.costUsd : null
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const doc: unknown = JSON.parse(line)
    return isRecord(doc) ? doc : undefined
  } catch {
    return undefined
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
