/**
 * Whether the tick may spend on an account right now (design section 7).
 *
 * The reserve is what keeps the human's own sessions, which share these
 * accounts, from hitting a weekly limit the loop used up. Every unknown is
 * read as the human being present and the account being full: a missing rule,
 * a missing reading and a missing presence signal all close the gate or keep
 * the stricter numbers, never the looser ones.
 */

/** CC-801: a charter pool as `gateAccount` reads it, keyed by pool name; unset `human_uses` reads as true, as the charter's does. */
export type AccountRule = Omit<PoolRule, 'name' | 'human_uses'> & { human_uses?: boolean | undefined }

export interface AccountReading {
  sevenDay?: number
  fiveHour?: number
  ageSeconds: number
  /** Epoch ms the seven_day window resets, from the same status file; it dates the declining reserve. */
  sevenDayResetsAt?: number
}

/** A reading that holds both windows. */
export type FullReading = Required<Omit<AccountReading, 'sevenDayResetsAt'>> & AccountReading

export interface GateContext {
  now: Date
  /** Epoch ms of the last human-typed turn on the account; absent means assume the human is here. */
  humanLastTurnAt?: number
}

export type GateResult =
  | { open: true; account: string; headroom: number; sonnetOnly: boolean; reason: string }
  | { open: false; account: string; reason: string }

const PRESENT_WITHIN_MS = 15 * 60_000
const PRESENT_CEILING = 70
const SONNET_ONLY_ABOVE = 85
/** Both gates use the freshest status file; an older one may hide spend since. */
export const MAX_READING_AGE_SECONDS = 15 * 60

const humanAbsentFor = (ctx: GateContext, ms: number): boolean =>
  ctx.humanLastTurnAt !== undefined && ctx.now.getTime() - ctx.humanLastTurnAt >= ms

const DAY_MS = 24 * 3_600_000
const WINDOW_DAYS = 7
/** CC-474: on these days of a pool's seven_day window the seat per_run and per_day caps are lifted. */
const CAPS_LIFTED_FROM_DAY = 6

export interface SevenDayLine {
  /** 100 - R, R = reserve * (8 - d) / 7, to two decimals. */
  line: number
  /** Day 1 to 7 of the window; undefined when the reset is unknown and the flat reserve stands. */
  day: number | undefined
  capsLifted: boolean
  note: string
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/** CC-474: the reserve declines over the window; a missing or passed reset keeps the flat reserve. */
export function sevenDayLine(reserve: number, resetsAt: number | undefined, nowMs: number): SevenDayLine {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= nowMs)
    return {
      line: 100 - reserve,
      day: undefined,
      capsLifted: false,
      note: 'no seven_day resets_at, flat reserve',
    }
  const start = resetsAt - WINDOW_DAYS * DAY_MS
  const day = Math.min(WINDOW_DAYS, Math.max(1, Math.floor((nowMs - start) / DAY_MS) + 1))
  const capsLifted = day >= CAPS_LIFTED_FROM_DAY
  const note = `day ${day} of ${WINDOW_DAYS}${capsLifted ? ', seat caps lifted' : ''}`
  return { line: round2(100 - (reserve * (WINDOW_DAYS + 1 - day)) / WINDOW_DAYS), day, capsLifted, note }
}

/** An unusable age closes the gate; only an explicit infinite limit skips the check. */
function staleReason(age: number, max: number): string | undefined {
  if (max === Number.POSITIVE_INFINITY) return undefined
  if (!Number.isFinite(age)) return 'reading has no age'
  return age > max ? `reading is ${age}s old, over the ${max}s limit` : undefined
}

