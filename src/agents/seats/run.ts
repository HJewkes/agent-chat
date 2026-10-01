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
import type { Eligibility, SeatRecord, WatchdogDoc } from './io.js'
import {
  RESUME_MESSAGE,
  RESUME_TRY_CAP,
  judgeLiveness,
  type LivenessVerdict,
  type Presence,
} from './liveness.js'
import type { RunLock } from './lock.js'
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
  FIRE_CAP,
  WAKE_MESSAGE,
  accountReading,
  decide,
  keepReading,
  lastGoodReading,
  poolBudget,
  runningImplementers,
  type BudgetVerdict,
  type Decision,
  type Observation,
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
  /** CC-326: the local days the seat has a log for, newest first; throws when they cannot be listed. */
  seatLogDays: (seat: string) => Date[]
  /** The seat's log for the local day of `at`; undefined when there is none, and throws when it cannot be read. */
  readSeatLog: (seat: string, at: Date) => string | undefined
  readBudget: (configDir: string, nowMs: number) => BudgetRead
  /** The owner seat's restart messages since `sinceMs`; undefined when events.db cannot be read, which holds every seat. */
  ownerMessages: (owner: string, sinceMs: number) => OwnerMessage[] | undefined
  roster: () => Promise<Roster>
  /** CC-320: the seat's latest presence rows; undefined when events.db cannot be read, which never resumes. */
  presence: (seat: string) => Presence | undefined
  eligible: (seat: string) => Eligibility | undefined
  /** Throws when seat-watchdog.json is there and unusable, which ends the run with that error. */
  loadDoc: () => WatchdogDoc
  saveDoc: (doc: Omit<WatchdogDoc, 'stopped'>) => void
  /** A connected seat gets a message; a stopped one is resumed on it. */
  wake: (seat: string, message: string, connected: boolean) => Promise<WakeResult>
  appendLog: (seat: string, at: Date, text: string) => void
  /** CC-326: taken by every run that may wake or resume, so two runs never act on the same seat. */
  lock: () => RunLock
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
  /** Pools whose day meter started with no reading at or before 07:00, reported once when it starts. */
  gaps: string[]
}

