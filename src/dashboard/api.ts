/**
 * The dashboard's read path, plus the two writes the UI is allowed to make.
 *
 * Every shape here comes from `src/api-contract.ts` — deliberately imported
 * rather than restated, so this file cannot drift from the routes serving it.
 *
 * There is no `approve` here and there must never be one. Permission verdicts
 * are answered in the session's own terminal; the relay is observe-only by
 * construction and this file is exactly where a well-meaning backdoor would be
 * added (docs §5).
 */
import { TOKEN_HEADER } from '../api-contract.js'
import type {
  HealthPayload,
  HistoryResponse,
  QueueResponse,
  SessionsResponse,
  TranscriptResponse,
  VerdictResponse,
} from '../api-contract.js'
import type { SessionInfo } from '../protocol.js'

declare global {
  interface Window {
    /** Injected into the served HTML by the broker's dashboard route (docs §6.5). */
    __AGENT_CHAT_TOKEN__?: string
    /** Overridable for `vite dev` against a broker on another origin. */
    __AGENT_CHAT_API__?: string
  }
}

export const API_BASE = window.__AGENT_CHAT_API__ ?? ''

function headers(): HeadersInit {
  const token = window.__AGENT_CHAT_TOKEN__
  return token ? { [TOKEN_HEADER]: token } : {}
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: headers() })
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

export const fetchHealth = (): Promise<HealthPayload> => get<HealthPayload>('/health')
export const fetchSessions = (): Promise<SessionsResponse> => get<SessionsResponse>('/api/sessions')
export const fetchQueue = (): Promise<QueueResponse> => get<QueueResponse>('/api/queue')
export const fetchHistory = (limit = 200): Promise<HistoryResponse> =>
  get<HistoryResponse>(`/api/history?limit=${limit}`)

/**
 * The two writes, both of which resolve rather than throw on `ok: false`.
 *
 * "Already resolved elsewhere" is a normal concurrent outcome — someone typed
 * `agent-chat answer <id>` in a terminal a moment ago — and the broker reports it
 * as a 200 with `ok: false` for exactly that reason. Turning it into a rejection
 * here would put the most ordinary race in the product down the error path
 * (docs §5.1 rule 3). Only transport and auth failures throw.
 */
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

export const postAnswer = (msgId: string, text: string): Promise<VerdictResponse> =>
  post<VerdictResponse>('/api/answer', { msgId, text })

export const postDismiss = (msgId: string): Promise<VerdictResponse> =>
  post<VerdictResponse>('/api/dismiss', { msgId })

/**
 * `GET /api/transcript?sessionId=&cwd=`.
 *
 * A 404 is not a failure here — the route answers a miss with the full
 * `TranscriptResponse` shape and `exists: false`, because "Claude Code has not
 * written this session's JSONL" is a normal state and the path it looked at is
 * what a reader needs in order to say so. Only a 400/500 throws.
 */
export async function fetchTranscript(sessionId: string, cwd: string): Promise<TranscriptResponse> {
  const query = new URLSearchParams({ sessionId, cwd })
  const res = await fetch(`${API_BASE}/api/transcript?${query.toString()}`, { headers: headers() })
  if (res.ok || res.status === 404) return (await res.json()) as TranscriptResponse
  throw new Error(`/api/transcript -> ${res.status} ${res.statusText}`)
}

/**
 * The Claude Code session id for a registry session, or null when there is none
 * to be had.
 *
 * TODAY THIS IS ALWAYS NULL, and that is a gap in the wire protocol rather than
 * an oversight here. `/api/transcript` is keyed by Claude Code's session id;
 * `SessionInfo` (protocol.ts) carries `name`, `cwd`, status and presence, but no
 * session id. The broker HAS the value — the `register` frame carries
 * `sessionId`, read by the MCP subprocess from `CLAUDE_CODE_SESSION_ID` in its
 * own environment — it simply does not survive into the registry's public shape.
 *
 * So the join is read defensively rather than faked. The moment `SessionInfo`
 * gains the field under `observed` (the correct side of the observed/declared
 * trust split: it is read from the process, never asked of the model), every
 * transcript panel in this dashboard lights up with no other change. Until then
 * the UI says "no transcript analytics" and means it.
 */
export function claudeSessionIdOf(session: SessionInfo): string | null {
  const observed = session.observed as Record<string, unknown> | undefined
  const id = observed?.['claudeSessionId'] ?? observed?.['sessionId']
  return typeof id === 'string' && id !== '' ? id : null
}
