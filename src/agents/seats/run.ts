import type { BudgetRead } from '../budget.js'
import {
  MAX_READING_AGE_SECONDS,
  dayStart,
  runStartAt,
  type AccountReading,
} from '../burndown/budget-gate.js'
import {
  charterOwnerSeat,
  charterSeats,
  isSeatName,
  parsePools,
  parseSeat,
  type Pool,
  type Seat,
} from './charter.js'
import { heartbeatStep, PAUSE_WAKE_MESSAGE, type HeartbeatStep } from './heartbeat.js'
import type { Eligibility, SeatRecord, WatchdogDoc } from './io.js'
import {
  RESUME_MESSAGE,
  RESUME_TRY_CAP,
  judgeLiveness,
  type LivenessVerdict,
  type Presence,
} from './liveness.js'
import type { RunLock } from './lock.js'
import { HANDOFF_GRACE_MS, RELAUNCH_QUIET_MS, judgeRelaunch, type RelaunchVerdict } from './relaunch.js'
import { checkAttended } from './attended.js'
import { judgeService, runServiceCheck, type ServiceCheckRunner } from './service-check.js'
import { poolPace } from './pace.js'
import { publishPace, type PaceStore } from './pace-pass.js'
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
  stuckSpawning,
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
  /** Why the roster could not be read; a timeout or error means unknown, never absent. */
  unknown?: string
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
  /** CC-431: why memory or load holds every seat; undefined when neither is past its limit or unread. */
  machineStop?: () => string | undefined
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
  /** CC-605: where the pass publishes every pool's pace and appends the reading history. */
  pace?: PaceStore
  /** CC-529: takes a reading for a pool whose status cache has none under 15 minutes old; false when it took none. */
  probe?: (configDir: string) => boolean
  /** The seat files under the root, charter-listed or not; throws when they cannot be listed. */
  seatNames?: () => string[]
  /** CC-598: runs `titan-factory service check --json`; absent, the pass does not check. */
  serviceCheck?: ServiceCheckRunner
  /** CC-947: re-renders a resumed seat's installed heartbeat units; says what changed, else undefined. */
  refreshHeartbeat?: (seat: string) => string | undefined
  /** CC-465: the boot handoff a relaunched seat starts on; absent, the pass relaunches nothing. */
  relaunchHandoff?: (seat: string, quietMinutes: number, now: Date) => string
  /** CC-465: whether the agent's transcript exists; undefined when that cannot be told. */
  transcriptFound?: (agentId: string) => boolean | undefined
  /** CC-465: raises one item on the human queue. */
  notifyHuman?: (text: string) => Promise<WakeResult>
  /** CC-391: records each delivered heartbeat as a `heartbeat_watchdog` row; absent, nothing is recorded. */
  logEvent?: (event: string, detail: Record<string, unknown>) => void
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
  machine: string | undefined
  readings: Map<string, AccountReading | undefined>
  /** CC-404: epoch ms each pool's seven_day window resets, from the same status file as its reading. */
  resets: Map<string, number | undefined>
  fireCap: number | undefined
  dryRun: boolean
  /** Pools whose day meter started with no reading at or before 07:00, reported once when it starts. */
  gaps: string[]
  /** Probes that failed in this pass, one line each. */
  probeFaults: string[]
}

const PROBE_BACKOFF_MS = 3_600_000