function poolReading(pass: Pass, pool: Pool): AccountReading | undefined {
  if (!pass.readings.has(pool.name)) {
    const nowMs = pass.now.getTime()
    const reading = accountReading(pass.deps.readBudget(pool.configDir, nowMs), nowMs)
    pass.readings.set(pool.name, reading)
    const kept = keepReading(pass.doc.lastReadings?.[pool.name], reading, nowMs)
    if (kept !== undefined) pass.doc.lastReadings = { ...pass.doc.lastReadings, [pool.name]: kept }
    const meter = advanceMeter(pass.doc.pools[pool.name], reading?.sevenDay, nowMs, sameSpendDay)
    if (meter !== undefined) {
      const started = pass.doc.pools[pool.name] !== meter && meter.since === nowMs
      if (started && meter.before === undefined) pass.gaps.push(pool.name)
      pass.doc.pools[pool.name] = meter
    }
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

interface SeatJournal extends LogVerdict {
  /** CC-326: why the journal could not be read, which holds the seat and is said on every run. */
  unreadable?: string
}

/** Logs are per local day, and a seat that stopped long ago has its newest line in an old file, so every file counts. */
function seatJournal(deps: WatchdogDeps, seat: string): SeatJournal {
  try {
    for (const day of deps.seatLogDays(seat)) {
      const verdict = readSeatLog(deps.readSeatLog(seat, day) ?? '', day)
      if (verdict.activityAt !== undefined) return verdict
    }
    return {}
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    const unreadable = `seat journal unreadable, so a stop in it cannot be ruled out (${why})`
    return { stop: unreadable, unreadable }
  }
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
  const kept = pool === undefined ? undefined : pass.doc.lastReadings?.[pool.name]
  const lastGood = lastGoodReading(kept, pass.now.getTime())
  return poolBudget({
    pool,
    spend: seat.spend,
    reading,
    lastGood,
    history,
    runStartAt: runStart,
    now: pass.now,
  })
}

type ResumeMark = Pick<SeatRecord, 'resumedDark' | 'resumeRetry' | 'absent'>

interface SeatLiveness {
  verdict: LivenessVerdict
  /** The resume mark and the absence clock to save with the seat's record. */
  mark: ResumeMark
}

type Absence = NonNullable<SeatRecord['absent']>

/** CC-326: a seat absent though its last row is `registered` is dark from the run that first saw it so. */
function absence(
  previous: Absence | undefined,
  presence: Presence | undefined,
  nowMs: number,
): Absence | undefined {
  if (presence === undefined) return previous
  const register = presence.openRegister
  if (register === undefined) return undefined
  return previous?.register === register ? previous : { register, since: nowMs }
}

function resumeMark(attempted: number | undefined, retry: number | undefined, absent?: Absence): ResumeMark {
  return {
    ...(attempted === undefined ? {} : { resumedDark: attempted }),
    ...(retry === undefined ? {} : { resumeRetry: retry }),
    ...(absent === undefined ? {} : { absent }),
  }
}

function seatLiveness(pass: Pass, seat: string, hold: string | undefined): SeatLiveness {
  const connected = pass.roster.connected.includes(seat)
  const presence = connected ? undefined : pass.deps.presence(seat)
  const previous = pass.doc.seats[seat]
  const nowMs = pass.now.getTime()
  const absent = connected ? undefined : absence(previous?.absent, presence, nowMs)
  const attempted = previous?.resumedDark
  const unconfirmed = previous?.resumeRetry
  const input = { connected, presence, hold, absentSince: absent?.since, attempted, unconfirmed, nowMs }
  const verdict = judgeLiveness(input)
  const mark = verdict.resume
    ? resumeMark(verdict.episode, verdict.tries, absent)
    : resumeMark(attempted, unconfirmed, absent)
  return { verdict, mark }
}

interface Judgement {
  decision: Decision
  budget: BudgetVerdict
  record: SeatRecord
  liveness: LivenessVerdict
  /** CC-326: set when the seat's journal could not be read. */
  journalFault?: string
}

/** What the idle wake is decided on; the scorer is asked only for a seat nothing else holds. */
function observe(
  pass: Pass,
  seat: Seat,
  budget: BudgetVerdict,
  hold: string | undefined,
  activityAt: number | undefined,
): Observation {
  const implementers = runningImplementers(pass.roster.agents, seat).length
  const scored =
    implementers === 0 && hold === undefined && budget.open ? pass.deps.eligible(seat.name) : undefined
  return {
    budget,
    implementers,
    eligible: scored?.count,
    ...(scored === undefined ? {} : { skipped: scored.skipped }),
    ...(hold === undefined ? {} : { hold }),
    ...(activityAt === undefined ? {} : { activityAt }),
  }
}

/** A seat's decision plus the record to save for it. */
function judgeSeat(pass: Pass, seat: Seat): Judgement {
  const nowMs = pass.now.getTime()
  const pool = pass.pools.get(seat.pool)
  const reading = pool === undefined ? undefined : poolReading(pass, pool)
  const previous = pass.doc.seats[seat.name]
  const run = advanceMeter(previous?.run, reading?.sevenDay, nowMs, withinRun)
  const log = seatJournal(pass.deps, seat.name)
  const ownHold = holdFor(pass, seat, log.stop)
  const budget = seatBudget(pass, seat, reading, run)
  // CC-326: a closed pool or a seat at its spend stop holds the resume as it holds the wake.
  const resumeHold = ownHold ?? (budget.open ? undefined : `budget closed: ${budget.reason}`)
  const liveness = seatLiveness(pass, seat.name, resumeHold)
  const hold = ownHold ?? liveness.verdict.idleHold
  const obs = observe(pass, seat, budget, hold, log.activityAt)
  const decision = decide(obs, previous, nowMs, pass.fireCap)
  const capped = (decision.next.fires ?? 0) >= (pass.fireCap ?? FIRE_CAP)
  const record = {
    ...decision.next,
    ...(run === undefined ? {} : { run }),
    budgetPaused: !budget.open,
    capped,
    ...liveness.mark,
  }
  const journalFault = log.unreadable === undefined ? {} : { journalFault: log.unreadable }
  return { decision, budget, record, liveness: liveness.verdict, ...journalFault }
}

/** A BUDGET-PAUSE and its lifting are each logged once, on the run that sees the gate change. */
function budgetChange(pass: Pass, seat: string, budget: BudgetVerdict): string | undefined {
  const wasPaused = pass.doc.seats[seat]?.budgetPaused ?? false
  if (wasPaused === !budget.open) return undefined
  const line = budget.open ? `Watchdog: budget open again: ${budget.reason}` : `Watchdog: ${budget.reason}`
  pass.deps.appendLog(seat, pass.now, line)
  return `${seat}: ${line}`
}

/** A fire cap engaging and lifting are each logged once, on the run that sees the change. */
function capChange(pass: Pass, seat: string, record: SeatRecord): string | undefined {
  const wasCapped = pass.doc.seats[seat]?.capped ?? false
  const capped = record.capped ?? false
  if (wasCapped === capped) return undefined
  const line = capped
    ? `Watchdog: fire cap engaged: ${record.fires} wake(s) with no implementer; waiting for a dispatch`
    : 'Watchdog: fire cap lifted: an implementer ran'
  pass.deps.appendLog(seat, pass.now, line)
  return `${seat}: ${line}`
}

/** A hold on every seat starting or ending is logged once, in the run output. */
function holdChange(pass: Pass): string | undefined {
  const wasHeld = pass.doc.held ?? false
  const held = pass.restart !== undefined
  pass.doc.held = held
  if (wasHeld === held) return undefined
  return held ? `Watchdog: hold on every seat: ${pass.restart}` : 'Watchdog: hold on every seat lifted'
}

async function act(pass: Pass, seat: string, decision: Decision): Promise<string> {
  const connected = pass.roster.connected.includes(seat)
  const woke = await pass.deps.wake(seat, WAKE_MESSAGE, connected)
  const line = `Watchdog: ${decision.reason}; ${woke.ok ? 'woke' : 'wake FAILED'} ${seat} (${woke.detail})`
  pass.deps.appendLog(seat, pass.deps.now(), line)
  return `${seat}: ${line}`
}

function save(pass: Pass): void {
  pass.deps.saveDoc({
    seats: pass.doc.seats,
    pools: pass.doc.pools,
    ...(pass.doc.lastReadings === undefined ? {} : { lastReadings: pass.doc.lastReadings }),
    ...(pass.doc.held === undefined ? {} : { held: pass.doc.held }),
  })
}

/**
 * CC-320, CC-326. The mark is saved before the resume and stays unconfirmed until the broker
 * accepts it, so a refusal or a run that dies mid-call is retried and an accepted resume never is.
 */
async function resumeDark(pass: Pass, seat: string, liveness: LivenessVerdict): Promise<string> {
  save(pass)
  const woke = await pass.deps
    .wake(seat, RESUME_MESSAGE, false)
    .catch((err: unknown) => ({ ok: false, detail: err instanceof Error ? err.message : String(err) }))
  if (woke.ok) delete pass.doc.seats[seat]?.resumeRetry
  const next = (liveness.tries ?? 1) < RESUME_TRY_CAP ? 'will retry next run' : 'giving up on this episode'
  const outcome = woke.ok
    ? `resumed ${seat} (${woke.detail})`
    : `resume FAILED ${seat} (${woke.detail}); ${next}`
  const line = `Watchdog: ${liveness.reason}; ${outcome}`
  pass.deps.appendLog(seat, pass.deps.now(), line)
  return `${seat}: ${line}`
}

function dryRunLine(decision: Decision, liveness: LivenessVerdict): string {
  if (liveness.resume) return `WOULD RESUME: ${liveness.reason}`
  if (liveness.refused) return `skip: ${liveness.reason}`
  return `${decision.fire ? 'WOULD FIRE' : 'skip'}: ${decision.reason}`
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
    gaps: [],
  }
  return [pass, charter]
}

async function runPass(deps: WatchdogDeps, options: WatchdogOptions, lines: string[]): Promise<string[]> {
  const [pass, charter] = await startPass(deps, options)
  const hold = options.dryRun ? undefined : holdChange(pass)
  if (hold !== undefined) lines.push(hold)
  for (const name of options.seats ?? charterSeats(charter)) {
    const seat = seatOrSkip(deps, name)
    if (typeof seat === 'string') {
      lines.push(seat)
      continue
    }
    const { decision, budget, record, liveness, journalFault } = judgeSeat(pass, seat)
    const change = options.dryRun ? undefined : budgetChange(pass, name, budget)
    if (change !== undefined) lines.push(change)
    const capLine = options.dryRun ? undefined : capChange(pass, name, record)
    if (capLine !== undefined) lines.push(capLine)
    pass.doc.seats[name] = record
    if (options.dryRun) lines.push(`${name}: ${dryRunLine(decision, liveness)}`)
    else if (liveness.resume) lines.push(await resumeDark(pass, name, liveness))
    else if (liveness.refused) lines.push(`${name}: Watchdog: ${liveness.reason}`)
    else if (decision.fire) lines.push(await act(pass, name, decision))
    else if (journalFault !== undefined) lines.push(`${name}: Watchdog: held: ${journalFault}`)
  }
  for (const pool of pass.gaps)
    lines.push(
      `pool ${pool}: no seven_day reading at or before 07:00, so the day's spend counts from the first sample`,
    )
  if (!options.dryRun) save(pass)
  return lines
}

/** Output lines: one per seat under --dry-run, else only wakes, refused resumes, unreadable journals and misconfigured seats. */
export async function runWatchdog(deps: WatchdogDeps, options: WatchdogOptions): Promise<string[]> {
  if (options.dryRun) return runPass(deps, options, [])
  const lock = deps.lock()
  if (!lock.held) return [`Watchdog: ${lock.reason}; this run did nothing`]
  try {
    return await runPass(deps, options, lock.note === undefined ? [] : [`Watchdog: ${lock.note}`])
  } finally {
    lock.release()
  }
}
