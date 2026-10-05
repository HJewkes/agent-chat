import type { Presence } from './liveness.js'

/**
 * Seat relaunch (CC-437): a charter seat with no live session and no log line for
 * 15 minutes is relaunched, unless a hold, a teleport in progress or a recent launch
 * stops it. Pure: the run reads the presence, journal, holds and marks and passes them in.
 */

/** A seat whose newest own log line is younger than this is never relaunched. */
export const RELAUNCH_QUIET_MS = 15 * 60_000

/** A seat launched by anyone within this is never relaunched. */
export const RELAUNCH_DEDUPE_MS = 15 * 60_000

/** A handoff with no register after it holds the seat this long; after that the teleport has failed. */
export const HANDOFF_GRACE_MS = 15 * 60_000

/** Failed relaunches per dark stretch; a register ends the stretch. */
export const RELAUNCH_TRY_CAP = 8

export interface RelaunchInput {
  connected: boolean
  /** Undefined when events.db could not be read, which never relaunches. */
  presence: Presence | undefined
  /** Epoch ms of the seat's newest own log line; undefined when it has none. */
  activityAt: number | undefined
  /** An owner stop, restart window, machine stop, the seat's own stop line or an unreadable journal. */
  hold: string | undefined
  /** `SeatRecord.relaunchedAt`. */
  relaunchedAt: number | undefined
  /** `SeatRecord.relaunchTries`. */
  relaunchTries: number | undefined
  nowMs: number
}

export interface RelaunchVerdict {
  relaunch: boolean
  reason: string
  /** Which relaunch of this dark stretch this is, to save as `relaunchTries`. */
  tries?: number
  /** A hold or the cap kept a stale seat dark; the run says so. */
  refused?: true
}

const skip = (reason: string): RelaunchVerdict => ({ relaunch: false, reason })

const refuse = (reason: string): RelaunchVerdict => ({ relaunch: false, reason, refused: true })

const minutesSince = (at: number, nowMs: number): number => Math.floor((nowMs - at) / 60_000)

const hhmmZ = (at: number): string => `${new Date(at).toISOString().slice(11, 16)}Z`

/** Relaunches since the seat last registered; a register after the last relaunch starts a new stretch. */
function failedTries(input: RelaunchInput, presence: Presence): number {
  const { relaunchedAt, relaunchTries } = input
  if (relaunchedAt === undefined) return 0
  const registered = presence.registeredAt
  return registered !== undefined && registered >= relaunchedAt ? 0 : (relaunchTries ?? 0)
}

/** The newest launch of the seat by the watchdog's own mark or by events.db. */
function lastLaunch(input: RelaunchInput, presence: Presence): number | undefined {
  const marks = [input.relaunchedAt, presence.lastLaunchAt].filter((at): at is number => at !== undefined)
  return marks.length === 0 ? undefined : Math.max(...marks)
}

/** Why a stale, unconnected seat is left alone, or undefined to relaunch it. */
function relaunchStop(input: RelaunchInput, presence: Presence, failed: number): RelaunchVerdict | undefined {
  const { nowMs } = input
  if (input.hold !== undefined) return refuse(`not relaunched: ${input.hold}`)
  const { handoffAt } = presence
  if (handoffAt !== undefined && nowMs - handoffAt < HANDOFF_GRACE_MS)
    return skip(`teleport in progress: handoff at ${hhmmZ(handoffAt)} and no register since`)
  const launched = lastLaunch(input, presence)
  if (launched !== undefined && nowMs - launched < RELAUNCH_DEDUPE_MS)
    return skip(`launched ${minutesSince(launched, nowMs)} min ago, under 15`)
  if (failed >= RELAUNCH_TRY_CAP)
    return refuse(`not relaunched: ${failed} relaunches failed this dark stretch`)
  return undefined
}

function quiet(activityAt: number | undefined, nowMs: number): string {
  return activityAt === undefined ? 'no log line' : `no log line for ${minutesSince(activityAt, nowMs)} min`
}

export function judgeRelaunch(input: RelaunchInput): RelaunchVerdict {
  const { presence, activityAt, nowMs } = input
  if (input.connected) return skip('connected')
  if (presence === undefined) return skip('presence unreadable')
  if (activityAt !== undefined && nowMs - activityAt < RELAUNCH_QUIET_MS)
    return skip(`last log line ${minutesSince(activityAt, nowMs)} min ago, under 15`)
  const failed = failedTries(input, presence)
  const stop = relaunchStop(input, presence, failed)
  if (stop !== undefined) return stop
  const retry = failed === 0 ? '' : `, try ${failed + 1} of ${RELAUNCH_TRY_CAP}`
  return {
    relaunch: true,
    reason: `${quiet(activityAt, nowMs)} and no live session${retry}`,
    tries: failed + 1,
  }
}
