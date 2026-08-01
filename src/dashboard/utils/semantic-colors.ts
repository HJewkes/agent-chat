/**
 * Status -> colour, for agent-chat's own vocabulary, resolved through
 * titan-design's `status-*` semantic tokens.
 *
 * What exists here is `SESSION_STATUSES` in protocol.ts — exactly three values.
 * `dnd` is NOT one of them: it is a separate boolean field on the session, so
 * it gets a muted chip rather than a status colour of its own.
 *
 * `working` maps to `status-live` ("live right now") rather than to
 * `brand-primary`, so the brand colour is not spent on a status. `available`
 * deliberately takes `status-live-muted` rather than `status-success`, because
 * titan resolves `status-live` and `status-success` to the same green today —
 * mapping both would leave working and available indistinguishable.
 */
import type { EventKind, SessionStatus } from '../../protocol.js'
import { semantic } from '../components/shared/colors.js'

const SESSION_STATUS_COLORS: Record<SessionStatus, string> = {
  working: semantic.status.active,
  available: semantic.status.liveMuted,
  blocked: semantic.status.blocked,
}

export function sessionStatusColor(status: SessionStatus | string | undefined): string {
  if (!status) return semantic.status.pending
  return SESSION_STATUS_COLORS[status as SessionStatus] ?? semantic.status.pending
}

/** Colour for the `dnd` flag, which is orthogonal to session status. */
export function dndColor(): string {
  return semantic.status.dnd
}

/**
 * Queue items are coloured by what they ask of the human, not by their kind's
 * position in some lifecycle. `approval_request` is the loud one on purpose: it
 * is the only kind the UI can never resolve (docs §5), so it should not look
 * like the ones it can — hence `status-error-vivid` rather than `status-error`.
 */
const EVENT_KIND_COLORS: Partial<Record<EventKind, string>> = {
  question: semantic.status.warning,
  approval_request: semantic.priority.critical,
  message: semantic.status.info,
  broadcast: semantic.status.info,
  notice: semantic.text.tertiary,
  answer: semantic.status.success,
  resolution: semantic.status.success,
  route_failed: semantic.status.error,
  agent_spawn_refused: semantic.status.error,
  registered: semantic.status.success,
  deregistered: semantic.text.tertiary,
}

export function eventKindColor(kind: EventKind | string): string {
  return EVENT_KIND_COLORS[kind as EventKind] ?? semantic.text.tertiary
}
