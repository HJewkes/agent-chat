import { currentAutonomyRoot } from '../agents/autonomy-root.js'
import { isSeatName } from '../agents/seats/charter.js'
import { readSeatFile } from '../agents/seats/teleport-state.js'
import { cliEntry } from '../paths.js'
import { JOB_KICK_NAMES, type JobKickName } from '../protocol.js'
import { kickCommand, kickEnv, launchDetached, type JobCommand, type Kicker } from './burndown-kick.js'
import { logEvent } from './log.js'

/**
 * CC-1151: an agent's hand-run tick, watchdog or heartbeat check never runs policy in the agent's process,
 * where its PATH, GH_*, HOME and git env would steer `gh`, `titan-factory` and the roots. It sends the
 * broker a `job_kick` frame naming the job, and the broker runs the job's fixed command in its own env.
 */
export type JobKickRequest =
  { job: 'burndown_tick' } | { job: 'seats_watchdog' } | { job: 'seats_heartbeat_check'; seat: string }

export interface JobKickResult {
  ok: boolean
  detail: string
}

export type JobKick = (request: JobKickRequest) => JobKickResult

/** CC-1183: bounds a kicked seat name before anything reads the disk for it. */
export const MAX_SEAT_NAME = 64

const isJobKickName = (value: unknown): value is JobKickName =>
  typeof value === 'string' && (JOB_KICK_NAMES as readonly string[]).includes(value)

/** The request built from `job` and `seat` alone; every other field on the frame is dropped. A string is a refusal. */
export function jobKickRequest(frame: { job?: unknown; seat?: unknown }): JobKickRequest | string {
  const { job, seat } = frame
  if (!isJobKickName(job)) return `unknown job "${String(job)}"; one of ${JOB_KICK_NAMES.join(', ')}`
  if (job !== 'seats_heartbeat_check')
    return seat === undefined ? { job } : `${job} takes no seat; the broker runs its defaults`
  if (typeof seat === 'string' && seat.length > MAX_SEAT_NAME)
    return `seats_heartbeat_check seat names are at most ${MAX_SEAT_NAME} characters`
  if (typeof seat !== 'string' || !isSeatName(seat))
    return `seats_heartbeat_check needs a seat name, got "${String(seat)}"`
  return { job, seat }
}

/** The command each job's unit runs, minus `--root`: the broker's own env picks the root. */
export function jobKickCommand(request: JobKickRequest, source: NodeJS.ProcessEnv): JobCommand {
  if (request.job === 'burndown_tick') return kickCommand(source)
  const args =
    request.job === 'seats_watchdog'
      ? [cliEntry(), 'seats', 'watchdog']
      : [cliEntry(), 'seats', 'heartbeat-check', '--seat', request.seat]
  return { command: process.execPath, args, env: kickEnv(source) }
}

export interface JobKickPorts {
  /** The burndown kicker's `request`, so a hand kick shares its ledger-lock and no-overlap rules. */
  requestTick: () => string
  /** Starts one detached seat job and calls `done` when it ends; must not wait for it. */
  launch: (request: JobKickRequest, done: () => void) => void
  log: (event: string, detail: Record<string, unknown>) => void
  /** CC-1183: whether the seat has a seat file, so heartbeat launches stay bounded by the seat book. */
  knownSeat: (seat: string) => boolean
}

const flightKey = (request: JobKickRequest): string =>
  request.job === 'seats_heartbeat_check' ? `${request.job}:${request.seat}` : request.job

/** Single flight per job and seat: a kick while that job runs coalesces into the run. */
export function jobKicker(ports: JobKickPorts): JobKick {
  const running = new Set<string>()
  const start = (request: JobKickRequest): string => {
    if (request.job === 'burndown_tick') return ports.requestTick()
    const key = flightKey(request)
    if (running.has(key)) return 'coalesced: already running'
    running.add(key)
    ports.launch(request, () => running.delete(key))
    return 'launched'
  }
  return request => {
    if (request.job === 'seats_heartbeat_check' && !ports.knownSeat(request.seat))
      return { ok: false, detail: `no seat file for "${request.seat}" in the broker's autonomy root` }
    const detail = start(request)
    ports.log('job_kick', { ...request, detail })
    return { ok: true, detail }
  }
}

/** Whether `root` holds a seat file for `seat`; `root` is resolved per kick so a config edit needs no restart. */
export const seatInBook =
  (root: () => string) =>
  (seat: string): boolean =>
    readSeatFile(root(), seat) !== undefined

/** The broker's port. Without a kicker (an ephemeral home) a kick is recorded and nothing is launched. */
export function brokerJobKick(
  kicker: Kicker | undefined,
  autonomyRoot: () => string = () => currentAutonomyRoot(),
): JobKick {
  if (kicker === undefined) {
    return request => {
      const detail = 'accepted (ephemeral home: not launched)'
      logEvent('job_kick', { ...request, detail })
      return { ok: true, detail }
    }
  }
  return jobKicker({
    requestTick: kicker.request,
    launch: (request, done) =>
      launchDetached(jobKickCommand(request, process.env), 'job-kick.log', 'job_kick_failed', done),
    log: logEvent,
    knownSeat: seatInBook(autonomyRoot),
  })
}
