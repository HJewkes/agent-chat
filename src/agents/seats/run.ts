import type { BudgetRead } from '../budget.js'
import { charterSeats, parsePools, parseSeat, type Pool, type Seat } from './charter.js'
import {
  WAKE_MESSAGE,
  accountReading,
  decide,
  poolBudget,
  runningImplementers,
  type Decision,
  type SeatAgent,
  type SeatState,
} from './watchdog.js'

/** One live watchdog pass over every seat. Every side effect is a dependency, so a test drives it whole. */

export interface Roster {
  agents: SeatAgent[]
  /** Names with a connected session right now. */
  connected: string[]
}

export interface WakeResult {
  ok: boolean
  detail: string
}

export interface WatchdogDeps {
  now: () => Date
  readCharter: () => string | undefined
  readSeatFile: (seat: string) => string | undefined
  readBudget: (configDir: string, nowMs: number) => BudgetRead
  roster: () => Promise<Roster>
  eligible: (seat: string) => number | undefined
  loadStates: () => Record<string, SeatState>
  saveStates: (states: Record<string, SeatState>) => void
  /** A connected seat gets a message; a stopped one is resumed on it. */
  wake: (seat: string, message: string, connected: boolean) => Promise<WakeResult>
  appendLog: (seat: string, at: Date, text: string) => void
}

export interface WatchdogOptions {
  seats?: string[]
  dryRun: boolean
}

interface SeatVerdict {
  seat: string
  decision: Decision
}

function judgeSeat(
  deps: WatchdogDeps,
  seat: Seat,
  pool: Pool | undefined,
  roster: Roster,
  previous?: SeatState,
): Decision {
  const now = deps.now()
  const reading =
    pool === undefined
      ? undefined
      : accountReading(deps.readBudget(pool.configDir, now.getTime()), now.getTime())
  const implementers = runningImplementers(roster.agents, seat).length
  const budget = poolBudget(pool, reading, now)
  const eligible = implementers === 0 && budget.open ? deps.eligible(seat.name) : undefined
  return decide({ budget, implementers, eligible }, previous, now.getTime())
}

async function act(deps: WatchdogDeps, verdict: SeatVerdict, roster: Roster): Promise<string> {
  const connected = roster.connected.includes(verdict.seat)
  const woke = await deps.wake(verdict.seat, WAKE_MESSAGE, connected)
  const line = `Watchdog: ${verdict.decision.reason}; ${woke.ok ? 'woke' : 'wake FAILED'} ${verdict.seat} (${woke.detail})`
  deps.appendLog(verdict.seat, deps.now(), line)
  return `${verdict.seat}: ${line}`
}

/** Output lines: one per seat under --dry-run, else only wakes and misconfigured seats. */
export async function runWatchdog(deps: WatchdogDeps, options: WatchdogOptions): Promise<string[]> {
  const charter = deps.readCharter()
  if (charter === undefined) throw new Error('no autonomy charter.md under the root')
  const pools = parsePools(charter)
  const roster = await deps.roster()
  const states = deps.loadStates()
  const lines: string[] = []
  for (const name of options.seats ?? charterSeats(charter)) {
    const seat = parseSeat(name, deps.readSeatFile(name) ?? '')
    if (seat === undefined) {
      lines.push(`${name}: skipped, seats/${name}.md has no prefix or pool`)
      continue
    }
    const decision = judgeSeat(deps, seat, pools.get(seat.pool), roster, states[name])
    states[name] = decision.next
    if (options.dryRun) lines.push(`${name}: ${decision.fire ? 'WOULD FIRE' : 'skip'}: ${decision.reason}`)
    else if (decision.fire) lines.push(await act(deps, { seat: name, decision }, roster))
  }
  if (!options.dryRun) deps.saveStates(states)
  return lines
}
