import type { BudgetRead } from '../budget.js'
import { dayStart, runStartAt, type AccountReading } from '../burndown/budget-gate.js'
import {
  charterOwnerSeat,
  charterSeats,
  isSeatName,
  parsePools,
  parseSeat,
  type Pool,
  type Seat,
} from './charter.js'
import type { SeatRecord, WatchdogDoc } from './io.js'
import {
  RESTART_WINDOW_MAX_MS,
  advanceMeter,
  meterHistory,
  readSeatLog,
  restartWindow,
  sameSpendDay,
  withinRun,
  type LogVerdict,
  type OwnerMessage,
  type SpendMeter,
} from './stops.js'
import {
  WAKE_MESSAGE,
  accountReading,
  decide,
  poolBudget,
  runningImplementers,
  type BudgetVerdict,
  type Decision,
  type SeatAgent,
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
  /** The seat's log for the local day of `at`. */
  readSeatLog: (seat: string, at: Date) => string | undefined
  readBudget: (configDir: string, nowMs: number) => BudgetRead
  /** The owner seat's restart messages since `sinceMs`; undefined when events.db cannot be read, which holds every seat. */
  ownerMessages: (owner: string, sinceMs: number) => OwnerMessage[] | undefined
  roster: () => Promise<Roster>
  eligible: (seat: string) => number | undefined
  loadDoc: () => WatchdogDoc
  saveDoc: (doc: Omit<WatchdogDoc, 'stopped'>) => void
  /** A connected seat gets a message; a stopped one is resumed on it. */
  wake: (seat: string, message: string, connected: boolean) => Promise<WakeResult>
  appendLog: (seat: string, at: Date, text: string) => void
}

export interface WatchdogOptions {
  seats?: string[]
  dryRun: boolean
  fireCap?: number
}

/** What one pass reads once and shares across seats. */
interface Pass {
  deps: WatchdogDeps
  now: Date
  pools: Map<string, Pool>
  roster: Roster
  doc: WatchdogDoc
  restart: string | undefined
  readings: Map<string, AccountReading | undefined>
  fireCap: number | undefined
}

function poolReading(pass: Pass, pool: Pool): AccountReading | undefined {
  if (!pass.readings.has(pool.name)) {
    const nowMs = pass.now.getTime()
    const reading = accountReading(pass.deps.readBudget(pool.configDir, nowMs), nowMs)
    pass.readings.set(pool.name, reading)
    const meter = advanceMeter(pass.doc.pools[pool.name], reading?.sevenDay, nowMs, sameSpendDay)
    if (meter !== undefined) pass.doc.pools[pool.name] = meter
  }
  return pass.readings.get(pool.name)
}

function openRestartWindow(deps: WatchdogDeps, charter: string, now: Date): string | undefined {
  const owner = charterOwnerSeat(charter)
  if (owner === undefined) return undefined
  const messages = deps.ownerMessages(owner, now.getTime() - RESTART_WINDOW_MAX_MS)
  if (messages === undefined) return 'events.db unreadable, so a restart window cannot be ruled out'
  return restartWindow(messages, now.getTime())
}

/** Logs are per local day, so just after midnight the seat's newest line is in yesterday's file. */
function seatLogVerdict(deps: WatchdogDeps, seat: string, now: Date): LogVerdict {
  const today = readSeatLog(deps.readSeatLog(seat, now) ?? '', now)
  if (today.activityAt !== undefined) return today
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12)
  return readSeatLog(deps.readSeatLog(seat, yesterday) ?? '', yesterday)
}

/** Owner stop first, then the restart window, then the seat's own pause line. */
function holdFor(pass: Pass, seat: Seat, logStop: string | undefined): string | undefined {
  const ownerStop = pass.doc.stopped[seat.name]
  return (
    (ownerStop === undefined ? undefined : `stopped by the owner: ${ownerStop}`) ?? pass.restart ?? logStop
  )
}

/** gatePool on the seat's pool, reading the run and day meters as the spend at each window's start. */
function seatBudget(
  pass: Pass,
  seat: Seat,
  reading: AccountReading | undefined,
  run: SpendMeter | undefined,
): BudgetVerdict {
  const pool = pass.pools.get(seat.pool)
  const day = pool === undefined ? undefined : pass.doc.pools[pool.name]
  const runStart = runStartAt(pass.now, run === undefined ? {} : { recordedAt: run.since })
  const starts = [
    { at: runStart, meter: run },
    { at: dayStart(pass.now), meter: day },
  ]
  const history = meterHistory(starts, pass.now.getTime())
  return poolBudget({ pool, spend: seat.spend, reading, history, runStartAt: runStart, now: pass.now })
}

