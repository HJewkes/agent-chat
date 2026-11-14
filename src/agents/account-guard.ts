import path from 'node:path'
import type { AccountUsage } from './account-budget.js'
import { chooseAccount, LEAST_USED } from './account-request.js'
import type { RotationConfig } from './account-rotation.js'
import { accountName } from './config-dir.js'

/**
 * CC-894: a seat whose seat file declares `account: least-used` runs on the least-used account
 * without anyone moving it. Each watchdog tick decides, per seat, from readings and a clock alone:
 * an idle seat whose account is at the five_hour ceiling or at 90% seven_day moves to the least-used
 * account when that one has 15 points more seven_day headroom. Being exhausted is not required.
 */

export const GUARD_DWELL_MS = 60 * 60_000
export const SEVEN_DAY_TRIP_PCT = 90
export const HEADROOM_MARGIN_PCT = 15
/** A seat with activity more recent than this may be mid-turn, and a move would end it. */
export const GUARD_IDLE_MS = 5 * 60_000

const WINDOW_MS = { five_hour: 5 * 3_600_000, seven_day: 7 * 24 * 3_600_000 } as const

export interface GuardSeat {
  name: string
  /** The config dir the seat's live session runs on. */
  configDir: string
  declares: boolean
  live: boolean
  idleMs: number
}

export interface GuardSeatState {
  lastMoveAt?: number
  /** Config dir -> epoch ms: an account the seat left stays off limits until the reset that tripped the move. */
  blocked: Record<string, number>
  /** The episode the owner was last told about, so one episode raises one notice. */
  noticed?: string
}

export interface GuardState {
  seats: Record<string, GuardSeatState>
}

export const emptyGuardState = (): GuardState => ({ seats: {} })

export interface GuardInput {
  seat: GuardSeat
  usages: readonly AccountUsage[]
  config: RotationConfig
  state: GuardState
  now: number
  identify?: (configDir: string) => string | undefined
}

export type GuardDecision =
  | { kind: 'none'; name: string; reason: string }
  | { kind: 'hold'; name: string; reason: string }
  | { kind: 'move'; name: string; from: string; to: string; blockedUntil: number; reason: string }
  | { kind: 'notice'; name: string; episode: string; text: string }

interface Trip {
  window: keyof typeof WINDOW_MS
  pct: number
  blockedUntil: number
}

const sameDir = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b)

function tripOf(usage: AccountUsage, config: RotationConfig, now: number): Trip | undefined {
  const trip = (window: Trip['window'], w: NonNullable<AccountUsage['five_hour']>): Trip => ({
    window,
    pct: Math.round(w.used_pct),
    blockedUntil: w.resets_at === undefined ? now + WINDOW_MS[window] : w.resets_at * 1000,
  })
  if (usage.five_hour !== null && usage.five_hour.used_pct >= config.ceilingPct)
    return trip('five_hour', usage.five_hour)
  if (usage.seven_day !== null && usage.seven_day.used_pct >= SEVEN_DAY_TRIP_PCT)
    return trip('seven_day', usage.seven_day)
  return undefined
}

/** Why the seat is left alone before any reading is weighed; undefined when it is a candidate. */
function ineligible({ seat }: GuardInput): string | undefined {
  if (!seat.declares) return 'does not declare account: least-used'
  if (!seat.live) return 'not live'
  if (seat.idleMs < GUARD_IDLE_MS) return `busy (active ${Math.round(seat.idleMs / 1000)}s ago)`
  return undefined
}

function refusesFor(input: GuardInput): (dir: string) => boolean {
  const { seat, state, now, identify } = input
  const blocked = state.seats[seat.name]?.blocked ?? {}
  const login = identify?.(seat.configDir)
  return dir =>
    sameDir(dir, seat.configDir) ||
    (login !== undefined && identify?.(dir) === login) ||
    Object.entries(blocked).some(([from, until]) => now < until && sameDir(from, dir))
}

const sevenDayOf = (usages: readonly AccountUsage[], dir: string): number | undefined =>
  usages.find(u => sameDir(u.config_dir, dir))?.seven_day?.used_pct

/** The least-used account other than the seat's own, if it clears the headroom margin. */
function targetFor(input: GuardInput, currentSevenDay: number): { dir?: string; text: string } {
  const choice = chooseAccount(input.usages, input.config, {
    account: LEAST_USED,
    refuses: refusesFor(input),
    ...(input.identify === undefined ? {} : { identify: input.identify }),
  })
  if (!choice.ok) return { text: choice.text }
  const target = sevenDayOf(input.usages, choice.dir) ?? 100
  if (currentSevenDay - target >= HEADROOM_MARGIN_PCT) return { dir: choice.dir, text: choice.text }
  return { text: `${choice.text}; under ${HEADROOM_MARGIN_PCT} points more seven_day headroom` }
}

function noticeOrNone(input: GuardInput, trip: Trip, text: string): GuardDecision {
  const { seat, state } = input
  const from = accountName(seat.configDir)
  const episode = `${from}:${trip.window}:${trip.blockedUntil}`
  if (state.seats[seat.name]?.noticed === episode)
    return { kind: 'none', name: seat.name, reason: 'no target; owner already told' }
  return {
    kind: 'notice',
    name: seat.name,
    episode,
    text:
      `${seat.name} is at ${trip.window} ${trip.pct}% on ${from} and no account has ` +
      `${HEADROOM_MARGIN_PCT} points more seven_day headroom: ${text}`,
  }
}

export function guardDecision(input: GuardInput): GuardDecision {
  const { seat, usages, config, state, now } = input
  const skip = ineligible(input)
  if (skip !== undefined) return { kind: 'none', name: seat.name, reason: skip }
  const current = usages.find(u => sameDir(u.config_dir, seat.configDir))
  if (current === undefined || current.stale || current.seven_day === null)
    return { kind: 'none', name: seat.name, reason: `no fresh reading for ${accountName(seat.configDir)}` }
  const trip = tripOf(current, config, now)
  if (trip === undefined) return { kind: 'none', name: seat.name, reason: 'under threshold' }
  const last = state.seats[seat.name]?.lastMoveAt
  if (last !== undefined && now - last < GUARD_DWELL_MS)
    return {
      kind: 'hold',
      name: seat.name,
      reason: `dwell: moved ${Math.round((now - last) / 60_000)} min ago`,
    }
  const target = targetFor(input, current.seven_day.used_pct)
  if (target.dir === undefined) return noticeOrNone(input, trip, target.text)
  return {
    kind: 'move',
    name: seat.name,
    from: seat.configDir,
    to: target.dir,
    blockedUntil: trip.blockedUntil,
    reason: `${trip.window} ${trip.pct}% on ${accountName(seat.configDir)}; ${target.text}`,
  }
}

const unexpired = (blocked: Record<string, number>, now: number): Record<string, number> =>
  Object.fromEntries(Object.entries(blocked).filter(([, until]) => now < until))

/** The state after `decision` was carried out; a dry run never calls this. */
export function nextGuardState(state: GuardState, decision: GuardDecision, now: number): GuardState {
  const prior = state.seats[decision.name]
  if (decision.kind === 'move') {
    const blocked = { ...unexpired(prior?.blocked ?? {}, now), [decision.from]: decision.blockedUntil }
    return { seats: { ...state.seats, [decision.name]: { lastMoveAt: now, blocked } } }
  }
  if (decision.kind === 'notice') {
    const base = prior ?? { blocked: {} }
    return { seats: { ...state.seats, [decision.name]: { ...base, noticed: decision.episode } } }
  }
  return state
}
