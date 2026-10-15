import { accountGroups, accountIdentity, type AccountGroups } from '../account-identity.js'
import type { BudgetRead } from '../budget.js'
import { MAX_READING_AGE_SECONDS, dayStart, type AccountReading } from '../burndown/budget-gate.js'
import type { SeatState } from '../burndown/ledger.js'
import { seatSpend } from '../burndown/spend-meter.js'
import {
  charterOwnerSeat,
  charterSeats,
  isSeatName,
  parsePools,
  parseSeat,
  type Pool,
  type Seat,
} from './charter.js'
import { heartbeatStep, idleLiveStep, PAUSE_WAKE_MESSAGE, type HeartbeatStep } from './heartbeat.js'
import type { Eligibility, SeatRecord, WatchdogDoc } from './io.js'
import {
  RESUME_MESSAGE,
  RESUME_TRY_CAP,
  seatIsLiveRefusal,
  judgeLiveness,
  type LivenessVerdict,
  type Presence,
} from './liveness.js'
import type { RunLock } from './lock.js'
import { HANDOFF_GRACE_MS, RELAUNCH_QUIET_MS, judgeRelaunch, type RelaunchVerdict } from './relaunch.js'
import { checkAttended } from './attended.js'
import { blockLive, blockPageChange } from './block-page.js'
import type { OpenBlock } from '../../seat-blocks.js'
import { judgeService, runServiceCheck, type ServiceCheckRunner } from './service-check.js'
import { seatAccount, type SeatAccount } from './seat-account.js'
import {
  PANE_HOLD_CAP_MS,
  seatPane,
  seatTarget,
  type RelaunchTarget,
  type SeatRelaunchPlan,
} from './seat-target.js'
import { poolPace, type PoolPace } from './pace.js'
import { dayOpening, publishPace, type PaceStore } from './pace-pass.js'
import {
  RESTART_WINDOW_MAX_MS,
  advanceMeter,
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
  WATCHDOG_MAX_READING_AGE_SECONDS,
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

export interface RelaunchSeatResult extends WakeResult {
  /**
   * CC-959: nothing launched and the human must hear why: the broker cannot retire by id, the seat has
   * no granted profile, or the spawn was refused after its stale rows were already retired.
   */
  refused?: true
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
  /** CC-1289: the Anthropic login a config dir bills; absent, its `.claude.json` is read. */
  identify?: (configDir: string) => string | undefined
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
  /** CC-959: launches a dark seat on its own account when its latest session cannot be resumed by name; absent, that seat is refused and flagged. */
  relaunchSeat?: (seat: string, plan: SeatRelaunchPlan) => Promise<RelaunchSeatResult>
  /** CC-391: records each delivered heartbeat as a `heartbeat_watchdog` row; absent, nothing is recorded. */
  logEvent?: (event: string, detail: Record<string, unknown>) => void
  /** CC-1057: the seat blocks still open at `nowMs`; undefined when events.db cannot be read, which pages nothing. */
  openBlocks?: (nowMs: number) => OpenBlock[] | undefined
  /** CC-1057: sends one page; absent with `openBlocks`, the pass pages nothing. */
  page?: (to: string, text: string) => Promise<WakeResult>
  /** CC-1099: the seat's burndown ledger state, whose samples count spend before the meters do; absent, the meters alone. */
  seatState?: (seat: string) => SeatState | undefined
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
  /** CC-1289: pools on one login read, probe, meter and pace once, under the first member's name. */
  accounts: AccountGroups
  roster: Roster
  doc: WatchdogDoc
  restart: string | undefined
  machine: string | undefined
  readings: Map<string, AccountReading | undefined>
  /** CC-404: epoch ms each pool's seven_day window resets, from the same status file as its reading. */
  resets: Map<string, number | undefined>
  fireCap: number | undefined
  dryRun: boolean
  /** The seats `--seat` named; undefined means every charter seat. */
  seats: string[] | undefined
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

/** CC-346: a pool with no saved day meter starts from the reading history, so a deleted doc keeps the day's spend. */
function dayMeter(pass: Pass, key: string, sevenDay: number | undefined): SpendMeter | undefined {
  const saved = pass.doc.pools[key]
  if (saved !== undefined || sevenDay === undefined) return saved
  const dayStartMs = dayStart(pass.now)
  const resetsAt = pass.resets.get(key)
  const pools = pass.accounts.members(key)
  const opening = dayOpening(pass.deps.pace?.rows?.() ?? [], {
    pool: key,
    pools,
    dayStartMs,
    sevenDay,
    resetsAt,
  })
  if (opening === undefined) return undefined
  const at = opening.ts * 1000
  if (at > dayStartMs) pass.gaps.push(key)
  // A first sample after 07:00 dates the meter, as one the pass started then would be, so status names the gap.
  return { since: Math.max(at, dayStartMs), last: opening.seven_day, spent: 0 }
}

/** CC-1289: the key pool's reading and meter are copied to every member, so readers keyed by pool name agree. */
function readAccount(pass: Pass, key: Pool): void {
  const nowMs = pass.now.getTime()
  const read = freshRead(pass, key, nowMs)
  const reading = accountReading(read, nowMs)
  const resetsS = read.found ? read.budget.rate_limits.seven_day?.resets_at : undefined
  const resetsAt = resetsS === undefined ? undefined : resetsS * 1000
  pass.resets.set(key.name, resetsAt)
  const kept = keepReading(pass.doc.lastReadings?.[key.name], reading, nowMs)
  const seeded = dayMeter(pass, key.name, reading?.sevenDay)
  const meter = advanceMeter(seeded, reading?.sevenDay, nowMs, sameSpendDay)
  if (meter !== undefined && seeded === undefined && meter.since === nowMs) pass.gaps.push(key.name)
  for (const member of pass.accounts.members(key.name)) {
    pass.readings.set(member, reading)
    pass.resets.set(member, resetsAt)
    if (kept !== undefined) pass.doc.lastReadings = { ...pass.doc.lastReadings, [member]: { ...kept } }
    if (meter !== undefined) pass.doc.pools[member] = { ...meter }
  }
}

function poolReading(pass: Pass, pool: Pool): AccountReading | undefined {
  if (!pass.readings.has(pool.name)) readAccount(pass, pass.pools.get(pass.accounts.keyOf(pool.name)) ?? pool)
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

/** The seat's ledger state; a throw reads as none, which leaves the meters to count. */
function ledgerState(deps: WatchdogDeps, seat: string): SeatState | undefined {
  try {
    return deps.seatState?.(seat)
  } catch {
    return undefined
  }
}

/** CC-1099: gatePool on the seat's pool, its run and day spend counted by `seatSpend` as every reader counts it. */
function seatBudget(
  pass: Pass,
  seat: Seat,
  reading: AccountReading | undefined,
  run: SpendMeter | undefined,
): BudgetVerdict {
  const pool = pass.pools.get(seat.pool)
  const day = pool === undefined ? undefined : pass.doc.pools[pool.name]
  const { history, runStart } = seatSpend({
    seatState: pool === undefined ? undefined : ledgerState(pass.deps, seat.name),
    configDir: pool?.configDir ?? '',
    saved: { run, day },
    sevenDay: reading?.sevenDay,
    now: pass.now,
  })
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
    ...(pass.deps.probe === undefined ? {} : { maxReadingAgeSeconds: WATCHDOG_MAX_READING_AGE_SECONDS }),
  })
}

type ResumeMark = Pick<SeatRecord, 'resumedDark' | 'resumeRetry' | 'absent'>

interface SeatLiveness {
  verdict: LivenessVerdict
  /** The resume mark and the absence clock to save with the seat's record. */
  mark: ResumeMark
  /** Read only for a seat with no connected session on a readable roster. */
  presence?: Presence
  /** CC-959: a session that may be the seat's pane carrying on under another name. */
  pane?: PaneHold
}

interface PaneHold {
  pane: SeatAgent
  /** The hold has outrun its cap, so the human is asked instead. */
  overCap: boolean
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
  const byRow = rowLive(pass.roster, seat) ? heldByLiveRow(judged, nowMs) : judged
  const pane = paneHold(pass, seat, presence)
  const verdict = pane === undefined ? byRow : heldByPane(byRow, pane.pane)
  const mark = verdict.resume
    ? resumeMark(verdict.episode, verdict.tries, absent)
    : resumeMark(attempted, unconfirmed, absent)
  return {
    verdict,
    mark,
    ...(presence === undefined ? {} : { presence }),
    ...(pane === undefined ? {} : { pane }),
  }
}

/** CC-959: the seat file's cwd, else the one its newest row ran in. */
function seatCwd(pass: Pass, seat: string): string | undefined {
  const own = seatAccount(pass.deps.readSeatFile(seat) ?? '', pass.pools)?.cwd
  if (own !== undefined) return own
  const rows = pass.roster.agents.filter(agent => agent.name === seat && agent.cwd !== undefined)
  return rows.sort((a, b) => (b.spawnedAt ?? 0) - (a.spawnedAt ?? 0))[0]?.cwd
}

function paneHold(pass: Pass, seat: string, presence: Presence | undefined): PaneHold | undefined {
  const darkSince = presence?.darkSince
  if (darkSince === undefined) return undefined
  const { agents, connected } = pass.roster
  const pane = seatPane({ agents, connected, seat, cwd: seatCwd(pass, seat), darkSince })
  if (pane === undefined) return undefined
  return { pane, overCap: pass.now.getTime() - darkSince > PANE_HOLD_CAP_MS }
}

const paneLabel = (pane: SeatAgent): string =>
  `possible live seat pane ${pane.name} (${pane.agentId ?? pane.sessionId ?? 'no id'}) in ${pane.cwd}`

/** CC-959: unlike a live row, a possible pane has no grace that lets the resume go ahead. */
function heldByPane(verdict: LivenessVerdict, pane: SeatAgent): LivenessVerdict {
  const idleHold = paneLabel(pane)
  if (!verdict.resume) return { ...verdict, idleHold: verdict.idleHold ?? idleHold }
  return { resume: false, reason: `${verdict.reason}; not resumed: ${idleHold}`, refused: true, idleHold }
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
  if (liveness.pane !== undefined) return undefined
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

type CarriedMarks = Pick<
  SeatRecord,
  | 'relaunchedAt'
  | 'relaunchTries'
  | 'teleportFailed'
  | 'staleRefused'
  | 'paneHeld'
  | 'liveRefused'
  | 'heartbeat'
>

/** The marks a pass keeps from the seat's last record unless an action this pass replaces them. */
const carriedMarks = (previous: SeatRecord | undefined): CarriedMarks => ({
  ...(previous?.relaunchedAt === undefined ? {} : { relaunchedAt: previous.relaunchedAt }),
  ...(previous?.relaunchTries === undefined ? {} : { relaunchTries: previous.relaunchTries }),
  ...(previous?.teleportFailed === undefined ? {} : { teleportFailed: previous.teleportFailed }),
  ...(previous?.staleRefused === undefined ? {} : { staleRefused: previous.staleRefused }),
  ...(previous?.paneHeld === undefined ? {} : { paneHeld: previous.paneHeld }),
  ...(previous?.liveRefused === undefined ? {} : { liveRefused: previous.liveRefused }),
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
  /** CC-959: why a dark seat must not be woken by name, keyed by its latest session. */
  stale?: StaleSeat
  /** CC-959: a possible live pane whose hold outran its cap. */
  paneOverCap?: SeatAgent
}

interface StaleSeat {
  session: string
  reason: string
  target: RelaunchTarget
  /** Undefined when the seat file names no account, which no launch may guess. */
  account: SeatAccount | undefined
}

/** CC-959: undefined when a name-keyed resume wakes the seat's latest session on the seat file's account. */
function staleSeat(pass: Pass, seat: string): StaleSeat | undefined {
  const account = seatAccount(pass.deps.readSeatFile(seat) ?? '', pass.pools)
  const target = seatTarget(pass.roster.agents, seat, account)
  if (target.kind === 'resume-by-name') return undefined
  const { latest, stale } = target
  const session = latest.sessionId ?? latest.agentId ?? latest.name
  const dir = latest.configDir || 'an unrecorded account'
  const holders = stale.length === 0 ? '' : `; older spawned rows still hold the name: ${stale.join(', ')}`
  const reason =
    `latest session ${session} is ${latest.origin ?? 'spawned'} on ${dir}; ` +
    `seat file names ${account?.configDir ?? 'no account'}${holders}`
  return { session, reason, target, account }
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
  // CC-466: a pool closed only for want of a reading does not; the resumed seat's boot reads it.
  const resumeHold =
    ownHold ?? (budget.open || budget.noReading ? undefined : `budget closed: ${budget.reason}`)
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
  const stale = pass.roster.connected.includes(seat.name) ? undefined : staleSeat(pass, seat.name)
  const extra = {
    ...(log.unreadable === undefined ? {} : { journalFault: log.unreadable }),
    ...(relaunch === undefined ? {} : { relaunch }),
    ...(stale === undefined ? {} : { stale }),
    ...(liveness.pane?.overCap === true ? { paneOverCap: liveness.pane.pane } : {}),
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

async function act(pass: Pass, seat: string, decision: Decision, launch: Launch): Promise<string> {
  const connected = pass.roster.connected.includes(seat)
  const woke = connected ? await pass.deps.wake(seat, WAKE_MESSAGE, true) : await launch(seat, WAKE_MESSAGE)
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
    ...(pass.doc.blockPaged === undefined ? {} : { blockPaged: pass.doc.blockPaged }),
  })
}

/**
 * CC-320, CC-326. The mark is saved before the resume and stays unconfirmed until the broker
 * accepts it, so a refusal or a run that dies mid-call is retried and an accepted resume never is.
 */
async function resumeDark(
  pass: Pass,
  seat: string,
  liveness: LivenessVerdict,
  launch: Launch,
): Promise<string[]> {
  save(pass)
  const woke = await launch(seat, RESUME_MESSAGE).catch((err: unknown) => ({
    ok: false,
    detail: err instanceof Error ? err.message : String(err),
  }))
  if (!woke.ok && seatIsLiveRefusal(woke.detail)) return refusedLive(pass, seat, liveness, woke.detail)
  if (woke.ok) delete pass.doc.seats[seat]?.resumeRetry
  const next = (liveness.tries ?? 1) < RESUME_TRY_CAP ? 'will retry next run' : 'giving up on this episode'
  const outcome = woke.ok
    ? `resumed ${seat} (${woke.detail})`
    : `resume FAILED ${seat} (${woke.detail}); ${next}`
  const line = `Watchdog: ${liveness.reason}; ${outcome}`
  pass.deps.appendLog(seat, pass.deps.now(), line)
  const refreshed = woke.ok ? refreshUnits(pass.deps, seat) : undefined
  return [`${seat}: ${line}${refreshed === undefined ? '' : `; ${refreshed}`}`]
}

/**
 * CC-344: the broker says the seat is or may be live, which no retry fixes, so the try is handed
 * back (kept at 0, not deleted, so the episode stays open) and the human is told once per episode.
 */
async function refusedLive(
  pass: Pass,
  seat: string,
  liveness: LivenessVerdict,
  detail: string,
): Promise<string[]> {
  const record = pass.doc.seats[seat]
  if (record !== undefined) record.resumeRetry = (liveness.tries ?? 1) - 1
  const line =
    `Watchdog: ${liveness.reason}; resume REFUSED ${seat} (${detail}); ` +
    'seat may be live, not counted as a try'
  const flagged = await flagOnce(pass, seat, 'liveRefused', String(liveness.episode), line)
  if (flagged.length === 0) pass.deps.appendLog(seat, pass.deps.now(), line)
  return (flagged.length === 0 ? [line] : flagged).map(out => `${seat}: ${out}`)
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
  if (step.message === undefined) {
    if (step.mark !== undefined) record.heartbeat = step.mark
    return idleLive(pass, seat, log)
  }
  const woke = await pass.deps.wake(name, step.message, true)
  // The mark advances only on delivery, so a failed tick or pause wake is retried next run.
  if (!woke.ok) return [`${name}: Watchdog: heartbeat FAILED (${woke.detail})`]
  record.heartbeat = step.mark
  pass.deps.logEvent?.('heartbeat_watchdog', heartbeatRow(seat, step))
  return []
}

/** CC-400: a seat waiting on its agents can go a whole cron slot without a turn; wake it once per quiet episode. */
async function idleLive(pass: Pass, seat: Seat, log: SeatJournal): Promise<string[]> {
  const record = pass.doc.seats[seat.name]
  if (record === undefined) return []
  const implementers = runningImplementers(pass.roster.agents, seat).length
  const step = idleLiveStep({
    implementers,
    activityAt: log.activityAt,
    stopped: log.stop !== undefined,
    paused: log.paused === true,
    nowMs: pass.now.getTime(),
    mark: record.heartbeat,
  })
  if (step.message === undefined) return []
  const woke = await pass.deps.wake(seat.name, step.message, true)
  // As with the tick, the mark advances only on delivery, so a failed wake is retried next run.
  if (!woke.ok) return [`${seat.name}: Watchdog: idle-live wake FAILED (${woke.detail})`]
  record.heartbeat = step.mark
  pass.deps.logEvent?.('idle_live_wake', { seat: seat.name, implementers, activityAt: log.activityAt })
  return [`${seat.name}: ${step.message}`]
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
  message: string,
  launch: Launch,
): Promise<string> {
  const record = pass.doc.seats[seat]
  if (record !== undefined) {
    record.relaunchedAt = pass.now.getTime()
    record.relaunchTries = verdict.tries ?? 1
  }
  save(pass)
  const woke = await launch(seat, message).catch((err: unknown) => ({
    ok: false,
    detail: err instanceof Error ? err.message : String(err),
  }))
  const outcome = woke.ok ? `relaunched: ${woke.detail}` : `relaunch FAILED: ${woke.detail}`
  const line = `watchdog relaunch ${seat} (${verdict.reason}; ${outcome})`
  pass.deps.appendLog(seat, pass.deps.now(), line)
  return line
}

const failedTeleportLine = (seat: string, successor: string): string =>
  `watchdog relaunch ${seat} FAILED: teleport successor ${successor} never started; ` +
  `run ~/.agent-chat/agents/${successor}/relaunch`

/** Logs and raises one human item per key under `mark`, retried until one is raised. */
async function flagOnce(
  pass: Pass,
  seat: string,
  mark: 'teleportFailed' | 'staleRefused' | 'paneHeld' | 'liveRefused',
  key: string,
  line: string,
): Promise<string[]> {
  const record = pass.doc.seats[seat]
  if (record?.[mark] === key) return []
  pass.deps.appendLog(seat, pass.deps.now(), line)
  const raised = (await pass.deps.notifyHuman?.(line).catch((err: unknown) => ({
    ok: false,
    detail: err instanceof Error ? err.message : String(err),
  }))) ?? { ok: false, detail: 'no human queue' }
  if (!raised.ok) return [`${line}; human item not raised (${raised.detail})`]
  if (record !== undefined) record[mark] = key
  return [line]
}

/** CC-465: retires nothing; logs and raises one human item per stuck successor. */
const failedTeleport = (pass: Pass, seat: string, successor: string): Promise<string[]> =>
  flagOnce(pass, seat, 'teleportFailed', successor, failedTeleportLine(seat, successor))

/** CC-959: wakes nothing; logs and raises one human item per refused latest session. */
const refuseStale = (pass: Pass, seat: string, verb: string, stale: StaleSeat): Promise<string[]> =>
  flagOnce(pass, seat, 'staleRefused', stale.session, `watchdog ${verb} ${seat} REFUSED: ${stale.reason}`)

const paneOverCapLine = (seat: string, pane: SeatAgent): string =>
  `watchdog resume ${seat} HELD over ${PANE_HOLD_CAP_MS / 60_000} min: ${paneLabel(pane)}; ` +
  `not resumed, check whether it is the seat`

/** CC-959: resumes nothing; logs and raises one human item per pane that held the seat past the cap. */
const paneOverCap = (pass: Pass, seat: string, pane: SeatAgent): Promise<string[]> =>
  flagOnce(pass, seat, 'paneHeld', pane.agentId ?? pane.name, paneOverCapLine(seat, pane))

/** Brings a dark seat back with this message. */
type Launch = (seat: string, message: string) => Promise<WakeResult>

/** CC-959: launches on the seat's own account; undefined when the seat file names none or nothing relaunches. */
function relaunchLaunch(
  pass: Pass,
  stale: StaleSeat,
  activityAt: number | undefined,
  onRefused: (why: string) => void,
): Launch | undefined {
  const { account, target } = stale
  const relaunchSeat = pass.deps.relaunchSeat
  if (account === undefined || relaunchSeat === undefined) return undefined
  const quiet = quietMinutes(pass.now.getTime(), activityAt)
  return async (seat, message) => {
    const fresh = pass.deps.relaunchHandoff?.(seat, quiet, pass.now) ?? message
    const res = await relaunchSeat(seat, { target, account, message, fresh })
    if (res.refused === true) onRefused(res.detail)
    return res
  }
}

/**
 * CC-959: a name-keyed resume wakes the stale row, so a seat whose latest session it cannot reach
 * is relaunched on its own account, or refused and flagged when that cannot be done.
 */
function launchGate(pass: Pass, name: string, judged: Judgement) {
  const { stale } = judged
  return async (verb: string, run: (launch: Launch) => Promise<string | string[]>): Promise<string[]> => {
    if (stale === undefined)
      return [await run((seat, message) => pass.deps.wake(seat, message, false))].flat()
    let refusal: string | undefined
    const launch = relaunchLaunch(pass, stale, judged.log.activityAt, why => (refusal = why))
    if (launch === undefined) return refuseStale(pass, name, verb, stale)
    const lines = [await run(launch)].flat()
    if (refusal === undefined) return lines
    const refused = { ...stale, reason: `${stale.reason}; ${refusal}` }
    return [...lines, ...(await refuseStale(pass, name, verb, refused))]
  }
}

/** Liveness first, then the relaunch, then the idle wake; the first that acts ends the seat's turn. */
async function seatAction(pass: Pass, name: string, judged: Judgement): Promise<string[]> {
  const { liveness, relaunch, decision, journalFault } = judged
  if (judged.paneOverCap !== undefined) return paneOverCap(pass, name, judged.paneOverCap)
  const gated = launchGate(pass, name, judged)
  if (liveness.resume) return gated('resume', launch => resumeDark(pass, name, liveness, launch))
  if (liveness.refused) return [`${name}: Watchdog: ${liveness.reason}`]
  if (relaunch?.successor !== undefined) return failedTeleport(pass, name, relaunch.successor)
  const handoff = pass.deps.relaunchHandoff
  if (relaunch?.verdict.relaunch && handoff !== undefined) {
    const message = handoff(name, quietMinutes(pass.now.getTime(), judged.log.activityAt), pass.now)
    return gated('relaunch', launch => relaunchDark(pass, name, relaunch.verdict, message, launch))
  }
  if (relaunch?.verdict.refused) return [`${name}: Watchdog: ${relaunch.verdict.reason}`]
  if (decision.fire) return gated('wake', launch => act(pass, name, decision, launch))
  if (journalFault !== undefined) return [`${name}: Watchdog: held: ${journalFault}`]
  return []
}

/** CC-959: a launch the stale gate would stop or reroute says so, so a dry run shows what the pass does. */
function dryRunLine(pass: Pass, judged: Judgement): string {
  const line = plannedLine(judged)
  const { stale } = judged
  if (stale === undefined || !/^WOULD (RESUME|RELAUNCH|FIRE)/.test(line)) return line
  if (pass.deps.relaunchSeat === undefined || stale.account === undefined)
    return `WOULD REFUSE: ${stale.reason}`
  const session = stale.target.kind === 'resume-session' ? `session ${stale.target.sessionId}` : 'fresh'
  return `${line}; as ${session} on ${stale.account.configDir} (${stale.reason})`
}

function plannedLine({ decision, liveness, relaunch, paneOverCap }: Judgement): string {
  if (paneOverCap !== undefined) return `WOULD FLAG: ${paneLabel(paneOverCap)}`
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

/** CC-1289: one row per account, on its key pool's reserve, naming its members when it has several. */
function accountPace(pass: Pass, key: Pool, nowMs: number): PoolPace {
  const row = poolPace(key.name, poolReading(pass, key), key.rule.reserve_seven_day, nowMs)
  const members = pass.accounts.members(key.name)
  return members.length > 1 ? { ...row, members } : row
}

/** Every charter pool is read, seat or no seat, so a pool no seat calls home still has a pace. */
function publishPoolPace(pass: Pass): string | undefined {
  const nowMs = pass.now.getTime()
  const rows = [...pass.pools.values()]
    .filter(pool => pass.accounts.keyOf(pool.name) === pool.name)
    .map(pool => accountPace(pass, pool, nowMs))
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

/** CC-1057: tp-operator hears once of each live seat blocked on AskUserQuestion over 5 min. */
async function blockPages(pass: Pass): Promise<string[]> {
  const { openBlocks, page } = pass.deps
  if (openBlocks === undefined || page === undefined) return []
  const nowMs = pass.now.getTime()
  const { lines, paged } = await blockPageChange({
    open: openBlocks(nowMs),
    paged: pass.doc.blockPaged ?? [],
    isLive: block => blockLive(pass.roster, block),
    nowMs,
    ...(pass.seats === undefined ? {} : { seats: pass.seats }),
    dryRun: pass.dryRun,
    page,
  })
  if (paged.length === 0) delete pass.doc.blockPaged
  else pass.doc.blockPaged = paged
  return lines
}

async function startPass(deps: WatchdogDeps, options: WatchdogOptions): Promise<[Pass, string]> {
  const charter = deps.readCharter()
  if (charter === undefined) throw new Error('no autonomy charter.md under the root')
  const now = deps.now()
  const pools = parsePools(charter)
  const pass: Pass = {
    deps,
    now,
    pools,
    accounts: accountGroups(pools.values(), deps.identify ?? (dir => accountIdentity(dir))),
    roster: await deps.roster(),
    doc: deps.loadDoc(),
    restart: openRestartWindow(deps, charter, now),
    machine: deps.machineStop?.(),
    readings: new Map(),
    resets: new Map(),
    fireCap: options.fireCap,
    dryRun: options.dryRun,
    seats: options.seats,
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
  if (pass.dryRun) return [...lines, `${name}: ${dryRunLine(pass, judged)}`]
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
  lines.push(...(await blockPages(pass)))
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