/** Why the probe took no reading; a throw is one too, so it never ends the pass. */
function probeFault(probe: (configDir: string) => boolean, configDir: string): string | undefined {
  try {
    return probe(configDir) ? undefined : 'the headless turn carried no reading'
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** A failed probe is logged and keeps its pool unprobed for an hour; a good one clears that. */
function probe(pass: Pass, pool: Pool, run: (configDir: string) => boolean, nowMs: number): void {
  const fault = probeFault(run, pool.configDir)
  const before = Object.entries(pass.doc.probeFailed ?? {})
  const others = Object.fromEntries(before.filter(([name]) => name !== pool.name))
  pass.doc.probeFailed = fault === undefined ? others : { ...others, [pool.name]: nowMs }
  if (fault !== undefined)
    pass.probeFaults.push(`pool ${pool.name}: Watchdog: probe failed (${fault}); not probed again for 1 h`)
}

/** CC-491: a pool with no reading under 15 minutes old is probed once, and never under --dry-run. */
function freshRead(pass: Pass, pool: Pool, nowMs: number): BudgetRead {
  const read = pass.deps.readBudget(pool.configDir, nowMs)
  const fresh = read.found && read.age_seconds <= MAX_READING_AGE_SECONDS
  const failedAt = pass.doc.probeFailed?.[pool.name]
  const backedOff = failedAt !== undefined && nowMs - failedAt < PROBE_BACKOFF_MS
  if (fresh || pass.dryRun || pass.deps.probe === undefined || backedOff) return read
  probe(pass, pool, pass.deps.probe, nowMs)
  return pass.deps.readBudget(pool.configDir, nowMs)
}

function poolReading(pass: Pass, pool: Pool): AccountReading | undefined {
  if (!pass.readings.has(pool.name)) {
    const nowMs = pass.now.getTime()
    const read = freshRead(pass, pool, nowMs)
    const reading = accountReading(read, nowMs)
    const resetsAt = read.found ? read.budget.rate_limits.seven_day?.resets_at : undefined
    pass.readings.set(pool.name, reading)
    pass.resets.set(pool.name, resetsAt === undefined ? undefined : resetsAt * 1000)
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

/** Owner stop first, then the restart window, machine pressure, then the seat's own pause line. */
function holdFor(
  pass: Pick<Pass, 'doc' | 'restart' | 'machine'>,
  seat: Seat,
  logStop: string | undefined,
): string | undefined {
  const ownerStop = pass.doc.stopped[seat.name]
  return (
    (ownerStop === undefined ? undefined : `stopped by the owner: ${ownerStop}`) ??
    pass.restart ??
    pass.machine ??
    logStop
  )
}

/** CC-947: the watchdog's view of one seat outside a pass, for a caller that must hold exactly when it would. */
export interface SeatGate {
  /** An unreadable roster reads as not connected. */
  connected: boolean
  hold: string | undefined
}

export async function seatGate(deps: WatchdogDeps, seat: Seat): Promise<SeatGate> {
  const charter = deps.readCharter()
  if (charter === undefined) throw new Error('no autonomy charter.md under the root')
  const roster = await deps.roster()
  const journal = seatJournal(deps, seat.name)
  const holds = {
    doc: deps.loadDoc(),
    restart: openRestartWindow(deps, charter, deps.now()),
    machine: deps.machineStop?.(),
  }
  return { connected: roster.connected.includes(seat.name), hold: holdFor(holds, seat, journal.stop) }
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
    pacing: seat.pacing,
    resetsAt: pool === undefined ? undefined : pass.resets.get(pool.name),
  })
}

type ResumeMark = Pick<SeatRecord, 'resumedDark' | 'resumeRetry' | 'absent'>

interface SeatLiveness {
  verdict: LivenessVerdict
  /** The resume mark and the absence clock to save with the seat's record. */
  mark: ResumeMark
  /** Read only for a seat with no connected session on a readable roster. */
  presence?: Presence
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

/** TP-812: how long a live roster row outranks a seat that stayed dark; a crashed broker can leave the row live for good. */
export const LIVE_ROW_GRACE_MS = 30 * 60_000

/** TP-812: an unreadable roster says nothing about a seat, so nothing is resumed and no try is counted. */
function unknownRoster(roster: Roster): LivenessVerdict | undefined {
  if (roster.unknown === undefined) return undefined
  return { resume: false, reason: 'roster unknown', idleHold: `roster unknown: ${roster.unknown}` }
}

const rowLive = (roster: Roster, seat: string): boolean =>
  roster.agents.some(a => a.name === seat && a.state === 'live') && !roster.connected.includes(seat)

/** TP-812: a resume the roster says is pointless waits out the grace, is logged each run, and then goes ahead. */
function heldByLiveRow(verdict: LivenessVerdict, nowMs: number): LivenessVerdict {
  if (verdict.resume && nowMs - (verdict.episode ?? nowMs) > LIVE_ROW_GRACE_MS) return verdict
  const idleHold = 'roster shows it live'
  if (!verdict.resume) return { ...verdict, idleHold: verdict.idleHold ?? idleHold }
  return {
    resume: false,
    reason: `${verdict.reason}; not resumed: roster shows it live`,
    refused: true,
    idleHold,
  }
}

function seatLiveness(pass: Pass, seat: string, hold: string | undefined): SeatLiveness {
  const previous = pass.doc.seats[seat]
  const unknown = unknownRoster(pass.roster)
  if (unknown !== undefined)
    return {
      verdict: unknown,
      mark: resumeMark(previous?.resumedDark, previous?.resumeRetry, previous?.absent),
    }
  const connected = pass.roster.connected.includes(seat)
  const presence = connected ? undefined : pass.deps.presence(seat)
  const nowMs = pass.now.getTime()
  const absent = connected ? undefined : absence(previous?.absent, presence, nowMs)
  const attempted = previous?.resumedDark
  const unconfirmed = previous?.resumeRetry
  const input = { connected, presence, hold, absentSince: absent?.since, attempted, unconfirmed, nowMs }
  const judged = judgeLiveness(input)
  const verdict = rowLive(pass.roster, seat) ? heldByLiveRow(judged, nowMs) : judged
  const mark = verdict.resume
    ? resumeMark(verdict.episode, verdict.tries, absent)
    : resumeMark(attempted, unconfirmed, absent)
  return { verdict, mark, ...(presence === undefined ? {} : { presence }) }
}

/** What the relaunch step does for a seat: relaunch, flag a failed teleport, or say why not. */
interface SeatRelaunch {
  verdict: RelaunchVerdict
  /** CC-465: the newest generation that never started, which a resume cannot bring up. */
  successor?: string
}

/** CC-465: the seat's newest generation, still spawning 15 min on with no transcript. */
function stuckSuccessor(pass: Pass, seat: string): string | undefined {
  const newest = pass.roster.agents
    .filter(agent => agent.name === seat)
    .sort((a, b) => (b.generation ?? 1) - (a.generation ?? 1))[0]
  if (newest?.agentId === undefined || newest.state !== 'spawning' || newest.spawnedAt === undefined)
    return undefined
  if (pass.now.getTime() - newest.spawnedAt < HANDOFF_GRACE_MS) return undefined
  return pass.deps.transcriptFound?.(newest.agentId) === false ? newest.agentId : undefined
}

/** CC-465: judged after liveness for a seat with no connected session; never for one liveness resumed or refused, or the roster cannot place. */
function seatRelaunch(
  pass: Pass,
  seat: string,
  liveness: SeatLiveness,
  hold: string | undefined,
  activityAt: number | undefined,
): SeatRelaunch | undefined {
  const { verdict } = liveness
  if (pass.deps.relaunchHandoff === undefined || verdict.resume || verdict.refused) return undefined
  const connected = pass.roster.connected.includes(seat)
  if (connected || pass.roster.unknown !== undefined || rowLive(pass.roster, seat)) return undefined
  const previous = pass.doc.seats[seat]
  const relaunch = judgeRelaunch({
    connected,
    presence: liveness.presence,
    activityAt,
    hold,
    relaunchedAt: previous?.relaunchedAt,
    relaunchTries: previous?.relaunchTries,
    nowMs: pass.now.getTime(),
  })
  const successor = relaunch.relaunch ? stuckSuccessor(pass, seat) : undefined
  return { verdict: relaunch, ...(successor === undefined ? {} : { successor }) }
}

const relaunchHold = (relaunch: SeatRelaunch | undefined): string | undefined =>
  relaunch === undefined ? undefined : `relaunch: ${relaunch.verdict.reason}`

type CarriedMarks = Pick<SeatRecord, 'relaunchedAt' | 'relaunchTries' | 'teleportFailed' | 'heartbeat'>

/** The marks a pass keeps from the seat's last record unless an action this pass replaces them. */
const carriedMarks = (previous: SeatRecord | undefined): CarriedMarks => ({
  ...(previous?.relaunchedAt === undefined ? {} : { relaunchedAt: previous.relaunchedAt }),
  ...(previous?.relaunchTries === undefined ? {} : { relaunchTries: previous.relaunchTries }),
  ...(previous?.teleportFailed === undefined ? {} : { teleportFailed: previous.teleportFailed }),
  ...(previous?.heartbeat === undefined ? {} : { heartbeat: previous.heartbeat }),
})

interface Judgement {
  decision: Decision
  budget: BudgetVerdict
  record: SeatRecord
  liveness: LivenessVerdict
  /** CC-465: undefined when the relaunch step does not apply this pass. */
  relaunch?: SeatRelaunch
  /** CC-326: set when the seat's journal could not be read. */
  journalFault?: string
  log: SeatJournal
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
  const relaunch = seatRelaunch(pass, seat.name, liveness, resumeHold, log.activityAt)
  // CC-465: a dark seat is the relaunch's, so the idle wake never resumes one the relaunch held back.
  const hold = ownHold ?? liveness.verdict.idleHold ?? relaunchHold(relaunch)
  const decision = decide(observe(pass, seat, budget, hold, log.activityAt), previous, nowMs, pass.fireCap)
  const record = {
    ...decision.next,
    ...(run === undefined ? {} : { run }),
    budgetPaused: !budget.open,
    capped: (decision.next.fires ?? 0) >= (pass.fireCap ?? FIRE_CAP),
    ...liveness.mark,
    ...carriedMarks(previous),
  }
  const extra = {
    ...(log.unreadable === undefined ? {} : { journalFault: log.unreadable }),
    ...(relaunch === undefined ? {} : { relaunch }),
  }
  return { decision, budget, record, liveness: liveness.verdict, log, ...extra }
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

/** CC-402: each seat agent stuck in `spawning` is logged once; the record keeps the names still stuck. */
function spawningChange(pass: Pass, seat: Seat, record: SeatRecord, dryRun: boolean): string[] {
  const stuck = stuckSpawning(pass.roster.agents, seat, pass.now.getTime())
  const flagged = pass.doc.seats[seat.name]?.spawningFlagged ?? []
  if (stuck.length > 0) record.spawningFlagged = stuck.map(agent => agent.name)
  else delete record.spawningFlagged
  return stuck
    .filter(agent => !flagged.includes(agent.name))
    .map(agent => {
      const line = `Watchdog: ${agent.name} in state spawning for ${agent.minutes} min; its launch never registered`
      if (!dryRun) pass.deps.appendLog(seat.name, pass.now, line)
      return `${seat.name}: ${line}`
    })
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
    ...(pass.doc.probeFailed === undefined ? {} : { probeFailed: pass.doc.probeFailed }),
    ...(pass.doc.attended === undefined ? {} : { attended: pass.doc.attended }),
    ...(pass.doc.serviceHeard === undefined ? {} : { serviceHeard: pass.doc.serviceHeard }),
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
  const refreshed = woke.ok ? refreshUnits(pass.deps, seat) : undefined
  return `${seat}: ${line}${refreshed === undefined ? '' : `; ${refreshed}`}`
}

/** A unit write that fails must not fail the resume that already happened. */
function refreshUnits(deps: WatchdogDeps, seat: string): string | undefined {
  try {
    return deps.refreshHeartbeat?.(seat)
  } catch (err) {
    return `heartbeat units not refreshed (${err instanceof Error ? err.message : String(err)})`
  }
}

/**
 * CC-862: the seat's `Heartbeat tick`, or its wake at a BUDGET-PAUSE reset plus two minutes.
 * Only a connected seat is ticked; a dark one is the resume's, and an owner stop or a hold on every seat stops the tick too.
 */
async function heartbeat(pass: Pass, seat: Seat, log: SeatJournal): Promise<string[]> {
  const name = seat.name
  const record = pass.doc.seats[name]
  if (record === undefined || log.unreadable !== undefined) return []
  if (!pass.roster.connected.includes(name) || holdFor(pass, seat, undefined) !== undefined) return []
  const step = heartbeatStep({
    cron: seat.heartbeatCron,
    nowMs: pass.now.getTime(),
    stopped: log.stop !== undefined && log.paused !== true,
    paused: log.paused === true,
    pauseUntil: log.pauseUntil,
    activityAt: log.activityAt,
    mark: record.heartbeat,
    source: seat.heartbeatSource,
  })
  if (step.mark === undefined) return []
  if (step.message === undefined) {
    record.heartbeat = step.mark
    return []
  }
  const woke = await pass.deps.wake(name, step.message, true)
  // The mark advances only on delivery, so a failed tick or pause wake is retried next run.
  if (!woke.ok) return [`${name}: Watchdog: heartbeat FAILED (${woke.detail})`]
  record.heartbeat = step.mark
  pass.deps.logEvent?.('heartbeat_watchdog', heartbeatRow(seat, step))
  return []
}

function heartbeatRow(seat: Seat, step: HeartbeatStep): Record<string, unknown> {
  const pauseWake = step.message === PAUSE_WAKE_MESSAGE
  return {
    seat: seat.name,
    source: seat.heartbeatSource ?? 'cron',
    ...(pauseWake ? { pauseWake: true, until: step.mark?.wokeFor } : { slot: step.mark?.slot }),
  }
}

/** CC-465: a seat with no log line at all has been quiet at least the relaunch threshold. */
function quietMinutes(nowMs: number, activityAt: number | undefined): number {
  const since = activityAt ?? nowMs - RELAUNCH_QUIET_MS
  return Math.floor((nowMs - since) / 60_000)
}

/** CC-465: the mark is saved before the launch, as the resume's is, so a run that dies mid-call has still marked it. */
async function relaunchDark(
  pass: Pass,
  seat: string,
  verdict: RelaunchVerdict,
  handoff: (seat: string, quietMinutes: number, now: Date) => string,
  activityAt: number | undefined,
): Promise<string> {
  const record = pass.doc.seats[seat]
  if (record !== undefined) {
    record.relaunchedAt = pass.now.getTime()
    record.relaunchTries = verdict.tries ?? 1
  }
  save(pass)
  const message = handoff(seat, quietMinutes(pass.now.getTime(), activityAt), pass.now)
  const woke = await pass.deps
    .wake(seat, message, false)
    .catch((err: unknown) => ({ ok: false, detail: err instanceof Error ? err.message : String(err) }))
  const outcome = woke.ok ? `relaunched: ${woke.detail}` : `relaunch FAILED: ${woke.detail}`
  const line = `watchdog relaunch ${seat} (${verdict.reason}; ${outcome})`
  pass.deps.appendLog(seat, pass.deps.now(), line)
  return line
}

const failedTeleportLine = (seat: string, successor: string): string =>
  `watchdog relaunch ${seat} FAILED: teleport successor ${successor} never started; ` +
  `run ~/.agent-chat/agents/${successor}/relaunch`

/** CC-465: retires nothing; logs and raises one human item per stuck successor, retried until one is raised. */
async function failedTeleport(pass: Pass, seat: string, successor: string): Promise<string[]> {
  const record = pass.doc.seats[seat]
  if (record?.teleportFailed === successor) return []
  const line = failedTeleportLine(seat, successor)
  pass.deps.appendLog(seat, pass.deps.now(), line)
  const raised = (await pass.deps.notifyHuman?.(line).catch((err: unknown) => ({
    ok: false,
    detail: err instanceof Error ? err.message : String(err),
  }))) ?? { ok: false, detail: 'no human queue' }
  if (!raised.ok) return [`${line}; human item not raised (${raised.detail})`]
  if (record !== undefined) record.teleportFailed = successor
  return [line]
}

/** Liveness first, then the relaunch, then the idle wake; the first that acts ends the seat's turn. */
async function seatAction(pass: Pass, name: string, judged: Judgement): Promise<string[]> {
  const { liveness, relaunch, decision, journalFault } = judged
  if (liveness.resume) return [await resumeDark(pass, name, liveness)]
  if (liveness.refused) return [`${name}: Watchdog: ${liveness.reason}`]
  if (relaunch?.successor !== undefined) return failedTeleport(pass, name, relaunch.successor)
  const handoff = pass.deps.relaunchHandoff
  if (relaunch?.verdict.relaunch && handoff !== undefined)
    return [await relaunchDark(pass, name, relaunch.verdict, handoff, judged.log.activityAt)]
  if (relaunch?.verdict.refused) return [`${name}: Watchdog: ${relaunch.verdict.reason}`]
  if (decision.fire) return [await act(pass, name, decision)]
  if (journalFault !== undefined) return [`${name}: Watchdog: held: ${journalFault}`]
  return []
}

function dryRunLine({ decision, liveness, relaunch }: Judgement): string {
  if (liveness.resume) return `WOULD RESUME: ${liveness.reason}`
  if (liveness.refused) return `skip: ${liveness.reason}`
  if (relaunch?.successor !== undefined)
    return `WOULD FLAG: teleport successor ${relaunch.successor} never started`
  if (relaunch?.verdict.relaunch) return `WOULD RELAUNCH: ${relaunch.verdict.reason}`
  if (relaunch?.verdict.refused) return `skip: ${relaunch.verdict.reason}`
  return `${decision.fire ? 'WOULD FIRE' : 'skip'}: ${decision.reason}`
}

function seatOrSkip(deps: WatchdogDeps, name: string): Seat | string {
  if (!isSeatName(name)) return `${name}: skipped, not a seat name`
  const seat = parseSeat(name, deps.readSeatFile(name) ?? '')
  return seat ?? `${name}: skipped, seats/${name}.md has no prefix or pool`
}

/** Every charter pool is read, seat or no seat, so a pool no seat calls home still has a pace. */
function publishPoolPace(pass: Pass): string | undefined {
  const nowMs = pass.now.getTime()
  const rows = [...pass.pools.values()].map(pool =>
    poolPace(pool.name, poolReading(pass, pool), pool.rule.reserve_seven_day, nowMs),
  )
  try {
    if (pass.deps.pace !== undefined) publishPace(pass.deps.pace, rows, nowMs)
    return undefined
  } catch (err) {
    return `Watchdog: pace not published: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** One warning a pass for the attended seats whose files no longer gate their spawns. */
function attendedChange(pass: Pass, charter: string): string | undefined {
  const { seatNames, readSeatFile } = pass.deps
  if (seatNames === undefined) return undefined
  const check = checkAttended({ seatNames, readSeatFile }, charter, pass.doc.attended ?? [])
  pass.doc.attended = check.seats
  return check.warning
}

/** CC-598, CC-693: each attended seat hears of a service cause once; a seat that missed it is sent it again next pass. */
async function serviceChange(pass: Pass): Promise<string[]> {
  const { serviceCheck } = pass.deps
  if (serviceCheck === undefined) return []
  const run = await runServiceCheck(serviceCheck)
  const heard = { ...pass.doc.serviceHeard }
  const seats = (pass.doc.attended ?? []).filter(seat => pass.roster.connected.includes(seat))
  const lines: string[] = []
  for (const seat of seats) {
    const notice = judgeService(heard[seat], run)
    if (notice.message === undefined) continue
    const woke = await pass.deps.wake(seat, notice.message, true)
    pass.deps.appendLog(seat, pass.deps.now(), notice.message)
    lines.push(`${seat}: ${notice.message}${woke.ok ? '' : ` (not delivered: ${woke.detail})`}`)
    if (!woke.ok) continue
    if (notice.cause === undefined) delete heard[seat]
    else heard[seat] = notice.cause
  }
  if (Object.keys(heard).length === 0) delete pass.doc.serviceHeard
  else pass.doc.serviceHeard = heard
  return lines
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
    machine: deps.machineStop?.(),
    readings: new Map(),
    resets: new Map(),
    fireCap: options.fireCap,
    dryRun: options.dryRun,
    gaps: [],
    probeFaults: [],
  }
  return [pass, charter]
}

/** The state-change lines a seat's judgement produces, each written once; none under --dry-run but agents stuck spawning. */
function changeLines(pass: Pass, seat: Seat, { budget, record }: Judgement): string[] {
  const lines = pass.dryRun
    ? []
    : [budgetChange(pass, seat.name, budget), capChange(pass, seat.name, record)].filter(
        (line): line is string => line !== undefined,
      )
  return [...lines, ...spawningChange(pass, seat, record, pass.dryRun)]
}

async function passSeat(pass: Pass, name: string): Promise<string[]> {
  const seat = seatOrSkip(pass.deps, name)
  if (typeof seat === 'string') return [seat]
  const judged = judgeSeat(pass, seat)
  const lines = changeLines(pass, seat, judged)
  pass.doc.seats[name] = judged.record
  if (pass.dryRun) return [...lines, `${name}: ${dryRunLine(judged)}`]
  lines.push(...(await seatAction(pass, name, judged)))
  if (!judged.liveness.resume) lines.push(...(await heartbeat(pass, seat, judged.log)))
  return lines
}

function passHead(pass: Pass, charter: string): string[] {
  const roster = pass.roster.unknown
  return [
    pass.dryRun ? undefined : holdChange(pass),
    attendedChange(pass, charter),
    roster === undefined ? undefined : `Watchdog: roster unreadable (${roster}); no seat resumed this run`,
  ].filter((line): line is string => line !== undefined)
}

async function passTail(pass: Pass): Promise<string[]> {
  const lines = pass.dryRun ? [] : await serviceChange(pass)
  const paceFault = pass.dryRun ? undefined : publishPoolPace(pass)
  if (paceFault !== undefined) lines.push(paceFault)
  lines.push(...pass.probeFaults)
  for (const pool of pass.gaps)
    lines.push(
      `pool ${pool}: no seven_day reading at or before 07:00, so the day's spend counts from the first sample`,
    )
  return lines
}

async function runPass(deps: WatchdogDeps, options: WatchdogOptions, lines: string[]): Promise<string[]> {
  const [pass, charter] = await startPass(deps, options)
  lines.push(...passHead(pass, charter))
  for (const name of options.seats ?? charterSeats(charter)) lines.push(...(await passSeat(pass, name)))
  lines.push(...(await passTail(pass)))
  if (!options.dryRun) save(pass)
  return lines
}

/** Output lines: one per seat under --dry-run, else only wakes, refused resumes, relaunches, agents stuck spawning, unreadable journals and misconfigured seats. */
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
