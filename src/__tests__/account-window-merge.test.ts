import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAccountBudget } from '../agents/budget.js'
import { gateAccount } from '../agents/burndown/budget-gate.js'
import { readReadings } from '../agents/burndown/source.js'

/**
 * CC-895: a pool's status cache holds the usage poller's file and every session's status-line file.
 * A status line drops five_hour after its reset, so the newest file alone can lack a window another
 * fresh file still has.
 */

const NOW_S = 2_000_000
const NOW_MS = NOW_S * 1000
const FIVE_HOUR_RESET = NOW_S + 3_600
const SEVEN_DAY_RESET = NOW_S + 3 * 86_400
const rule = { reserve_seven_day: 15, ceiling_five_hour: 90, human_uses: false }

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-895-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function status(id: string, ageSeconds: number, rate_limits: Record<string, unknown>): void {
  const file = path.join(dir, 'status-cache', 'sessions', `${id}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ session_id: id, written_at: NOW_S - ageSeconds, rate_limits }))
}

const fiveHour = (pct: number, resets_at = FIVE_HOUR_RESET) => ({ used_percentage: pct, resets_at })
const sevenDay = (pct: number) => ({ used_percentage: pct, resets_at: SEVEN_DAY_RESET })

const reading = () => readReadings(['server'], NOW_MS, () => dir).get('server')

describe('account budget window merge', () => {
  it('reads both windows when a newer status line has only seven_day and the poller has both', () => {
    status('usage-poller', 120, { five_hour: fiveHour(20), seven_day: sevenDay(40) })
    status('design-coord', 10, { seven_day: sevenDay(41) })

    const got = reading()

    expect(got).toEqual({
      ageSeconds: 120,
      fiveHour: 20,
      sevenDay: 41,
      sevenDayResetsAt: SEVEN_DAY_RESET * 1000,
    })
    expect(gateAccount('server', rule, got, { now: new Date(NOW_MS) }).open).toBe(true)
  })

  it('takes each window from the freshest file that has it', () => {
    status('usage-poller', 300, { five_hour: fiveHour(20), seven_day: sevenDay(40) })
    status('a', 60, { five_hour: fiveHour(25) })
    status('b', 5, { seven_day: sevenDay(42) })

    const got = reading()

    expect(got).toMatchObject({ fiveHour: 25, sevenDay: 42, ageSeconds: 60 })
  })

  it('closes as today when every file is stale', () => {
    status('usage-poller', 3_600, { five_hour: fiveHour(20), seven_day: sevenDay(40) })
    status('design-coord', 1_800, { seven_day: sevenDay(41) })

    const gate = gateAccount('server', rule, reading(), { now: new Date(NOW_MS) })

    expect(gate.open).toBe(false)
  })

  it('borrows no window from a stale file', () => {
    status('usage-poller', 1_800, { five_hour: fiveHour(20), seven_day: sevenDay(40) })
    status('design-coord', 10, { seven_day: sevenDay(41) })

    const got = reading()

    expect(got).toEqual({ ageSeconds: 10, sevenDay: 41, sevenDayResetsAt: SEVEN_DAY_RESET * 1000 })
    expect(gateAccount('server', rule, got, { now: new Date(NOW_MS) }).reason).toContain(
      'no seven_day and five_hour reading',
    )
  })

  it('borrows no window whose reset has passed', () => {
    status('usage-poller', 120, { five_hour: fiveHour(80, NOW_S - 60), seven_day: sevenDay(40) })
    status('design-coord', 10, { seven_day: sevenDay(41) })

    expect(reading()?.fiveHour).toBeUndefined()
  })

  it('keeps the newest file whole, path and all', () => {
    status('usage-poller', 120, { five_hour: fiveHour(20), seven_day: sevenDay(40) })
    status('design-coord', 10, { seven_day: sevenDay(41) })

    const read = readAccountBudget(dir, NOW_MS)

    expect(read.found && path.basename(read.path)).toBe('design-coord.json')
    expect(read.found && read.budget.session_id).toBe('design-coord')
  })
})
