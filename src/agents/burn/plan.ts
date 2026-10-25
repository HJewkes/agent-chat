/**
 * CC-1647 S1: the week-end burn planner. Pure: readings, config and a clock in, a plan out.
 *
 * Every pick elsewhere ranks accounts by least used or by a fixed order, which in the last day
 * before a reset picks the wrong account. The ranking here is earliest deadline first: the
 * account whose headroom expires soonest is billed first. Which accounts may burn, and how far
 * each may be burned, are inputs, never constants. Times are epoch milliseconds only.
 */

const HOUR_MS = 3_600_000
const WEEK_MS = 7 * 24 * HOUR_MS
const WINDOW_HOURS = 5

export type BurnState = 'burn' | 'watch' | 'done' | 'excluded' | 'stale' | 'exhausted'

export interface BurnReading {
  account: string
  configDir: string
  sevenDay: number
  fiveHour: number
  /** Epoch ms at which the seven_day window resets. */
  resetsAt: number
  /** False when the reading is too old to decide on. */
  fresh: boolean
  /** A usage-limit failure was seen; the account is out until its five_hour reset. */
  exhausted?: boolean
}

export interface BurnConfig {
  /** Accounts that may be burned. Any other account is `excluded`. */
  allowed: readonly string[]
  /** Seven_day percentage to burn up to, per account. */
  lines: Readonly<Record<string, number>>
  /** The line for an allowed account missing from `lines`. */
  defaultLine: number
  horizonHours: number
  marginHours: number
  /** Seven_day points one five_hour window can spend. */
  ptsPerWindow: number
  /** Seven_day points one agent spends per hour. */
  agentRate: number
  /** A five_hour at or over this sends the account to the back of the order. */
  fiveHourCeiling: number
  /** The most agents the machine allows; caps `targetAgents`. */
  maxAgents: number
}

export interface BurnAccount {
  configDir: string
  sevenDay: number
  fiveHour: number
  resetsAt: number
  state: BurnState
  expiringPts: number
  startBy: number
  feasible: boolean
  targetAgents: number
}

export interface BurnHour {
  hourStartUtc: number
  burnAccount: string | null
  /** The burn account cannot spend its expiring points before its reset. */
  overflow: boolean
}

export interface BurnPlan {
  order: string[]
  accounts: Record<string, BurnAccount>
  timeline: BurnHour[]
}

const expiringOf = (r: BurnReading, line: number): number => Math.max(0, line - r.sevenDay)

function baseState(
  r: BurnReading,
  cfg: BurnConfig,
  expiringPts: number,
  now: number,
  startBy: number,
): BurnState {
  if (!cfg.allowed.includes(r.account)) return 'excluded'
  if (!r.fresh) return 'stale'
  if (r.exhausted) return 'exhausted'
  if (expiringPts <= 0) return 'done'
  return now >= Math.min(r.resetsAt - cfg.horizonHours * HOUR_MS, startBy) ? 'burn' : 'watch'
}

function describe(r: BurnReading, cfg: BurnConfig, now: number): BurnAccount {
  const line = cfg.lines[r.account] ?? cfg.defaultLine
  const expiringPts = expiringOf(r, line)
  const hoursNeeded = expiringPts / (cfg.ptsPerWindow / WINDOW_HOURS)
  const startBy = r.resetsAt - hoursNeeded * HOUR_MS - cfg.marginHours * HOUR_MS
  return {
    configDir: r.configDir,
    sevenDay: r.sevenDay,
    fiveHour: r.fiveHour,
    resetsAt: r.resetsAt,
    state: baseState(r, cfg, expiringPts, now, startBy),
    expiringPts,
    startBy,
    feasible: startBy >= now,
    targetAgents: 0,
  }
}

/** A window that opened within the horizon is fresh capacity; an older window still burning goes first. */
function excludeFreshWindows(accounts: Record<string, BurnAccount>, cfg: BurnConfig, now: number): void {
  const burning = Object.values(accounts).filter(a => a.state === 'burn')
  for (const a of Object.values(accounts)) {
    if (a.state !== 'burn' && a.state !== 'watch') continue
    const openedAgo = now - (a.resetsAt - WEEK_MS)
    const olderBurning = burning.some(o => o.resetsAt < a.resetsAt)
    if (openedAgo < cfg.horizonHours * HOUR_MS && olderBurning) a.state = 'excluded'
  }
}

function setTargets(accounts: Record<string, BurnAccount>, cfg: BurnConfig, now: number): void {
  for (const a of Object.values(accounts)) {
    const hoursLeft = (a.resetsAt - now) / HOUR_MS
    if (a.state !== 'burn' || hoursLeft <= 0) continue
    a.targetAgents = Math.min(cfg.maxAgents, Math.ceil(a.expiringPts / (hoursLeft * cfg.agentRate)))
  }
}

const GROUP: Record<BurnState, number> = { burn: 0, watch: 1, done: 2, excluded: 2, stale: 2, exhausted: 2 }

function rank(accounts: Record<string, BurnAccount>, cfg: BurnConfig): string[] {
  const names = Object.keys(accounts)
  const full = (n: string): boolean => accounts[n]!.fiveHour >= cfg.fiveHourCeiling
  const cmp = (x: string, y: string): number => {
    const a = accounts[x]!
    const b = accounts[y]!
    if (full(x) !== full(y)) return full(x) ? 1 : -1
    if (GROUP[a.state] !== GROUP[b.state]) return GROUP[a.state] - GROUP[b.state]
    if (GROUP[a.state] < 2)
      return a.resetsAt - b.resetsAt || b.expiringPts - a.expiringPts || x.localeCompare(y)
    return a.sevenDay - b.sevenDay || x.localeCompare(y)
  }
  return names.sort(cmp)
}

function timelineOf(order: string[], accounts: Record<string, BurnAccount>, now: number): BurnHour[] {
  const last = Math.max(0, ...order.map(n => accounts[n]!.resetsAt))
  const hours: BurnHour[] = []
  for (let h = Math.floor(now / HOUR_MS) * HOUR_MS; h < last; h += HOUR_MS) {
    const name = order.find(n => accounts[n]!.state === 'burn' && h < accounts[n]!.resetsAt)
    hours.push({
      hourStartUtc: h,
      burnAccount: name ?? null,
      overflow: name ? !accounts[name]!.feasible : false,
    })
  }
  return hours
}

export function burnPlan(readings: readonly BurnReading[], cfg: BurnConfig, nowMs: number): BurnPlan {
  const accounts: Record<string, BurnAccount> = {}
  for (const r of readings) accounts[r.account] = describe(r, cfg, nowMs)
  excludeFreshWindows(accounts, cfg, nowMs)
  setTargets(accounts, cfg, nowMs)
  const order = rank(accounts, cfg)
  return { order, accounts, timeline: timelineOf(order, accounts, nowMs) }
}
