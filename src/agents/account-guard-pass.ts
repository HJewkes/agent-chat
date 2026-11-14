import { frontmatterField } from './active-work.js'
import type { AccountUsage } from './account-budget.js'
import {
  guardDecision,
  nextGuardState,
  type GuardDecision,
  type GuardSeat,
  type GuardState,
} from './account-guard.js'
import { LEAST_USED, moveNameOf } from './account-request.js'
import type { RotationConfig } from './account-rotation.js'
import { accountName, defaultConfigDir } from './config-dir.js'
import type { SessionInfo } from '../protocol.js'

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
  now(): number
}

export const declaresLeastUsed = (seatFile: string): boolean =>
  frontmatterField(seatFile, 'account') === LEAST_USED

function guardSeats(deps: GuardDeps, roster: SessionInfo[]): GuardSeat[] {
  return deps.seats().map(({ name, seatFile }) => {
    const row = roster.find(session => session.name === name)
    return {
      name,
      configDir: row?.observed?.configDir ?? defaultConfigDir(),
      declares: declaresLeastUsed(seatFile),
      live: row !== undefined,
      idleMs: row?.idleMs ?? 0,
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
    if (outcome.ok) state = nextGuardState(state, decision, now)
  }
  if (!options.dryRun) deps.saveState(state)
  return lines
}
