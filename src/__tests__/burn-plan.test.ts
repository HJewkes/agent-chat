import { describe, expect, it } from 'vitest'
import { burnPlan, type BurnConfig, type BurnReading } from '../agents/burn/plan.js'

const H = 3_600_000
const WEEK = 168 * H
const at = (iso: string): number => Date.parse(iso)

const cfg: BurnConfig = {
  allowed: ['alpha', 'bravo', 'charlie', 'delta'],
  lines: {},
  defaultLine: 100,
  horizonHours: 36,
  marginHours: 2,
  ptsPerWindow: 14,
  agentRate: 0.3,
  fiveHourCeiling: 90,
  maxAgents: 48,
}

const reading = (
  account: string,
  sevenDay: number,
  resetsAt: number,
  extra: Partial<BurnReading> = {},
): BurnReading => ({
  account,
  configDir: `/synthetic/${account}`,
  sevenDay,
  fiveHour: 10,
  resetsAt,
  fresh: true,
  ...extra,
})

describe('burnPlan', () => {
  it('burns the account whose window ends first, not the least used, just after another reset', () => {
    const now = at('2026-10-25T00:08:00Z')
    const plan = burnPlan(
      [
        reading('alpha', 1, at('2026-11-01T00:00:00Z')),
        reading('bravo', 59, at('2026-10-25T09:00:00Z')),
        reading('charlie', 0, at('2026-10-26T12:00:00Z')),
        reading('delta', 0, at('2026-10-31T18:00:00Z')),
      ],
      cfg,
      now,
    )
    expect(plan.order.slice(0, 2)).toEqual(['bravo', 'charlie'])
    expect(plan.accounts.bravo!.state).toBe('burn')
    expect(plan.accounts.alpha!.state).toBe('excluded')
  })

  it('marks a burn feasible with room and infeasible with startBy already passed', () => {
    const now = at('2026-10-31T00:00:00Z')
    const reset = at('2026-10-31T18:00:00Z')
    const roomy = burnPlan([reading('alpha', 60, reset), reading('bravo', 70, reset)], cfg, now)
    expect(roomy.accounts.alpha!.feasible).toBe(true)
    expect(roomy.accounts.bravo!.feasible).toBe(true)
    expect(roomy.order.slice(0, 2)).toEqual(['alpha', 'bravo'])
    const tight = burnPlan([reading('alpha', 40, reset)], cfg, now)
    expect(tight.accounts.alpha!.feasible).toBe(false)
    expect(tight.accounts.alpha!.startBy).toBeLessThan(now)
    expect(tight.accounts.alpha!.state).toBe('burn')
  })

  it('keeps an account over the five_hour ceiling in the order, behind the others', () => {
    const now = at('2026-10-31T00:00:00Z')
    const reset = at('2026-10-31T18:00:00Z')
    const plan = burnPlan(
      [
        reading('alpha', 10, reset, { fiveHour: 95 }),
        reading('bravo', 60, reset),
        reading('charlie', 0, reset + WEEK),
      ],
      cfg,
      now,
    )
    expect(plan.order).toEqual(['bravo', 'charlie', 'alpha'])
  })

  it('ends the timeline at the last reset hour across a DST change without local fields', () => {
    const now = at('2026-10-31T20:00:00Z')
    const plan = burnPlan([reading('alpha', 3, 1793523600000)], cfg, now)
    const last = plan.timeline[plan.timeline.length - 1]!
    expect(new Date(last.hourStartUtc).toISOString()).toBe('2026-11-01T08:00:00.000Z')
    expect(last.burnAccount).toBe('alpha')
    expect(Object.keys(last).sort()).toEqual(['burnAccount', 'hourStartUtc', 'overflow'])
  })

  it('never burns a stale reading', () => {
    const plan = burnPlan(
      [reading('alpha', 0, at('2026-10-31T18:00:00Z'), { fresh: false })],
      cfg,
      at('2026-10-31T10:00:00Z'),
    )
    expect(plan.accounts.alpha!.state).toBe('stale')
    expect(plan.timeline.every(h => h.burnAccount === null)).toBe(true)
  })

  it('takes the allowed set and the per-account line from config', () => {
    const now = at('2026-10-31T10:00:00Z')
    const reset = at('2026-10-31T18:00:00Z')
    const plan = burnPlan(
      [reading('alpha', 90, reset), reading('bravo', 0, reset)],
      { ...cfg, allowed: ['alpha'], lines: { alpha: 90 } },
      now,
    )
    expect(plan.accounts.alpha!.state).toBe('done')
    expect(plan.accounts.bravo!.state).toBe('excluded')
  })

  it('sizes targetAgents from expiring points and caps it by the machine', () => {
    const now = at('2026-10-31T10:00:00Z')
    const reset = at('2026-10-31T18:00:00Z')
    const plan = burnPlan([reading('alpha', 52, reset)], cfg, now)
    expect(plan.accounts.alpha!.targetAgents).toBe(20)
    const capped = burnPlan([reading('alpha', 52, reset)], { ...cfg, maxAgents: 6 }, now)
    expect(capped.accounts.alpha!.targetAgents).toBe(6)
  })

  it('treats an exhausted account as out of the burn', () => {
    const plan = burnPlan(
      [reading('alpha', 10, at('2026-10-31T18:00:00Z'), { exhausted: true })],
      cfg,
      at('2026-10-31T10:00:00Z'),
    )
    expect(plan.accounts.alpha!.state).toBe('exhausted')
    expect(plan.accounts.alpha!.targetAgents).toBe(0)
  })
})
