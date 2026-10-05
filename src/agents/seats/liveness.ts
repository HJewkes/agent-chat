import { charterSeats, isSeatName } from './charter.js'

/**
 * Seat liveness (CC-320): a charter seat that deregistered with no teleport and
 * stayed dark is resumed once, unless a stop holds it (CC-326). Pure: the run reads
 * the presence and passes it in.
 */

/** A seat that registers again within this is never resumed. */
export const DARK_AFTER_MS = 5 * 60_000

/** A seat dark for longer than this is never resumed (CC-326). */
export const JOURNAL_LOOKBACK_DAYS = 7

/** Resume attempts per dark episode (CC-326): a refusal, or a run that died mid-call, earns the next one. */
export const RESUME_TRY_CAP = 8

export const RESUME_MESSAGE =
  'Watchdog: your session deregistered with no teleport, so you were resumed. ' +
  'Messages sent while you were dark were held and follow this one.'

/** What events.db says about a seat's latest session. */
export interface Presence {
  /** Epoch ms of the `deregistered` row the seat has not registered since. */
  darkSince?: number
  /** CC-326: log id of the seat's last `registered` row when no `deregistered` row closed it. */
  openRegister?: number
  /** A stand-down row since the seat's last register: it left by teleport. A handoff alone may have been aborted. */
  teleported: boolean
  /** The watchdog started the seat's latest session, so that session ending is not a death. */
  wokenByWatchdog: boolean
  /** CC-326: an `agent_resumed` row since the seat's last presence row whose launch did not throw, so a resume already started. */
  resumeStarted: boolean
  /** CC-463: epoch ms of the seat's last `registered` row. */
  registeredAt?: number
  /** CC-463: epoch ms of the newest `agent_resumed` or launching `agent_spawned` row targeting the seat. */
  lastLaunchAt?: number
  /** CC-463: epoch ms of the seat's newest `agent_handoff` row when no register followed it. */
  handoffAt?: number
}

export interface LivenessInput {
  connected: boolean
  /** Undefined when events.db could not be read, which never resumes. */
  presence: Presence | undefined
  /** Why the watchdog must leave the seat alone: an owner stop, a restart window, its own stop line or a closed budget. */
  hold: string | undefined
  /** When the watchdog first saw the seat absent with `openRegister` as its last row. */
  absentSince: number | undefined
  /** The start of the dark episode the watchdog last tried to resume. */
  attempted: number | undefined
  /** Tries at that episode whose resume is unconfirmed; undefined once one was accepted. */
  unconfirmed: number | undefined
  nowMs: number
}

export interface LivenessVerdict {
  resume: boolean
  reason: string
  /** The start of the dark episode being resumed, and which try this is. */
  episode?: number
  tries?: number
  /** A stop kept a dark seat from being resumed; the run says so once. */
  refused?: true
  /** Why the idle wake must leave the seat alone too. */
  idleHold?: string
}

const skip = (reason: string): LivenessVerdict => ({ resume: false, reason })

const hhmmZ = (at: number): string => `${new Date(at).toISOString().slice(11, 16)}Z`

/** A closed episode starts at its `deregistered` row; an unclosed register, when the watchdog first saw the seat absent. */
function darkStart({ presence, absentSince }: LivenessInput): number | undefined {
  if (presence?.darkSince !== undefined) return presence.darkSince
  return presence?.openRegister === undefined ? undefined : absentSince
}

function describeDark(presence: Presence, since: number, nowMs: number): string {
  const minutes = Math.floor((nowMs - since) / 60_000)
  return presence.darkSince === undefined
    ? `absent ${minutes} min since first seen at ${hhmmZ(since)} with no deregistered row`
    : `dark ${minutes} min since ${hhmmZ(since)} with no teleport`
}

/** Why a seat that would otherwise be resumed is left dark. */
function resumeStop(input: LivenessInput, since: number, failed: number): string | undefined {
  if (failed >= RESUME_TRY_CAP) return `${failed} resume attempts failed this dark episode`
  if (input.nowMs - since > JOURNAL_LOOKBACK_DAYS * 86_400_000)
    return `dark longer than the ${JOURNAL_LOOKBACK_DAYS}-day journal look-back`
  return input.hold
}

/** The verdict for a seat dark over five minutes with no teleport. */
function judgeDark(input: LivenessInput, presence: Presence, since: number): LivenessVerdict {
  const sameEpisode = input.attempted === since
  const once = 'dark episode already resumed once'
  if (presence.resumeStarted)
    return { ...skip('a resume of it already started this dark episode'), idleHold: once }
  if (sameEpisode && input.unconfirmed === undefined)
    return { ...skip('already resumed once this dark episode'), idleHold: once }
  if (presence.wokenByWatchdog) return skip('its last session was a watchdog wake, which ends on its own')
  const failed = sameEpisode ? (input.unconfirmed ?? 0) : 0
  const dark = describeDark(presence, since, input.nowMs)
  const stop = resumeStop(input, since, failed)
  if (stop !== undefined) {
    const reason = `${dark}; not resumed: ${stop}`
    return { resume: false, reason, refused: true, idleHold: reason }
  }
  const retry = failed === 0 ? '' : `, try ${failed + 1} of ${RESUME_TRY_CAP} after a failed resume`
  return { resume: true, reason: `${dark}${retry}`, episode: since, tries: failed + 1, idleHold: once }
}

export function judgeLiveness(input: LivenessInput): LivenessVerdict {
  const { presence, nowMs } = input
  if (input.connected) return skip('connected')
  if (presence === undefined) return { ...skip('presence unreadable'), idleHold: 'presence unreadable' }
  const since = darkStart(input)
  if (since === undefined) return skip('no deregistered row since its last register')
  if (presence.teleported) return skip('teleported since its last register')
  const minutes = Math.floor((nowMs - since) / 60_000)
  if (nowMs - since <= DARK_AFTER_MS) return skip(`dark ${minutes} min, not yet over 5`)
  return judgeDark(input, presence, since)
}

/** The seats the liveness check and the broker's hold act on: charter seats the owner has not stopped. */
export const watchedSeats = (charter: string, stopped: Record<string, string>): string[] =>
  charterSeats(charter).filter(name => isSeatName(name) && stopped[name] === undefined)