export function gateAccount(
  account: string,
  rule: AccountRule | undefined,
  reading: AccountReading | undefined,
  ctx: GateContext,
  { maxReadingAgeSeconds = MAX_READING_AGE_SECONDS }: { maxReadingAgeSeconds?: number } = {},
): GateResult {
  const pool = priced(rule)
  if (pool === undefined) return { open: false, account, reason: `pool ${account}: ${NO_POOL_STOPS}` }
  if (reading?.sevenDay === undefined || reading.fiveHour === undefined)
    return { open: false, account, reason: 'no seven_day and five_hour reading under this account' }
  const stale = staleReason(reading.ageSeconds, maxReadingAgeSeconds)
  if (stale !== undefined) return { open: false, account, reason: stale }

  const { line, note, ceiling } = poolLines(pool, reading.sevenDayResetsAt, ctx)
  const { sevenDay, fiveHour } = reading
  const figures = `seven_day ${sevenDay}% vs line ${line}% (${note}), five_hour ${fiveHour}% vs ceiling ${ceiling}%`

  if (sevenDay >= line) return { open: false, account, reason: `inside the reserve: ${figures}` }
  if (fiveHour >= ceiling) return { open: false, account, reason: `over the five-hour ceiling: ${figures}` }
  return {
    open: true,
    account,
    headroom: line - sevenDay,
    sonnetOnly: sevenDay > SONNET_ONLY_ABOVE,
    reason: figures,
  }
}

/** One billing pool from the autonomy charter's `pools:`; a missing stop closes the pool's gate. */
export interface PoolRule {
  name: string
  human_uses: boolean
  reserve_seven_day?: number | undefined
  ceiling_five_hour?: number | undefined
  /** CC-474: still accepted from old charters, never read; the declining reserve replaced it. */
  night_reserve_seven_day?: number | undefined
  per_day_points?: number | undefined
  /** What one dispatch is expected to spend, charged before the next gate in the same tick. */
  dispatch_seven_day_points?: number | undefined
  dispatch_five_hour_points?: number | undefined
  /** CC-843: points below a stop where only sonnet may spawn; unset is 10, 0 lifts the band. */
  sonnet_band_points?: number | undefined
}

export const DEFAULT_SONNET_BAND_POINTS = 10

/** The sonnet-only band width the pool's gate applies. */
export const sonnetBand = (pool: PoolRule): number => pool.sonnet_band_points ?? DEFAULT_SONNET_BAND_POINTS

/** The charge for a pool that prices no dispatch; the charter should set its own. */
export const DEFAULT_DISPATCH_COST = { sevenDay: 2, fiveHour: 10 }

/** How many of this tick's charged spawns, listed by pool name, bill `pool`. */
export const chargesOn = (pool: string, charged: readonly string[]): number =>
  charged.filter(p => p === pool).length

/** The seat file's `spend:` caps, in seven_day points; an absent cap never stops. */
export interface SpendCaps {
  per_run_points?: number | undefined
  per_day_points?: number | undefined
  /** How a stop names `per_day_points` when it is not the seat file's own figure. */
  per_day_label?: string | undefined
}

export interface SevenDaySample {
  at: number
  sevenDay: number
  /** Epoch ms the seven_day window resets, from the status file; a sample after it starts a new window. */
  resetsAt?: number | undefined
}

export interface PoolGateInput {
  pool: PoolRule | undefined
  spend: SpendCaps
  reading: AccountReading | undefined
  /** Earlier seven_day readings of the pool, any order; the run-start reading must be among them. */
  history: readonly SevenDaySample[]
  /** Epoch ms of the owner's last message to the seat; a run is capped at 12 hours. */
  runStartAt: number
  ctx: GateContext
  /** Dispatches already planned on this pool this tick, by any seat; each is charged at the pool's dispatch cost. */
  dispatched?: number
  /** CC-409: the pool's last reading that held both windows, aged to now; stands in when `reading` lacks one. */
  lastGood?: AccountReading | undefined
}

export type PoolGateResult =
  | { open: true; pool: string; sonnetOnly: boolean; reason: string; staleOk?: true }
  | { open: false; pool: string; reason: string }

export const RUN_CAP_MS = 12 * 3_600_000
/** CC-409: a last good reading older than this never stands in for a missing one. */
export const LAST_GOOD_MAX_AGE_SECONDS = 60 * 60
const LAST_GOOD_SEVEN_DAY_MARGIN = 5
const LAST_GOOD_FIVE_HOUR_MARGIN = 10
const DAY_START_HOUR = 7

