import { EVENT_KINDS, NON_KIND_SSE_EVENTS } from './protocol.js'
import type { EventKind, QueueItem, SessionInfo } from './protocol.js'

/**
 * The frozen HTTP + SSE contract, written once and imported by both the API and
 * the dashboard. This is service plan Step 2a, and its whole purpose is to let
 * steps 3, 4 and 5 proceed in parallel against a shape nobody has to renegotiate.
 *
 * WHY THIS IS NOT `src/dashboard/types.ts`, which is where the plan puts it.
 * Step 5 adds `src/dashboard` to tsconfig's `exclude`, because that directory
 * gains JSX and DOM globals that the main build (`lib: ES2023`, no DOM) cannot
 * compile. An excluded file emits no `.js`, so `broker/api-routes.ts` importing
 * it would typecheck in the editor and fail at runtime — and it would fail in
 * step 5, well after the import was written in step 4, which is the worst place
 * to discover it.
 *
 * So the contract lives here, in the compiled tree. The dashboard can re-export
 * it from `dashboard/types.ts` for local convenience; what it must not do is own
 * it. One file, two importers, and the exclusion stays harmless.
 */

/** `GET /health`. Callable without HTTP — see `broker/health.ts`. */
export interface HealthPayload {
  ok: boolean
  version: string
  pid: number
  uptime_ms: number
  /** Null when the HTTP bind was refused. The bind is best-effort by design. */
  port: number | null
  socket: string
  sessions: number
  queue_open: number
}

/** `GET /api/queue` — open items only; resolved ones are absent, not flagged. */
export interface QueueResponse {
  items: QueueItem[]
}

/**
 * `GET /api/sessions`.
 *
 * `brokerUptimeMs` is not decoration. Process lifetime IS the registration lease
 * and the registry is in-memory, so for up to ~9s after a restart this list is
 * legitimately empty or partial while clients climb the reconnect ladder. A UI
 * that renders an empty list as fact will tell the user every session died. Under
 * ~10s, say "broker restarted, sessions reconnecting" instead.
 */
export interface SessionsResponse {
  sessions: SessionInfo[]
  brokerUptimeMs: number
}

export interface HistoryResponse {
  items: QueueItem[]
}

/** `POST /api/answer` and `POST /api/dismiss` both return this. */
export interface VerdictResponse {
  ok: boolean
  reason?: string
}

export interface AnswerRequest {
  msgId: string
  text: string
}

export interface DismissRequest {
  msgId: string
}

/**
 * One SSE frame per appended row, carrying the row id as the SSE event id so the
 * browser's native EventSource sends `Last-Event-ID` on reconnect with no client
 * bookkeeping at all.
 */
export interface EventFrameData {
  id: number
  ts: number
  kind: EventKind
  actor: string
  target: string | null
  msgId: string | null
  ref: string | null
  body: string | null
  meta: Record<string, string>
}

/**
 * Frames that must NOT carry an SSE `id:`.
 *
 * Status and `awaitingApproval` are in-memory presence and were always meant to
 * be — writing them to the log to make the UI live would turn ephemeral presence
 * into permanent history. Because they are not rows, they have no id, and giving
 * them one would advance the resume cursor past rows that do not exist. The UI
 * treats this as "refetch /api/sessions".
 *
 * This is subtle enough that `sse.ts` should restate it: a future contributor
 * will otherwise add an id for symmetry.
 */
export interface TransientFrameData {
  reason: 'status' | 'presence'
}

/**
 * Sent instead of a replay when the gap exceeds `MAX_REPLAY_ROWS`, so a browser
 * left open overnight cannot replay the entire log. The UI refetches.
 */
export interface ResetFrameData {
  reason: 'gap_too_large'
  latestId: number
}

/**
 * Every valid SSE `event:` name, as a runtime value. Derived from EVENT_KINDS
 * rather than restated, so a new event kind cannot reach the log without also
 * being a legal frame name — the drift 2a exists to prevent.
 */
export const SSE_EVENT_NAMES = [...EVENT_KINDS, ...NON_KIND_SSE_EVENTS] as const

export type SseEventName = (typeof SSE_EVENT_NAMES)[number]

export const MAX_REPLAY_ROWS = 500

/** Matches active-work's HEARTBEAT_MS; keeps proxies and dead-peer detection healthy. */
export const HEARTBEAT_MS = 25_000

export const TOKEN_HEADER = 'X-Agent-Chat-Token'
