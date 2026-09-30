import { charterSeats, isSeatName } from './charter.js'

/**
 * Seat liveness (CC-320): a charter seat that deregistered with no teleport and
 * stayed dark is resumed once. Pure: the run reads the presence and passes it in.
 */

/** A seat that registers again within this is never resumed. */
export const DARK_AFTER_MS = 5 * 60_000

export const RESUME_MESSAGE =
  'Watchdog: your session deregistered with no teleport, so you were resumed. ' +
  'Messages sent while you were dark were held and follow this one.'

/** What events.db says about a seat's latest session. */
export interface Presence {
  /** Epoch ms of the `deregistered` row the seat has not registered since. */
  darkSince?: number
  /** A handoff or stand-down row since the seat's last register: it left by teleport. */
  teleported: boolean
  /** The watchdog started the seat's latest session, so that session ending is not a death. */
  wokenByWatchdog: boolean
}

export interface LivenessInput {
  connected: boolean
  /** Undefined when events.db could not be read, which never resumes. */
  presence: Presence | undefined
  /** Why the watchdog must leave the seat alone: an owner stop, a restart window or its own pause line. */
  hold: string | undefined
  /** `darkSince` of the episode the watchdog last tried to resume. */
  attempted: number | undefined
  nowMs: number
}

export interface LivenessVerdict {
  resume: boolean
  reason: string
}

const skip = (reason: string): LivenessVerdict => ({ resume: false, reason })

const hhmmZ = (at: number): string => `${new Date(at).toISOString().slice(11, 16)}Z`

export function judgeLiveness(input: LivenessInput): LivenessVerdict {
  const { presence, nowMs } = input
  if (input.connected) return skip('connected')
  if (presence === undefined) return skip('presence unreadable')
  if (presence.darkSince === undefined) return skip('no deregistered row since its last register')
  if (presence.teleported) return skip('teleported since its last register')
  const minutes = Math.floor((nowMs - presence.darkSince) / 60_000)
  if (nowMs - presence.darkSince <= DARK_AFTER_MS) return skip(`dark ${minutes} min, not yet over 5`)
  if (input.attempted === presence.darkSince) return skip('already resumed once this dark episode')
  if (presence.wokenByWatchdog) return skip('its last session was a watchdog wake, which ends on its own')
  if (input.hold !== undefined) return skip(`held: ${input.hold}`)
  return { resume: true, reason: `dark ${minutes} min since ${hhmmZ(presence.darkSince)} with no teleport` }
}

/** The seats the liveness check and the broker's hold act on: charter seats the owner has not stopped. */
export const watchedSeats = (charter: string, stopped: Record<string, string>): string[] =>
  charterSeats(charter).filter(name => isSeatName(name) && stopped[name] === undefined)