interface Judgement {
  decision: Decision
  budget: BudgetVerdict
  record: SeatRecord
}

/** A seat's decision plus the record to save for it. */
function judgeSeat(pass: Pass, seat: Seat): Judgement {
  const { deps, now } = pass
  const nowMs = now.getTime()
  const pool = pass.pools.get(seat.pool)
  const reading = pool === undefined ? undefined : poolReading(pass, pool)
  const previous = pass.doc.seats[seat.name]
  const run = advanceMeter(previous?.run, reading?.sevenDay, nowMs, withinRun)
  const log = seatLogVerdict(deps, seat.name, now)
  const hold = holdFor(pass, seat, log.stop)
  const implementers = runningImplementers(pass.roster.agents, seat).length
  const budget = seatBudget(pass, seat, reading, run)
  const eligible =
    implementers === 0 && hold === undefined && budget.open ? deps.eligible(seat.name) : undefined
  const obs = {
    budget,
    implementers,
    eligible,
    ...(hold === undefined ? {} : { hold }),
    ...(log.activityAt === undefined ? {} : { activityAt: log.activityAt }),
  }
  const decision = decide(obs, previous, nowMs, pass.fireCap)
  const record = { ...decision.next, ...(run === undefined ? {} : { run }), budgetPaused: !budget.open }
  return { decision, budget, record }
}

/** A BUDGET-PAUSE and its lifting are each logged once, on the run that sees the gate change. */
function budgetChange(pass: Pass, seat: string, budget: BudgetVerdict): string | undefined {
  const wasPaused = pass.doc.seats[seat]?.budgetPaused ?? false
  if (wasPaused === !budget.open) return undefined
  const line = budget.open ? `Watchdog: budget open again: ${budget.reason}` : `Watchdog: ${budget.reason}`
  pass.deps.appendLog(seat, pass.now, line)
  return `${seat}: ${line}`
}

async function act(pass: Pass, seat: string, decision: Decision): Promise<string> {
  const connected = pass.roster.connected.includes(seat)
  const woke = await pass.deps.wake(seat, WAKE_MESSAGE, connected)
  const line = `Watchdog: ${decision.reason}; ${woke.ok ? 'woke' : 'wake FAILED'} ${seat} (${woke.detail})`
  pass.deps.appendLog(seat, pass.deps.now(), line)
  return `${seat}: ${line}`
}

function seatOrSkip(deps: WatchdogDeps, name: string): Seat | string {
  if (!isSeatName(name)) return `${name}: skipped, not a seat name`
  const seat = parseSeat(name, deps.readSeatFile(name) ?? '')
  return seat ?? `${name}: skipped, seats/${name}.md has no prefix or pool`
}

async function startPass(deps: WatchdogDeps, options: WatchdogOptions): Promise<[Pass, string]> {
  const charter = deps.readCharter()
  if (charter === undefined) throw new Error('no autonomy charter.md under the root')
  const now = deps.now()
  const pass: Pass = {
    deps,
    now,
    pools: parsePools(charter),
    roster: await deps.roster(),
    doc: deps.loadDoc(),
    restart: openRestartWindow(deps, charter, now),
    readings: new Map(),
    fireCap: options.fireCap,
  }
  return [pass, charter]
}

/** Output lines: one per seat under --dry-run, else only wakes and misconfigured seats. */
export async function runWatchdog(deps: WatchdogDeps, options: WatchdogOptions): Promise<string[]> {
  const [pass, charter] = await startPass(deps, options)
  const lines: string[] = []
  for (const name of options.seats ?? charterSeats(charter)) {
    const seat = seatOrSkip(deps, name)
    if (typeof seat === 'string') {
      lines.push(seat)
      continue
    }
    const { decision, budget, record } = judgeSeat(pass, seat)
    const change = options.dryRun ? undefined : budgetChange(pass, name, budget)
    if (change !== undefined) lines.push(change)
    pass.doc.seats[name] = record
    if (options.dryRun) lines.push(`${name}: ${decision.fire ? 'WOULD FIRE' : 'skip'}: ${decision.reason}`)
    else if (decision.fire) lines.push(await act(pass, name, decision))
  }
  if (!options.dryRun) deps.saveDoc({ seats: pass.doc.seats, pools: pass.doc.pools })
  return lines
}
