import path from 'node:path'
import { activeWorkPort } from '../paths.js'

/**
 * CC-101: what a spawned agent should read, ranked against its own assignment.
 *
 * The briefing used to list the five newest notes by date. Measured on 608 real
 * spawns (titan-platform TP-84), that list recalled 0.6% of what the agents went
 * on to read; relevance retrieval on the brief text recalled 20% in a sixth of
 * the characters. The retrieval lives in the active-work daemon as
 * `context.related`, so the broker asks it over loopback HTTP.
 *
 * ## Fail-open, and nothing else
 *
 * The daemon is another program that may not be running. Every failure (refused,
 * slow, non-2xx, `ok:false`, malformed) becomes one warning on the spawn and no
 * section; nothing throws, and nothing waits past the timeout. There is no
 * fallback to the date-ordered list: the owner decided to replace it, and a list
 * that measured at 0.6% is not a degraded mode worth keeping.
 */

export const RELATED_TIMEOUT_MS = 300
const RELATED_LIMIT = 6
const RELATED_BUDGET = 1_500
const RELATED_CLASSES = ['notes', 'sources', 'tasks', 'sessions']
const TITLE_MAX = 80

export interface RelatedHit {
  ref: string
  initiative: string
  title: string
  /** Relative to the active-work root, as the daemon reports it. */
  path: string
}

export type RelatedResult = { hits: RelatedHit[] } | { warning: string }

export interface RelatedQuery {
  /** The assignment brief; the daemon derives its own ranked terms from it. */
  query: string
  initiative: string
  fetch?: typeof fetch
  port?: number
  timeoutMs?: number
}

class DaemonError extends Error {}

const unavailable = (reason: string): RelatedResult => ({
  warning: `related context unavailable (active-work daemon: ${reason}); briefing rendered without it`,
})

const reasonFor = (err: unknown, timeoutMs: number): string => {
  if (err instanceof DaemonError) return err.message
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))
    return `no answer within ${timeoutMs} ms`
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | undefined)?.cause
  if (typeof cause?.code === 'string') return cause.code
  if (typeof cause?.message === 'string') return cause.message
  return err instanceof Error ? err.message : String(err)
}

/** Rejects when the signal fires, so a fetch that ignores its signal still cannot hold the spawn. */
const aborted = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true })
  })

const isHit = (value: unknown): value is RelatedHit => {
  const hit = value as Record<string, unknown> | null
  return (
    typeof hit === 'object' &&
    hit !== null &&
    ['ref', 'initiative', 'title', 'path'].every(key => typeof hit[key] === 'string')
  )
}

async function readEnvelope(res: Response): Promise<unknown> {
  let body: { ok?: unknown; error?: unknown; data?: { hits?: unknown } }
  try {
    body = (await res.json()) as typeof body
  } catch {
    throw new DaemonError(res.ok ? 'malformed JSON response' : `HTTP ${res.status}`)
  }
  if (body?.ok === false) throw new DaemonError(`refused the query: ${String(body.error)}`)
  if (!res.ok) throw new DaemonError(`HTTP ${res.status}`)
  if (body?.ok !== true || !Array.isArray(body.data?.hits))
    throw new DaemonError('malformed response envelope')
  return body.data.hits
}

async function postRelated(q: RelatedQuery, query: string, signal: AbortSignal): Promise<unknown> {
  const fetchImpl = q.fetch ?? fetch
  const res = await fetchImpl(`http://127.0.0.1:${q.port ?? activeWorkPort()}/rpc/context.related`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      for: query,
      initiative: q.initiative,
      limit: RELATED_LIMIT,
      budget: RELATED_BUDGET,
      classes: RELATED_CLASSES,
      exclude: [],
    }),
    signal,
  })
  return readEnvelope(res)
}

/** Ask the daemon what relates to this brief. Never throws; never outlasts the timeout. */
export async function fetchRelated(q: RelatedQuery): Promise<RelatedResult> {
  const query = q.query.trim()
  if (query === '') return { hits: [] }
  const timeoutMs = q.timeoutMs ?? RELATED_TIMEOUT_MS
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const hits = await Promise.race([postRelated(q, query, signal), aborted(signal)])
    return { hits: (hits as unknown[]).filter(isHit) }
  } catch (err) {
    return unavailable(reasonFor(err, timeoutMs))
  }
}

const shortTitle = (title: string): string =>
  title.length <= TITLE_MAX ? title : `${title.slice(0, TITLE_MAX - 1).trimEnd()}…`

const hitLine = (hit: RelatedHit, slug: string, root: string): string => {
  const foreign = hit.initiative === slug ? '' : `[from \`${hit.initiative}\`] `
  return `- ${foreign}${hit.ref} "${shortTitle(hit.title)}" ${path.join(root, hit.path)}`
}

/** The ranked section, or nothing when there are no hits to show. */
export function relatedSection(hits: RelatedHit[], slug: string, root: string): string {
  const lines: string[] = []
  let used = 0
  for (const hit of hits.slice(0, RELATED_LIMIT)) {
    const line = hitLine(hit, slug, root)
    if (used + line.length + 1 > RELATED_BUDGET) break
    lines.push(line)
    used += line.length + 1
  }
  if (lines.length === 0) return ''
  return `## Related to this assignment (${lines.length}, ranked; open with Read)\n\n${lines.join('\n')}`
}
