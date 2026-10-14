import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { gatePool, type DispatchCost, type PoolRule } from '../agents/burndown/budget-gate.js'
import { diskDispatchCosts } from '../agents/burndown/dispatch-cost-source.js'

/**
 * CC-1038 e: the 2026-10-11 13:31Z refusal replayed. The fixture holds pool personal's watchdog readings and
 * seat-a's dispatched rows from 07:00Z to 13:40Z, copied from the autonomy root, with the seat on personal.
 */

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'dispatch-cost-2026-10-11',
)
const NOW = new Date('2026-10-11T13:31:00Z')

/** Charter line 57 as it stood before the owner's interim `dispatch_five_hour_points: 2`. */
const PERSONAL: PoolRule = {
  name: 'personal',
  human_uses: false,
  reserve_seven_day: 14,
  ceiling_five_hour: 95,
  per_day_points: 60,
}

interface ReadingRow {
  ts: number
  seven_day: number
  resets_at: number
}

const readings = (): ReadingRow[] =>
  fs
    .readFileSync(path.join(FIXTURE, 'pool-readings.jsonl'), 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as ReadingRow)

/** The tick's gate at 13:31Z on the reported 46/27 reading with four dispatches already charged. */
function gateAt1331(dispatchCost?: DispatchCost) {
  const earlier = readings().filter(r => r.ts * 1000 < NOW.getTime())
  return gatePool({
    pool: PERSONAL,
    spend: {},
    reading: { sevenDay: 27, fiveHour: 46, ageSeconds: 30, sevenDayResetsAt: earlier[0]!.resets_at * 1000 },
    history: earlier.map(r => ({ at: r.ts * 1000, sevenDay: r.seven_day })),
    runStartAt: NOW.getTime() - 3_600_000,
    ctx: { now: NOW },
    dispatched: 4,
    ...(dispatchCost === undefined ? {} : { dispatchCost }),
  })
}

const figure = (reason: string): number => Number(/five_hour ([\d.]+)%/.exec(reason)?.[1])

describe('the 2026-10-11 13:31Z tick replayed over that day’s readings and dispatches', () => {
  it('opens personal below the sonnet band at the real 46% once dispatches cost what they were observed to', () => {
    const cost = diskDispatchCosts(FIXTURE, NOW.getTime())('personal')

    const result = gateAt1331(cost)

    expect(cost?.basis).toMatch(/^observed: \d+ spawns/)
    expect(result).toMatchObject({ open: true, pool: 'personal', sonnetOnly: false })
    expect(result.reason).toContain('(reading 46% + ')
    expect(result.reason).toContain('4 dispatch(es) this tick at')
    expect(result.reason).toContain(', observed)')
    expect(figure(result.reason)).toBeLessThan(50)
  })

  it('reproduces the reported refusal shape under the default cost', () => {
    const result = gateAt1331()

    expect(result).toMatchObject({ open: true, sonnetOnly: true })
    expect(result.reason).toContain(
      'five_hour 86% (reading 46% + 40 charged: 4 dispatch(es) this tick at 10 each, default)',
    )
    expect(result.reason).toContain('within 10 points, sonnet only')
  })

  it('keeps the estimate within 2x across the ramp to 13:31Z', () => {
    const at = (iso: string) => diskDispatchCosts(FIXTURE, Date.parse(iso))('personal')!.fiveHour

    const figures = [at('2026-10-11T12:30:00Z'), at('2026-10-11T13:00:00Z'), at(NOW.toISOString())]

    expect(Math.max(...figures) / Math.min(...figures)).toBeLessThanOrEqual(2)
  })
})