/** Charter section 4: a drop in seven_day, or a sample past the window's reset, counts from zero. */
export function pointsSpent(samples: readonly SevenDaySample[]): number {
  let spent = 0
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1] as SevenDaySample
    const b = samples[i] as SevenDaySample
    const reset = b.sevenDay < a.sevenDay || (a.resetsAt !== undefined && a.resetsAt <= b.at)
    spent += reset ? b.sevenDay : b.sevenDay - a.sevenDay
  }
  return spent
}

/** Spend since `start`, from the latest reading at or before it to `now`; undefined with no such reading. */
export function spendSince(
  history: readonly SevenDaySample[],
  start: number,
  now: SevenDaySample,
): number | undefined {
  const known = [...history].filter(s => s.at < now.at).sort((a, b) => a.at - b.at)
  const baseline = known.findLast(s => s.at <= start)
  if (baseline === undefined) return undefined
  return pointsSpent([...known.filter(s => s.at >= baseline.at), now])
}

/** The latest 07:00 local at or before `now`, where the charter's spend day starts. */
export function dayStart(now: Date): number {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), DAY_START_HOUR)
  if (start.getTime() > now.getTime()) start.setDate(start.getDate() - 1)
  return start.getTime()
}

/**
 * The run-start convention the watchdog and the tick share: a run starts at the later of the owner's
 * last message to the seat and the watchdog's recorded run start, and is at most 12 hours old.
 * The spend day starts at 07:00 local (`dayStart`).
 */
export function runStartAt(now: Date, starts: { ownerMessageAt?: number; recordedAt?: number } = {}): number {
  const known = [starts.ownerMessageAt, starts.recordedAt].filter((t): t is number => Number.isFinite(t))
  return Math.max(now.getTime() - RUN_CAP_MS, ...known)
}

interface WindowLines {
  ceiling: number
  line: number
  capsLifted: boolean
  note: string
}

type PricedRule = AccountRule & { reserve_seven_day: number; ceiling_five_hour: number }

const NO_POOL_STOPS = 'no reserve_seven_day and ceiling_five_hour for this pool in the charter'

/** The rule with both stops set, or undefined, which closes the gate. */
function priced<R extends AccountRule>(rule: R | undefined): (R & PricedRule) | undefined {
  const { reserve_seven_day, ceiling_five_hour } = rule ?? {}
  if (rule === undefined || reserve_seven_day === undefined || ceiling_five_hour === undefined)
    return undefined
  return { ...rule, reserve_seven_day, ceiling_five_hour }
}

/**
 * CC-801: the seven_day line and five_hour ceiling `gateAccount` and `gatePool` both judge a pool by.
 * The owner-typing ceiling applies only to a pool the owner uses, and never on days 6-7.
 */
export function poolLines(pool: PricedRule, resetsAt: number | undefined, ctx: GateContext): WindowLines {
  const seven = sevenDayLine(pool.reserve_seven_day, resetsAt, ctx.now.getTime())
  const present = pool.human_uses !== false && !humanAbsentFor(ctx, PRESENT_WITHIN_MS)
  const lowered = present && !seven.capsLifted && pool.ceiling_five_hour > PRESENT_CEILING
  return {
    ceiling: lowered ? PRESENT_CEILING : pool.ceiling_five_hour,
    line: seven.line,
    capsLifted: seven.capsLifted,
    note: [seven.note, lowered && 'owner typed in the last 15 min'].filter(Boolean).join(', '),
  }
}

