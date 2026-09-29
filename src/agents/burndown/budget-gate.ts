/**
 * Whether the tick may spend on an account right now (design section 7).
 *
 * The reserve is what keeps the human's own sessions, which share these
 * accounts, from hitting a weekly limit the loop used up. Every unknown is
 * read as the human being present and the account being full: a missing rule,
 * a missing reading and a missing presence signal all close the gate or keep
 * the stricter numbers, never the looser ones.
 */

export interface AccountRule {
  reserve_seven_day: number
  ceiling_five_hour: number
  night?: { reserve_seven_day: number }
}

export interface AccountReading {
  sevenDay?: number
  fiveHour?: number
  ageSeconds: number
}

export interface GateContext {
  now: Date
  /** Epoch ms of the last human-typed turn on the account; absent means assume the human is here. */
  humanLastTurnAt?: number
}

export type GateResult =
  | { open: true; account: string; headroom: number; sonnetOnly: boolean; reason: string }
  | { open: false; account: string; reason: string }

export const DEFAULT_RULES: Record<string, AccountRule> = {
  agents: { reserve_seven_day: 25, ceiling_five_hour: 70, night: { reserve_seven_day: 10 } },
  personal: { reserve_seven_day: 35, ceiling_five_hour: 40 },
  workout: { reserve_seven_day: 35, ceiling_five_hour: 40 },
}

const NIGHT_START_HOUR = 23
const NIGHT_END_HOUR = 7
const NIGHT_ABSENCE_MS = 30 * 60_000
const PRESENT_WITHIN_MS = 15 * 60_000
const PRESENT_CEILING = 70
const SONNET_ONLY_ABOVE = 85
/** Both gates use the freshest status file; an older one may hide spend since. */
export const MAX_READING_AGE_SECONDS = 15 * 60

const humanAbsentFor = (ctx: GateContext, ms: number): boolean =>
  ctx.humanLastTurnAt !== undefined && ctx.now.getTime() - ctx.humanLastTurnAt >= ms

