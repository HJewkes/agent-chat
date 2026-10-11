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

/**
 * CC-138: measured against the live daemon on 2026-09-23 (load average 4.98,
 * `docs/measurements/cc138-related-latency.md`) with 20 distinct, never-before-seen
 * `context.related` queries: min 354 ms, median 1105 ms, p95 2247 ms. 2500 ms covers
 * that p95 with margin while staying under the 3 s hard cap on how long a spawn may
 * wait for this section.
 */
export const RELATED_TIMEOUT_MS = 2_500
const RELATED_LIMIT = 6
/** What the daemon counts against, rendered its own way (ref, title, relative path, excerpt). */
const RELATED_BUDGET = 1_500
/**
 * CC-164: what the rendered section may use, and what the briefing keeps free for it.
 * Six lines at 420 chars (an 80-char title, the longest source path on disk at 278, a
 * ref and a foreign tag) plus the heading. The median path is 144, so six typical
 * lines take about 1,650.
 */
export const RELATED_RESERVE = 2_600
const RELATED_CLASSES = ['notes', 'sources', 'tasks', 'sessions']
const TITLE_MAX = 80
/** CC-759: the daemon allows 160; half keeps six annotated lines inside RELATED_RESERVE. */
const READ_IF_MAX = 80

export interface RelatedHit {
  ref: string
  initiative: string
  title: string
  /** Relative to the active-work root, as the daemon reports it. */
  path: string
  /** CC-759: a note's own `read_if`, present only when its file declares one. */
  readIf?: string
}

export type RelatedResult = { hits: RelatedHit[] } | { warning: string }

export interface RelatedQuery {
  /** The assignment brief; the daemon derives its own ranked terms from it. */
  query: string
  initiative: string
  fetch?: typeof fetch
  port?: number
  timeoutMs?: number
  /** Most hits to return; defaults to the six the section shows. */
  limit?: number
  /** Set only on the call that records what was rendered: the daemon logs every hit it returns as served. */
  trigger?: 'spawn'
  now?: () => number
}

class DaemonError extends Error {}

const unavailable = (reason: string, elapsedMs: number, timeoutMs: number): RelatedResult => ({
  warning:
    `related context unavailable (active-work daemon: ${reason}, after ${elapsedMs} ms of ` +
    `${timeoutMs} ms budget); briefing rendered without it`,
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

/** A malformed `readIf` costs the annotation, not the hit. */
const withValidReadIf = (hit: RelatedHit): RelatedHit => {
  if (hit.readIf === undefined || typeof hit.readIf === 'string') return hit
  const { readIf: _dropped, ...rest } = hit
  return rest
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
      limit: q.limit ?? RELATED_LIMIT,
      budget: RELATED_BUDGET,
      classes: RELATED_CLASSES,
      exclude: [],
      ...(q.trigger === undefined ? {} : { trigger: q.trigger }),
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
  const now = q.now ?? Date.now
  const signal = AbortSignal.timeout(timeoutMs)
  const startedAt = now()
  try {
    const hits = await Promise.race([postRelated(q, query, signal), aborted(signal)])
    return { hits: (hits as unknown[]).filter(isHit).map(withValidReadIf) }
  } catch (err) {
    return unavailable(reasonFor(err, timeoutMs), now() - startedAt, timeoutMs)
  }
}

const bounded = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`

const readIfNote = (readIf: string | undefined): string =>
  readIf ? ` (read if: ${bounded(readIf, READ_IF_MAX)})` : ''

const hitLine = (hit: RelatedHit, slug: string, root: string): string => {
  const foreign = hit.initiative === slug ? '' : `[from \`${hit.initiative}\`] `
  const title = `"${bounded(hit.title, TITLE_MAX)}"${readIfNote(hit.readIf)}`
  return `- ${foreign}${hit.ref} ${title} ${path.join(root, hit.path)}`
}

export interface RenderedRelated {
  text: string
  /** The ranked prefix of the hits that made it into `text`, one line each. */
  lines: string[]
}

/** The ranked section within the reserve, or nothing when there are no hits to show. */
export function relatedSection(hits: RelatedHit[], slug: string, root: string): RenderedRelated {
  const heading = (count: number) => `## Related to this assignment (${count}, ranked; open with Read)\n\n`
  const lines: string[] = []
  let used = heading(RELATED_LIMIT).length
  for (const hit of hits.slice(0, RELATED_LIMIT)) {
    const line = hitLine(hit, slug, root)
    if (used + line.length + 1 > RELATED_RESERVE) break
    lines.push(line)
    used += line.length + 1
  }
  if (lines.length === 0) return { text: '', lines }
  return { text: `${heading(lines.length)}${lines.join('\n')}`, lines }
}