function spendStop(input: PoolGateInput, now: SevenDaySample, capsLifted: boolean): string | undefined {
  const { pool, ctx, runStartAt } = input
  const spend = capsLifted ? {} : input.spend
  const runCap = spend.per_run_points
  if (runCap !== undefined) {
    const run = spendSince(input.history, Math.max(runStartAt, now.at - RUN_CAP_MS), now)
    if (run === undefined) return 'no seven_day reading at run start, so run spend is unknown'
    if (run >= runCap) return `run spend ${run} points at or above the seat's per_run_points ${runCap}`
  }
  const caps = [
    { cap: pool?.per_day_points, whose: `pool ${pool?.name ?? '?'}'s per_day_points` },
    { cap: spend.per_day_points, whose: spend.per_day_label ?? "seat's per_day_points" },
  ].filter((c): c is { cap: number; whose: string } => c.cap !== undefined)
  if (caps.length === 0) return undefined
  // seven_day points are pool-wide, so both caps count spend by the owner and sibling seats too.
  const day = spendSince(input.history, dayStart(ctx.now), now)
  if (day === undefined) return 'no seven_day reading at or before 07:00, so day spend unknown'
  const hit = caps.filter(c => day >= c.cap).sort((a, b) => a.cap - b.cap)[0]
  return hit === undefined
    ? undefined
    : `day spend ${day} points since 07:00 at or above the ${hit.whose} ${hit.cap}`
}

/** The reading plus this tick's charged dispatches, so seats sharing a pool cannot pass one gate together. */
function chargedReading(
  pool: PoolRule,
  reading: { sevenDay: number; fiveHour: number },
  dispatched: number,
): { sevenDay: number; fiveHour: number; note: string } {
  if (dispatched === 0) return { ...reading, note: '' }
  const sevenDay = dispatched * (pool.dispatch_seven_day_points ?? DEFAULT_DISPATCH_COST.sevenDay)
  const fiveHour = dispatched * (pool.dispatch_five_hour_points ?? DEFAULT_DISPATCH_COST.fiveHour)
  return {
    sevenDay: reading.sevenDay + sevenDay,
    fiveHour: reading.fiveHour + fiveHour,
    note: `; charged ${dispatched} dispatch(es) this tick at +${sevenDay} seven_day, +${fiveHour} five_hour`,
  }
}

/** Charter section 4's budget stops for one seat on its pool; a closed result's reason is the `BUDGET-PAUSE` line. */
export function gatePool(
  input: PoolGateInput,
  { maxReadingAgeSeconds = MAX_READING_AGE_SECONDS }: { maxReadingAgeSeconds?: number } = {},
): PoolGateResult {
  const { pool, reading, ctx } = input
  const name = pool?.name ?? 'unknown'
  const closed = (why: string): PoolGateResult => ({
    open: false,
    pool: name,
    reason: `BUDGET-PAUSE pool ${name}: ${why}`,
  })
  const stops = priced(pool)
  if (stops === undefined) return closed(NO_POOL_STOPS)
  const stale = reading === undefined ? undefined : staleReason(reading.ageSeconds, maxReadingAgeSeconds)
  if (stale !== undefined) return closed(stale)
  if (reading?.sevenDay === undefined || reading.fiveHour === undefined)
    return gateLastGood(input, stops, closed)
  return gateWindows(input, stops, { sevenDay: reading.sevenDay, fiveHour: reading.fiveHour }, closed)
}

type PricedPool = PoolRule & PricedRule

const windowLines = (pool: PricedPool, input: PoolGateInput): WindowLines =>
  poolLines(pool, input.reading?.sevenDayResetsAt, input.ctx)

const NO_READING = 'no seven_day and five_hour reading for this pool'

/** CC-409: every window the current reading has, with only a missing one taken from the last good reading. */
export function standInReading(
  reading: AccountReading | undefined,
  lastGood: AccountReading | undefined,
): FullReading | undefined {
  if (lastGood?.sevenDay === undefined || lastGood.fiveHour === undefined) return undefined
  return {
    ageSeconds: lastGood.ageSeconds,
    sevenDay: reading?.sevenDay ?? lastGood.sevenDay,
    fiveHour: reading?.fiveHour ?? lastGood.fiveHour,
  }
}

