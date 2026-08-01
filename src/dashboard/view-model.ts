/**
 * The seam between agent-chat's wire shapes and brain's copied components.
 *
 * Brain's card took a `DashboardAgent`: one flat object with tokens, cost, a
 * PM task id and a branch, all assembled server-side from its own database.
 * agent-chat has no equivalent object and should not grow one — presence comes
 * from the registry (`/api/sessions`, live, ephemeral) and metrics come from a
 * transcript on disk (`/api/transcript`, historical, sometimes absent). They
 * arrive separately and one can exist without the other.
 *
 * So this module joins them into an `AgentVM` and, crucially, makes the
 * transcript OPTIONAL. A session with no transcript is a normal session with
 * unknown metrics, not a broken one, and the card has to say so rather than
 * render six confident zeroes.
 */
import type { TranscriptAnalytics } from '../api-contract.js'
import type { SessionInfo } from '../protocol.js'

export interface AgentMetrics {
  toolCalls: number
  errors: number
  errorRate: number
  tokensIn: number
  tokensOut: number
  /** Tool names in call order, newest last — the sparkline's input. */
  toolSequence: string[]
  frictionCount: number
  filesWritten: number
  subagentCount: number
  durationMs: number
  model: string | null
}

export interface AgentVM {
  session: SessionInfo
  /** Null when no transcript could be found for this session. */
  metrics: AgentMetrics | null
  /** Why `metrics` is null, in one renderable line. Empty when metrics exist. */
  notice: string
}

export function toMetrics(t: TranscriptAnalytics): AgentMetrics {
  return {
    toolCalls: t.toolCalls.length,
    errors: t.errorCount,
    errorRate: t.errorRate,
    tokensIn: t.tokens.inputTokens,
    tokensOut: t.tokens.outputTokens,
    toolSequence: t.toolCalls.map((c) => c.toolName),
    frictionCount: t.frictionSignals.length,
    filesWritten: t.filesWritten.length,
    subagentCount: t.subagentCount,
    durationMs: t.durationMs,
    model: t.model,
  }
}

/** The session's git branch, which is observed from its process — never declared. */
export function branchOf(session: SessionInfo): string | null {
  return session.observed?.gitBranch ?? null
}

/**
 * `working` is the closest thing to brain's `active`, but `blocked` counts too:
 * a blocked session is one with an open approval_request, which is a session
 * very much in flight and the single most interesting row on the page.
 */
export function isLive(session: SessionInfo): boolean {
  return session.status === 'working' || session.status === 'blocked'
}

/** Active first, then blocked-ness, then most recently active. Stable within groups. */
export function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  const rank = (s: SessionInfo): number => (s.status === 'blocked' ? 0 : s.status === 'working' ? 1 : 2)
  return [...sessions].sort((a, b) => rank(a) - rank(b) || a.idleMs - b.idleMs)
}

export function fmtIdle(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s idle`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m idle`
  return `${Math.floor(m / 60)}h ${m % 60}m idle`
}
