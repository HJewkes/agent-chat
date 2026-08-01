import { Hono } from 'hono'
import type {
  ErrorResponse,
  HistoryResponse,
  QueueResponse,
  SessionsResponse,
  TranscriptAnalytics,
  TranscriptResponse,
} from '../api-contract.js'
import type { SessionAnalytics } from '../agents/analytics/types.js'
import { parseSessionFile } from '../agents/analytics/parser.js'
import { findTranscript } from '../agents/transcript.js'
import type { BrokerCore } from './core.js'

/**
 * The read model over HTTP.
 *
 * Every route here is a GET, and that is a constraint rather than a stage we
 * have not finished: `POST /api/answer` and `/api/dismiss` land in a later wave
 * and will call `core.answer()`/`core.dismiss()`, which are the ONLY verdict
 * paths. Nothing in this file may ever write to the log — `core.append()` is the
 * single writer, and an HTTP route reaching past it would be the second one.
 *
 * Permission verdicts are permanently out of scope for any surface here. The
 * relay is observe-only by construction, and a dashboard write path would be a
 * backdoor around that, not a feature.
 *
 * The registry is read IN-PROCESS. It has to be: the live session list is keyed
 * by socket object and exists only in this process's memory, which is the whole
 * reason the HTTP layer lives in the broker instead of in the MCP subprocess.
 */

const DEFAULT_HISTORY_LIMIT = 200
const MAX_HISTORY_LIMIT = 1000

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

  return api
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
