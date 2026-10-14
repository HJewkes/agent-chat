import type { SeatState } from '@titan-design/coordinator'
import { BOOT_CAP } from './boot.js'
import { capText } from './boot-read.js'
import { renderRecord } from './dispatch-read.js'
import type { DispatchRecord } from './dispatch-record.js'
import { inFlightLines, type InFlight } from './in-flight-read.js'
import type { PaceRead } from './pace-file.js'

/**
 * TP-1600 d: the state section of a seat successor's first prompt, rendered from the SeatState the
 * coordinator fold produces plus the live state the broker reads at teleport. Pure: every input is
 * passed in, so a source the caller could not read arrives as an `unavailable` value, never a throw.
 */

export type WorktreeClaim = SeatState['claims'][number]

/** A source the caller read, or the reason it could not. */
export type Readable<T> = T | { unavailable: string }

export interface SeatStateRenderInput {
  state: SeatState
  /**
   * The authored block as the seat's renderer prints it (continuations, unexpired standing rules,
   * open questions, next/why). Defaults to `state.authored` as stored. Never cut.
   */
  authored?: string
  inFlight: InFlight
  worktreeClaims: WorktreeClaim[]
  pace: PaceRead
  /** Dispatch outcomes since the last generation's teleport. */
  recent: Readable<DispatchRecord[]>
  now: number
  homeDir?: string
}

const isUnavailable = <T>(v: Readable<T>): v is { unavailable: string } =>
  typeof v === 'object' && v !== null && 'unavailable' in v

function authoredLines(text: string): string[] {
  const body = text.trim()
  return [
    '== authored (continuations, standing rules, open questions, next/why)',
    body === '' ? 'authored: none' : body,
  ]
}

function claimLines(claims: WorktreeClaim[]): string[] {
  const line = (c: WorktreeClaim): string =>
    [
      `claim ${c.worktree}`,
      `owner ${c.owner}`,
      ...(c.patterns.length === 0 ? [] : [c.patterns.join(' ')]),
    ].join(' | ')
  return [
    '== worktree claims (restored by the broker; do not re-claim)',
    ...(claims.length === 0 ? ['worktree claims: none'] : claims.map(line)),
  ]
}

function holdLines({ holds }: SeatState): string[] {
  return [
    '== holds',
    ...(holds.length === 0 ? ['holds: none'] : holds.map(h => `hold ${h.target}: ${h.reason}`)),
  ]
}

const SHELL_SAFE = /^[\w@%+=:,./~-]+$/
const shellWord = (text: string): string =>
  SHELL_SAFE.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`

function backgroundLines({ background }: SeatState): string[] {
  const line = (b: SeatState['background'][number]): string =>
    `background ${b.id} | cd ${shellWord(b.cwd)} && ${b.command}`
  return [
    "== background (relaunch each; the predecessor's watches ended with it)",
    ...(background.length === 0 ? ['background: none'] : background.map(line)),
  ]
}

const MINUTE_MS = 60_000

function poolLine(
  name: string,
  pool: { behind: number; readingAt: number; fiveHour?: number },
  now: number,
): string {
  const age = Math.max(0, Math.round((now - pool.readingAt) / MINUTE_MS))
  const behind = pool.behind >= 0 ? `${pool.behind} pts behind pace` : `${-pool.behind} pts ahead of pace`
  const fiveHour = pool.fiveHour === undefined ? [] : [`5h ${pool.fiveHour}%`]
  return [`pool ${name}`, behind, ...fiveHour, `reading ${age} min old`].join(' | ')
}

function budgetLines(pace: PaceRead, now: number): string[] {
  if (!pace.found) return ['== budget', `unavailable: budget (${pace.reason})`]
  const rows = [...pace.pools].map(([name, pool]) => poolLine(name, pool, now))
  return ['== budget', ...(rows.length === 0 ? ['budget: no fresh pool reading'] : rows)]
}

function recentLines(recent: Readable<DispatchRecord[]>): string[] {
  const head = '== recent (dispatch outcomes since the last generation, newest first)'
  if (isUnavailable(recent)) return [head, `unavailable: recent (${recent.unavailable})`]
  if (recent.length === 0) return [head, 'recent: none']
  return [head, ...[...recent].reverse().map(renderRecord)]
}

function foldErrorLines({ errors, unknownEvents }: SeatState): string[] {
  if (errors.length === 0 && unknownEvents === 0) return []
  return [
    '== seat event log problems',
    ...errors.map(e => `event ${e.index} (${e.kind}): ${e.message}`),
    ...(unknownEvents === 0 ? [] : [`${unknownEvents} events of an unknown kind skipped`]),
  ]
}

type Cuttable = 'recent' | 'budget' | 'inFlight'

/** The order the cap cuts sections in; the authored block, claims, holds and background are never cut. */
export const CUT_ORDER: readonly Cuttable[] = ['recent', 'budget', 'inFlight']

const size = (lines: string[]): number => lines.join('\n').length

/**
 * Sections in prompt order. Over `cap`, Recent is cut from its oldest end first, then Budget, then the
 * tail of In flight; when only uncuttable sections remain the result may still exceed `cap`.
 */
export function renderSeatState(input: SeatStateRenderInput, cap = BOOT_CAP): string[] {
  const { state, now } = input
  const parts: Record<Cuttable, string[]> = {
    inFlight: inFlightLines(input.inFlight, input.homeDir ?? ''),
    budget: budgetLines(input.pace, now),
    recent: recentLines(input.recent),
  }
  const render = (): string[] => [
    ...authoredLines(input.authored ?? state.authored),
    ...parts.inFlight,
    ...claimLines(input.worktreeClaims),
    ...holdLines(state),
    ...backgroundLines(state),
    ...parts.budget,
    ...parts.recent,
    ...foldErrorLines(state),
  ]
  let lines = render()
  for (const part of CUT_ORDER) {
    const over = size(lines) - cap
    if (over <= 0) break
    const text = parts[part].join('\n')
    parts[part] = capText(text, Math.max(0, text.length - over)).split('\n')
    lines = render()
  }
  return lines
}