/** The borrowed windows that sit within the stand-in margin of their line, in words; empty when none does. */
function tooClose(
  reading: AccountReading | undefined,
  last: AccountReading,
  ceiling: number,
  line: number,
): string[] {
  const near = []
  if (reading?.sevenDay === undefined && (last.sevenDay ?? line) > line - LAST_GOOD_SEVEN_DAY_MARGIN)
    near.push(`seven_day ${last.sevenDay}% is within ${LAST_GOOD_SEVEN_DAY_MARGIN} points of line ${line}%`)
  if (reading?.fiveHour === undefined && (last.fiveHour ?? ceiling) > ceiling - LAST_GOOD_FIVE_HOUR_MARGIN)
    near.push(
      `five_hour ${last.fiveHour}% is within ${LAST_GOOD_FIVE_HOUR_MARGIN} points of ceiling ${ceiling}%`,
    )
  return near
}

/**
 * CC-409: a status line drops `five_hour` when its window resets, so the pool's freshest file can lack a
 * window for hours. A recent last good reading stands in for the missing window only, and only well inside its line.
 */
function gateLastGood(
  input: PoolGateInput,
  pool: PricedPool,
  closed: (why: string) => PoolGateResult,
): PoolGateResult {
  const last = input.lastGood
  const merged = standInReading(input.reading, last)
  if (last === undefined || merged === undefined) return closed(NO_READING)
  const age = last.ageSeconds
  if (!(age >= 0 && age <= LAST_GOOD_MAX_AGE_SECONDS))
    return closed(
      `${NO_READING}; the last good one is ${age}s old, over the ${LAST_GOOD_MAX_AGE_SECONDS}s limit`,
    )
  const { ceiling, line } = windowLines(pool, input)
  const near = tooClose(input.reading, last, ceiling, line)
  if (near.length > 0)
    return closed(`${NO_READING}; in the last good one (${age}s old), ${near.join(' and ')}`)
  const gate = gateWindows(input, pool, merged, closed)
  if (!gate.open) return gate
  return { ...gate, staleOk: true, reason: `${gate.reason}; stale-ok: last good reading ${age}s old` }
}

function gateWindows(
  input: PoolGateInput,
  pool: PricedPool,
  reading: { sevenDay: number; fiveHour: number },
  closed: (why: string) => PoolGateResult,
): PoolGateResult {
  const { ctx } = input
  const { ceiling, line, capsLifted, note } = windowLines(pool, input)
  const charged = chargedReading(pool, reading, input.dispatched ?? 0)
  const { fiveHour, sevenDay } = charged
  const why = ` (${note})${charged.note}`
  if (fiveHour >= ceiling) return closed(`five_hour ${fiveHour}% at or above ceiling ${ceiling}%${why}`)
  if (sevenDay >= line) return closed(`seven_day ${sevenDay}% at or above line ${line}%${why}`)
  const stop = spendStop(input, { at: ctx.now.getTime(), sevenDay }, capsLifted)
  if (stop !== undefined) return closed(`${stop}${charged.note}`)
  const band = sonnetBand(pool)
  const sonnetOnly = fiveHour >= ceiling - band || sevenDay >= line - band
  return {
    open: true,
    pool: pool.name,
    sonnetOnly,
    reason: `pool ${pool.name}: five_hour ${fiveHour}% vs ceiling ${ceiling}%, seven_day ${sevenDay}% vs line ${line}%${why}${sonnetOnly ? `; within ${band} points, sonnet only` : ''}`,
  }
}

/** The open account with the most headroom, and every closed one with its reason. */
export function pickAccount(
  accounts: string[],
  rules: Record<string, AccountRule>,
  readings: ReadonlyMap<string, AccountReading>,
  ctx: GateContext,
): { chosen?: Extract<GateResult, { open: true }>; closed: Extract<GateResult, { open: false }>[] } {
  const results = accounts.map(a => gateAccount(a, rules[a], readings.get(a), ctx))
  const open = results.filter((r): r is Extract<GateResult, { open: true }> => r.open)
  const closed = results.filter((r): r is Extract<GateResult, { open: false }> => !r.open)
  const [chosen] = open.sort((a, b) => b.headroom - a.headroom)
  return chosen === undefined ? { closed } : { chosen, closed }
}
