import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  type ErrorResponse,
  type HistoryResponse,
  type QueueResponse,
  type SessionsResponse,
  type TranscriptAnalytics,
  type TranscriptResponse,
  type VerdictResponse,
} from '../api-contract.js'
import type { SessionAnalytics } from '../agents/analytics/types.js'
import { parseSessionFile } from '../agents/analytics/parser.js'
import { findTranscript } from '../agents/transcript.js'
import type { BrokerCore } from './core.js'

/**
 * The read model over HTTP, plus exactly two writes.
 *
 * `POST /api/answer` and `POST /api/dismiss` call `core.answer()` /
 * `core.dismiss()` and nothing else. Those are the ONLY verdict paths, shared
 * with the socket handler the CLI talks to, and they own the `isOpen` check that
 * makes a second verdict on an item lose deterministically. This file must not
 * re-check it — a duplicate check here would be a second arbiter, and the two
 * would drift. Nothing in this file may ever write to the log directly:
 * `core.append()` is the single writer, and an HTTP route reaching past it would
 * be the second one.
 *
 * `POST /api/approve` does not exist and never will. Permission verdicts are
 * permanently out of scope for any surface here — the relay is observe-only by
 * construction, and a dashboard write path would be a backdoor around that, not
 * a feature. Its absence is asserted by a test, deliberately.
 *
 * The registry is read IN-PROCESS. It has to be: the live session list is keyed
 * by socket object and exists only in this process's memory, which is the whole
 * reason the HTTP layer lives in the broker instead of in the MCP subprocess.
 */

export function apiRoutes(core: BrokerCore): Hono {
  const api = new Hono()

  api.get('/queue', c => {
    const body: QueueResponse = { items: core.events.humanQueue() }
    return c.json(body)
  })

  api.get('/sessions', c => {
    const body: SessionsResponse = {
      sessions: core.registry.list(),
      // Not decoration. The registry is in-memory and process lifetime IS the
      // registration lease, so for a few seconds after a restart this list is
      // legitimately empty while clients climb the reconnect ladder. A reader
      // that knows the uptime can say "reconnecting" instead of "everyone died".
      brokerUptimeMs: Date.now() - core.startedAt,
    }
    return c.json(body)
  })

  api.get('/history', c => {
    const body: HistoryResponse = { items: core.events.history(historyLimit(c.req.query('limit'))) }
    return c.json(body)
  })

  /**
   * The session's own transcript, folded into analytics.
   *
   * This is the one route that reads something the broker does not own: Claude
   * Code's per-session JSONL. We can find it because we recorded the session id
   * at spawn, and `findTranscript` corrects the derived path against reality
   * (the slug is computed from the cwd we asked for; Claude Code records the one
   * it resolved, and those differ through a symlink).
   *
   * `cwd` is optional and only makes the lookup faster — without it the derived
   * path misses and the scan by session id, which is a uuid and therefore unique
   * across every project, gives the exact same answer.
   */
  api.get('/transcript', async c => {
    const sessionId = (c.req.query('sessionId') ?? '').trim()
    const cwd = c.req.query('cwd') ?? ''
    if (sessionId === '') {
      const error: ErrorResponse = { error: 'sessionId is required' }
      return c.json(error, 400)
    }

    const found = findTranscript(cwd, sessionId)
    if (!found.exists) {
      // 404 with the full shape, not a bare error: "no transcript yet" is a
      // normal state for an agent that has not written its first turn, and the
      // path is what a reader needs to say so.
      const body: TranscriptResponse = { sessionId, cwd, path: found.path, exists: false, analytics: null }
      return c.json(body, 404)
    }

    try {
      const analytics = await parseSessionFile(found.path)
      const body: TranscriptResponse = {
        sessionId,
        cwd,
        path: found.path,
        exists: true,
        analytics: toJsonAnalytics(analytics),
      }
      return c.json(body)
    } catch (err) {
      // The file is another program's, and it can be truncated mid-write or
      // reaped between the existence check and the read.
      const error: ErrorResponse = { error: `could not read transcript: ${String(err)}` }
      return c.json(error, 500)
    }
  })

  /**
   * The human answering a queue item from the browser.
   *
   * `ok: false` is a 200, not a 4xx. "Already resolved elsewhere" is the design
   * working — someone answered from a terminal a moment ago — and the UI shows it
   * inline while waiting for the SSE `answer`/`resolution` frame to retire the
   * row. An error status would push the dashboard into a failure branch for the
   * most ordinary concurrent outcome there is (docs §5.1 rule 3). A 400 is
   * reserved for a request that is malformed, which is a client bug.
   */
  api.post('/answer', async c => {
    const body = await readJson(c)
    const msgId = stringField(body, 'msgId')
    const text = stringField(body, 'text')
    if (msgId === null) return badRequest(c, 'msgId is required')
    if (text === null || text === '') return badRequest(c, 'text is required')

    const result: VerdictResponse = core.answer(msgId, text)
    return c.json(result)
  })

  api.post('/dismiss', async c => {
    const msgId = stringField(await readJson(c), 'msgId')
    if (msgId === null) return badRequest(c, 'msgId is required')

    const result: VerdictResponse = core.dismiss(msgId)
    return c.json(result)
  })

  return api
}

function badRequest(c: Context, message: string): Response {
  const error: ErrorResponse = { error: message }
  return c.json(error, 400)
}

/** A malformed or absent body is an empty object, so field validation reports it. */
async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return {}
  }
}

function stringField(body: unknown, key: string): string | null {
  if (typeof body !== 'object' || body === null) return null
  const value = (body as Record<string, unknown>)[key]
  return typeof value === 'string' ? value.trim() : null
}

function historyLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_HISTORY_LIMIT
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_HISTORY_LIMIT
  return Math.min(parsed, MAX_HISTORY_LIMIT)
}

/**
 * `JSON.stringify(new Map([['a', 1]]))` is `{}` — no error, no warning, a 200
 * with a well-formed body that has silently lost three fields. Convert here so
 * the loss cannot happen, and so the wire type can state the shape.
 */
function toJsonAnalytics(analytics: SessionAnalytics): TranscriptAnalytics {
  const { filesTouched, modelCounts, skillUsage, ...rest } = analytics
  return {
    ...rest,
    filesTouched: Object.fromEntries([...filesTouched].map(([tool, files]) => [tool, [...files]])),
    modelCounts: Object.fromEntries(modelCounts),
    skillUsage: Object.fromEntries(skillUsage),
  }
}
