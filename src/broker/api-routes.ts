import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import {
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  OWNER_CHANNEL_HEADER,
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
import {
  ANSWER_CHANNELS,
  isAnswerChannel,
  PERMISSION_BEHAVIORS,
  type PermissionBehavior,
} from '../protocol.js'
import type { BrokerCore } from './core.js'

/**
 * The read model over HTTP, plus a small set of writes.
 *
 * `POST /api/answer` and `POST /api/dismiss` call `core.answer()` /
 * `core.dismiss()` and nothing else, `POST /api/queue/:msgId/endorse` calls
 * `core.endorse()`, and `POST /api/queue/:msgId/permission` calls the socket
 * server's `permissionVerdict()`. Those are the ONLY verdict paths, shared with the socket
 * handler the CLI talks to, and they own the open-item and exact-bytes checks
 * that make a second or altered verdict lose deterministically. This file must
 * not re-check them — a duplicate check here would be a second arbiter, and the
 * two would drift. Nothing in this file may ever write to the log directly:
 * `core.append()` is the single writer, and an HTTP route reaching past it would
 * be the second one.
 *
 * The owner-console verdict routes (TP-1989) live under `/api/queue/:msgId/`.
 * The owner decided the console is a second human channel: every
 * human-in-the-loop item lands in it, endorsements and permission prompts
 * included (decision 72), and a LAN browser session may answer prompts and
 * endorse (decision 151). Each such route needs the ui token AND
 * `X-Owner-Channel: console`, and records `channel: owner-console` on the rows
 * it writes, so every HTTP verdict is auditable. That is same-user parity with
 * the unregistered 0600 socket (`approve_permission`, CC-96), not a stronger
 * proof: any process on the owner's account can read the 0600 token and send
 * the header, just as it can open the socket. The header is a label for audit,
 * not a credential.
 *
 * A bare `POST /api/approve` still does not exist, and a test asserts it: a
 * verdict route names the item it acts on and carries the owner-channel header.
 *
 * The registry is read IN-PROCESS. It has to be: the live session list is keyed
 * by socket object and exists only in this process's memory, which is the whole
 * reason the HTTP layer lives in the broker instead of in the MCP subprocess.
 */

export function apiRoutes(core: BrokerCore, verdicts?: OwnerVerdicts): Hono {
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

    // CC-100: under the agent's OWN config dir when the log knows one. The route
    // runs inside the broker, whose `CLAUDE_CONFIG_DIR` is an accident of which
    // session autostarted it — so for an agent spawned on a dedicated account the
    // scan below has nothing to find and every transcript reads as absent.
    const configDir = core.agents
      .roster({ includeRetired: true })
      .find(agent => agent.sessionId === sessionId)?.configDir
    const found = findTranscript(cwd, sessionId, configDir)
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

    // Only an absent channel defaults; an explicit null is refused, as the socket refuses it (CC-831).
    const given = (body as { channel?: unknown }).channel
    const channel = given === undefined ? 'dashboard' : given
    if (!isAnswerChannel(channel))
      return badRequest(c, `channel must be one of ${ANSWER_CHANNELS.join(', ')}`)

    const result: VerdictResponse = core.answer(msgId, text, channel)
    return c.json(result)
  })

  api.post('/dismiss', async c => {
    const msgId = stringField(await readJson(c), 'msgId')
    if (msgId === null) return badRequest(c, 'msgId is required')

    const result: VerdictResponse = core.dismiss(msgId)
    return c.json(result)
  })

  /**
   * The owner endorsing one composed message from the console (TP-1989).
   *
   * `text` and `to` are read raw: `core.endorse` delivers only on the stored
   * bytes, so trimming here would turn a correct approval of `"hello \n"` into a
   * refusal, or make a trimmed one look like the bytes the owner was shown.
   */
  api.post('/queue/:msgId/endorse', requireOwnerChannel, async c => {
    const body = await readJson(c)
    const text = rawStringField(body, 'text')
    const to = rawStringField(body, 'to')
    if (text === null || text === '') return badRequest(c, 'text is required')
    if (to === null || to === '') return badRequest(c, 'to is required')

    const result: VerdictResponse = core.endorse(c.req.param('msgId'), { text, to }, 'owner-console')
    return c.json(result)
  })

  /**
   * The owner answering a relayed permission prompt from the console (TP-1989).
   *
   * The arbiter is the socket server's, not core's: the hook waits and the
   * prompting session's connection live there. 503 when the app was built
   * without it, so a test or bare bind never reads as "no such prompt".
   */
  api.post('/queue/:msgId/permission', requireOwnerChannel, async c => {
    const behavior = rawStringField(await readJson(c), 'behavior')
    if (behavior === null || !isPermissionBehavior(behavior))
      return badRequest(c, `behavior must be one of ${PERMISSION_BEHAVIORS.join(', ')}`)
    if (verdicts === undefined) {
      const error: ErrorResponse = { error: 'permission verdicts are not wired' }
      return c.json(error, 503)
    }

    const result: VerdictResponse = verdicts.permission(c.req.param('msgId'), behavior, 'owner-console')
    return c.json(result)
  })

  return api
}

/** The socket server's permission arbiter, the one `approve_permission` runs (TP-1989). */
export interface OwnerVerdicts {
  permission(msgId: string, behavior: PermissionBehavior, channel: string): VerdictResponse
}

const isPermissionBehavior = (value: string): value is PermissionBehavior =>
  (PERMISSION_BEHAVIORS as readonly string[]).includes(value)

const OWNER_CONSOLE = 'console'

/** Exact match only: no trimming or case folding, so a near miss is refused. */
const requireOwnerChannel: MiddlewareHandler = async (c, next) => {
  if (c.req.header(OWNER_CHANNEL_HEADER) === OWNER_CONSOLE) return next()
  const error: ErrorResponse = { error: `${OWNER_CHANNEL_HEADER}: ${OWNER_CONSOLE} is required` }
  return c.json(error, 403)
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

function rawStringField(body: unknown, key: string): string | null {
  if (typeof body !== 'object' || body === null) return null
  const value = (body as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
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