const isNight = (ctx: GateContext): boolean => {
  const hour = ctx.now.getHours()
  const nightHour = hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR
  return nightHour && humanAbsentFor(ctx, NIGHT_ABSENCE_MS)
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
  if (rule === undefined) return { open: false, account, reason: 'no budget rule for this account' }
  if (reading?.sevenDay === undefined || reading.fiveHour === undefined)
    return { open: false, account, reason: 'no seven_day and five_hour reading under this account' }
  const stale = staleReason(reading.ageSeconds, maxReadingAgeSeconds)
  if (stale !== undefined) return { open: false, account, reason: stale }

  const night = isNight(ctx) && rule.night !== undefined
  const reserve = night ? (rule.night?.reserve_seven_day ?? rule.reserve_seven_day) : rule.reserve_seven_day
  const present = !humanAbsentFor(ctx, PRESENT_WITHIN_MS)
  const ceiling = present ? Math.min(rule.ceiling_five_hour, PRESENT_CEILING) : rule.ceiling_five_hour
  const { sevenDay, fiveHour } = reading
  const figures = `seven_day ${sevenDay}% vs line ${100 - reserve}%${night ? ' (night)' : ''}, five_hour ${fiveHour}% vs ceiling ${ceiling}%`

  if (sevenDay >= 100 - reserve) return { open: false, account, reason: `inside the reserve: ${figures}` }
  if (fiveHour >= ceiling) return { open: false, account, reason: `over the five-hour ceiling: ${figures}` }
  return {
    open: true,
    account,
    headroom: 100 - reserve - sevenDay,
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
  night_reserve_seven_day?: number | undefined
  per_day_points?: number | undefined
}

/** The seat file's `spend:` caps, in seven_day points; an absent cap never stops. */
export interface SpendCaps {
  per_run_points?: number | undefined
  per_day_points?: number | undefined
}

export interface SevenDaySample {
  at: number
  sevenDay: number
  /** Epoch ms the seven_day window resets, from the status file; a sample after it starts a new window. */
  resetsAt?: number
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
}

export type PoolGateResult =
  | { open: true; pool: string; sonnetOnly: boolean; reason: string }
  | { open: false; pool: string; reason: string }

const RUN_CAP_MS = 12 * 3_600_000
const DAY_START_HOUR = 7
const SONNET_BAND_POINTS = 10

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
function spendSince(
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

interface WindowLines {
  ceiling: number
  line: number
  note: string
}

function windowLines(pool: PoolRule, reserve: number, ceiling: number, ctx: GateContext): WindowLines {
  const night = isNight(ctx) && pool.night_reserve_seven_day !== undefined
  const present = pool.human_uses && !humanAbsentFor(ctx, PRESENT_WITHIN_MS)
  const lowered = present && ceiling > PRESENT_CEILING
  return {
    ceiling: lowered ? PRESENT_CEILING : ceiling,
    line: 100 - (night ? (pool.night_reserve_seven_day ?? reserve) : reserve),
    note: [night && 'night reserve', lowered && 'owner typed in the last 15 min'].filter(Boolean).join(', '),
  }
}

function spendStop(input: PoolGateInput, now: SevenDaySample): string | undefined {
  const { pool, spend, runStartAt, ctx } = input
  const runCap = spend.per_run_points
  if (runCap !== undefined) {
    const run = spendSince(input.history, Math.max(runStartAt, now.at - RUN_CAP_MS), now)
    if (run === undefined) return 'no seven_day reading at run start, so run spend is unknown'
    if (run >= runCap) return `run spend ${run} points at or above the seat's per_run_points ${runCap}`
  }
  const caps = [
    { cap: pool?.per_day_points, whose: `pool ${pool?.name ?? '?'}'s per_day_points` },
    { cap: spend.per_day_points, whose: "seat's per_day_points" },
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

/** Charter section 4's budget stops for one seat on its pool; a closed result's reason is the `BUDGET-PAUSE` line. */
export function gatePool(input: PoolGateInput): PoolGateResult {
  const { pool, reading, ctx } = input
  const name = pool?.name ?? 'unknown'
  const closed = (why: string): PoolGateResult => ({
    open: false,
    pool: name,
    reason: `BUDGET-PAUSE pool ${name}: ${why}`,
  })
  if (pool?.reserve_seven_day === undefined || pool.ceiling_five_hour === undefined)
    return closed('no reserve_seven_day and ceiling_five_hour for this pool in the charter')
  if (reading?.sevenDay === undefined || reading.fiveHour === undefined)
    return closed('no seven_day and five_hour reading for this pool')
  if (reading.ageSeconds > MAX_READING_AGE_SECONDS)
    return closed(`reading is ${reading.ageSeconds}s old, over the ${MAX_READING_AGE_SECONDS}s limit`)
  const { ceiling, line, note } = windowLines(pool, pool.reserve_seven_day, pool.ceiling_five_hour, ctx)
  const { fiveHour, sevenDay } = reading
  const why = note === '' ? '' : ` (${note})`
  if (fiveHour >= ceiling) return closed(`five_hour ${fiveHour}% at or above ceiling ${ceiling}%${why}`)
  if (sevenDay >= line) return closed(`seven_day ${sevenDay}% at or above line ${line}%${why}`)
  const stop = spendStop(input, { at: ctx.now.getTime(), sevenDay })
  if (stop !== undefined) return closed(stop)
  const sonnetOnly = fiveHour >= ceiling - SONNET_BAND_POINTS || sevenDay >= line - SONNET_BAND_POINTS
  return {
    open: true,
    pool: name,
    sonnetOnly,
    reason: `pool ${name}: five_hour ${fiveHour}% vs ceiling ${ceiling}%, seven_day ${sevenDay}% vs line ${line}%${why}${sonnetOnly ? '; within 10 points, sonnet only' : ''}`,
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
