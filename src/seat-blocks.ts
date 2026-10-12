import type { EventLog } from './broker/event-log.js'
import type { LoggedEventRow } from './broker/event-store.js'

/** CC-1056: the tool that stops a seat until a human answers. */
export const BLOCKING_TOOL = 'AskUserQuestion'

/** CC-1092: why a seat's pane question is denied, naming what to do instead. */
export const PANE_QUESTION_DENIAL = 'use chat_ask with door and default'

/** One activity row per session per this long, so a busy seat does not flood the log. */
export const ACTIVITY_INTERVAL_MS = 60_000

/** `end` is a prompt, stop or session end: the seat is no longer waiting on a question. */
export const HOOK_PHASES = ['pre', 'post', 'end'] as const
export type HookPhase = (typeof HOOK_PHASES)[number]

export const isHookPhase = (value: string): value is HookPhase =>
  (HOOK_PHASES as readonly string[]).includes(value)

/** How far before a window a block may have started and still be counted into it. */
export const LOOKBACK_MS = 7 * 24 * 60 * 60_000

export interface HookInput {
  sessionId: string
  toolName: string
}

/** The fields of a PreToolUse/PostToolUse payload this instrument reads, or undefined for anything else. */
export function parseToolHook(raw: string): HookInput | undefined {
  try {
    const value = JSON.parse(raw) as { session_id?: unknown; tool_name?: unknown }
    if (typeof value.session_id !== 'string') return undefined
    return {
      sessionId: value.session_id,
      toolName: typeof value.tool_name === 'string' ? value.tool_name : '',
    }
  } catch {
    return undefined
  }
}

/** CC-1092: a seat never opens a pane question, attended or not; every other session keeps it. */
export function paneQuestionVerdict(
  name: string,
  toolName: string,
  isSeat: (name: string) => boolean,
): 'deny' | 'allow' {
  return toolName === BLOCKING_TOOL && isSeat(name) ? 'deny' : 'allow'
}

/**
 * Writes the row a tool call earns. `seat` is the registered seat's name; a session with none
 * writes nothing. A blocking tool writes blocked/unblocked; any other call writes at most one
 * activity row per session per minute. A `denied` question never opens, so it writes
 * `seat_ask_denied` and no block.
 */
export function recordToolCall(
  log: Pick<EventLog, 'append' | 'lastAgentEventAt' | 'lastSeatBlockKind'>,
  seat: string | undefined,
  phase: HookPhase,
  input: HookInput,
  denied = false,
): void {
  if (seat === undefined || seat === '') return
  const { sessionId, toolName } = input
  if (phase === 'end') {
    if (log.lastSeatBlockKind(sessionId) === 'seat_blocked')
      log.append({
        kind: 'seat_unblocked',
        actor: seat,
        ref: sessionId,
        meta: { reason: 'session-moved-on' },
      })
    return
  }
  if (toolName === BLOCKING_TOOL) {
    if (denied && phase === 'pre') {
      log.append({ kind: 'seat_ask_denied', actor: seat, ref: sessionId })
      return
    }
    log.append({
      kind: phase === 'pre' ? 'seat_blocked' : 'seat_unblocked',
      actor: seat,
      ref: sessionId,
    })
    return
  }
  if (phase === 'post') return
  const last = log.lastAgentEventAt(sessionId, 'seat_activity')
  if (last !== undefined && Date.now() - last < ACTIVITY_INTERVAL_MS) return
  log.append({ kind: 'seat_activity', actor: seat, ref: sessionId, meta: { tool: toolName } })
}

export interface OpenBlock {
  seat: string
  sessionId: string
  since: number
  minutes: number
}

export interface SeatBlockReport {
  /** Blocked minutes inside the window, per seat; a seat that never blocked is absent. */
  minutesBySeat: Record<string, number>
  /** Blocks with no answer yet, whatever the window's start. */
  open: OpenBlock[]
}

const toMinutes = (ms: number): number => Math.round((ms / 60_000) * 10) / 10

interface Span {
  seat: string
  sessionId: string
  from: number
  to: number | undefined
}

/**
 * Pairs each session's rows into spans. A block ends at its unblock, or at the session's next
 * activity row: a session that is running another tool is no longer waiting on the question.
 */
function blockSpans(rows: LoggedEventRow[]): Span[] {
  const spans: Span[] = []
  const open = new Map<string, Span>()
  for (const row of rows) {
    const key = `${row.actor}\0${row.ref ?? ''}`
    const current = open.get(key)
    if (row.kind === 'seat_blocked') {
      if (current !== undefined) continue
      const span = { seat: row.actor, sessionId: row.ref ?? '', from: row.ts, to: undefined }
      open.set(key, span)
      spans.push(span)
    } else if (current !== undefined) {
      current.to = row.ts
      open.delete(key)
    }
  }
  return spans
}

/** Each seat's blocked minutes in `[from, to]`, plus every block still open at `to`. */
export function seatBlockReport(
  log: Pick<EventLog, 'seatBlockRows'>,
  from: number,
  to: number,
): SeatBlockReport {
  const minutesBySeat: Record<string, number> = {}
  const open: OpenBlock[] = []
  for (const span of blockSpans(log.seatBlockRows(from - LOOKBACK_MS, to))) {
    const end = span.to ?? to
    if (span.to === undefined)
      open.push({
        seat: span.seat,
        sessionId: span.sessionId,
        since: span.from,
        minutes: toMinutes(to - span.from),
      })
    const overlap = Math.min(end, to) - Math.max(span.from, from)
    if (overlap > 0) minutesBySeat[span.seat] = toMinutes((minutesBySeat[span.seat] ?? 0) * 60_000 + overlap)
  }
  return { minutesBySeat, open }
}

/** The blocks still open and at least `minMinutes` old: what a pager asks for. */
export function openBlocks(log: Pick<EventLog, 'seatBlockRows'>, now: number, minMinutes = 0): OpenBlock[] {
  return seatBlockReport(log, now, now).open.filter(block => block.minutes >= minMinutes)
}
