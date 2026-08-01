/**
 * Status -> colour, for agent-chat's own vocabulary.
 *
 * Brain's version of this file mapped a PM workflow (task columns, priorities,
 * `completed`/`failed` agent lifecycles). None of that exists here. What exists
 * is `SESSION_STATUSES` in protocol.ts — exactly three values — plus the derived
 * states the dashboard adds on top: `dnd` and `stale`.
 */
import type { EventKind, SessionStatus } from '../../protocol.js'
import { C, semantic } from '../components/shared/colors.js'

const SESSION_STATUS_COLORS: Record<SessionStatus, string> = {
  working: semantic.status.active,
  available: semantic.status.success,
  blocked: semantic.status.blocked,
}

export function sessionStatusColor(status: SessionStatus | string | undefined): string {
  if (!status) return C.textTertiary
  return SESSION_STATUS_COLORS[status as SessionStatus] ?? C.textTertiary
}

/**
 * Queue items are coloured by what they ask of the human, not by their kind's
 * position in some lifecycle. `approval_request` is the loud one on purpose: it
 * is the only kind the UI can never resolve (docs §5), so it should not look
 * like the ones it can.
 */
const EVENT_KIND_COLORS: Partial<Record<EventKind, string>> = {
  question: semantic.status.warning,
  approval_request: semantic.status.error,
  message: semantic.status.info,
  broadcast: semantic.status.info,
  notice: C.textTertiary,
  answer: semantic.status.success,
  resolution: semantic.status.success,
  route_failed: semantic.status.error,
  agent_spawn_refused: semantic.status.error,
  registered: semantic.status.success,
  deregistered: C.textTertiary,
}

export function eventKindColor(kind: EventKind | string): string {
  return EVENT_KIND_COLORS[kind as EventKind] ?? C.textTertiary
}
