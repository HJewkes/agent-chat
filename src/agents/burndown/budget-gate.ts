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

const humanAbsentFor = (ctx: GateContext, ms: number): boolean =>
  ctx.humanLastTurnAt !== undefined && ctx.now.getTime() - ctx.humanLastTurnAt >= ms

const isNight = (ctx: GateContext): boolean => {
  const hour = ctx.now.getHours()
  const nightHour = hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR
  return nightHour && humanAbsentFor(ctx, NIGHT_ABSENCE_MS)
}

export function gateAccount(
  account: string,
  rule: AccountRule | undefined,
  reading: AccountReading | undefined,
  ctx: GateContext,
): GateResult {
  if (rule === undefined) return { open: false, account, reason: 'no budget rule for this account' }
  if (reading?.sevenDay === undefined || reading.fiveHour === undefined)
    return { open: false, account, reason: 'no seven_day and five_hour reading under this account' }

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
