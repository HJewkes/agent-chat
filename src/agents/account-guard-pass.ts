import type { AccountUsage } from './account-budget.js'
import {
  guardDecision,
  nextGuardState,
  type GuardDecision,
  type GuardSeat,
  type GuardState,
} from './account-guard.js'
import { moveNameOf } from './account-request.js'
import type { RotationConfig } from './account-rotation.js'
import { accountName } from './config-dir.js'
import { declaresLeastUsed } from './least-used-seat.js'
import { ACCOUNT_GUARD, type SessionInfo } from '../protocol.js'

/** CC-894: one guard tick over every charter seat: read, decide, then move or notify unless dry. */

export interface GuardOutcome {
  ok: boolean
  detail: string
}

export interface GuardDeps {
  /** Each charter seat with its seat file text. */
  seats(): { name: string; seatFile: string }[]
  roster(): Promise<SessionInfo[]>
  readings(): AccountUsage[]
  config(): RotationConfig
  identify?: (configDir: string) => string | undefined
  readState(): GuardState
  saveState(state: GuardState): void
  /** Sends `account_move` for the session to the named account. */
  move(name: string, to: string): Promise<GuardOutcome>
  notify(text: string): Promise<GuardOutcome>
  /** Whether the session's transcript ends on an ended turn; a missing or unreadable one reads false. */
  turnEnded(session: SessionInfo): boolean
  /** Appends a line to the seat's own log, so its journal shows who moved it. */
  seatLog(seat: string, text: string): void
  now(): number
}

function guardSeats(deps: GuardDeps, roster: SessionInfo[]): GuardSeat[] {
  return deps.seats().map(({ name, seatFile }) => {
    const row = roster.find(session => session.name === name)
    return {
      name,
      configDir: row?.observed?.configDir,
      declares: declaresLeastUsed(seatFile),
      live: row !== undefined,
      idleMs: row?.idleMs ?? 0,
      turnEnded: row !== undefined && deps.turnEnded(row),
    }
  })
}

function describe(decision: GuardDecision, dryRun: boolean): string {
  const name = decision.name
  if (decision.kind === 'move') {
    const verb = dryRun ? 'WOULD MOVE' : 'move'
    return `guard ${name}: ${verb} ${accountName(decision.from)} -> ${accountName(decision.to)} (${decision.reason})`
  }
  if (decision.kind === 'notice')
    return `guard ${name}: ${dryRun ? 'WOULD NOTIFY' : 'notify'}: ${decision.text}`
  return `guard ${name}: ${decision.kind} (${decision.reason})`
}

async function carryOut(deps: GuardDeps, decision: GuardDecision): Promise<GuardOutcome | undefined> {
  if (decision.kind === 'move') return deps.move(decision.name, moveNameOf(decision.to))
  if (decision.kind === 'notice') return deps.notify(decision.text)
  return undefined
}

/** Names the guard as the mover, never the human, whatever the broker records. */
const guardLogLine = (decision: Extract<GuardDecision, { kind: 'move' }>, outcome: GuardOutcome): string =>
  `${ACCOUNT_GUARD} ${outcome.ok ? 'moved' : 'failed to move'} this seat ` +
  `${accountName(decision.from)} -> ${accountName(decision.to)}: ${decision.reason}` +
  (outcome.ok ? '' : ` (${outcome.detail})`)

export async function runGuard(deps: GuardDeps, options: { dryRun: boolean }): Promise<string[]> {
  const seats = guardSeats(deps, await deps.roster())
  const [usages, config, now] = [deps.readings(), deps.config(), deps.now()]
  const identify = deps.identify === undefined ? {} : { identify: deps.identify }
  let state = deps.readState()
  const lines: string[] = []
  for (const seat of seats.filter(s => s.declares)) {
    const decision = guardDecision({ seat, usages, config, state, now, ...identify })
    lines.push(describe(decision, options.dryRun))
    if (options.dryRun) continue
    const outcome = await carryOut(deps, decision)
    if (outcome === undefined) continue
    lines.push(`  ${outcome.ok ? 'done' : 'failed'}: ${outcome.detail}`)
    if (decision.kind === 'move') deps.seatLog(seat.name, guardLogLine(decision, outcome))
    if (outcome.ok) state = nextGuardState(state, decision, now)
  }
  if (!options.dryRun) deps.saveState(state)
  return lines
}
