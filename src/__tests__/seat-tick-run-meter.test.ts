import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gatePool } from '../agents/burndown/budget-gate.js'
import type { Ledger } from '../agents/burndown/ledger.js'
import { loadSeats, type SeatTickDeps } from '../agents/burndown/seat-tick.js'
import type { Pool, Seat } from '../agents/seats/charter.js'
import { meterSpend, type SpendMeter } from '../agents/seats/stops.js'
import { seatSpawnGate } from '../agents/seats/spawn-gate.js'

/** The tick reads the watchdog's run meter when its own ledger holds no run-start sample. Synthetic fixtures. */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'autonomy-2026-09-29')
const NOW = new Date(2026, 8, 29, 10)
const DAY_START = new Date(2026, 8, 29, 7).getTime()
const RUN_START = new Date(2026, 8, 29, 9, 30).getTime()
const EMPTY = { seats: {} } as unknown as Ledger
const NO_START = 'no seven_day reading at run start, so run spend is unknown'

let root: string

const dayMeter: SpendMeter = { since: DAY_START, last: 50, spent: 0 }

interface TickInput {
  ledger?: Ledger
  now?: Date
  sevenDay?: number
  day?: SpendMeter
}

function tickGate(run: SpendMeter | undefined, input: TickInput = {}) {
  const deps: SeatTickDeps = {
    autonomyRoot: root,
    root,
    now: input.now ?? NOW,
    reading: () => ({ reading: { sevenDay: input.sevenDay ?? 50, fiveHour: 10, ageSeconds: 30 } }),
    meters: () => ({ run, day: input.day ?? dayMeter }),
  }
  const { loaded, skipped } = loadSeats(['seat-a'], input.ledger ?? EMPTY, deps)
  expect(skipped).toEqual([])
  return gatePool(loaded[0]!.budget)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-tick-run-meter-'))
  fs.cpSync(FIXTURE, root, { recursive: true })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the seat tick with a watchdog run meter and no ledger samples', () => {
  it('computes run spend from the meter and stays open under the cap', () => {
    const gate = tickGate({ since: RUN_START, last: 50, spent: 2 })

    expect(gate.open).toBe(true)
  })

  it('refuses with the run-spend reason when the meter is over per_run_points', () => {
    const gate = tickGate({ since: RUN_START, last: 50, spent: 6 })

    expect(gate).toMatchObject({ open: false })
    expect(JSON.stringify(gate)).toContain("run spend 6 points at or above the seat's per_run_points 5")
  })

  it('refuses with the unknown-run-start reason when there is no meter either', () => {
    const gate = tickGate(undefined)

    expect(gate).toMatchObject({ open: false })
    expect(JSON.stringify(gate)).toContain(NO_START)
  })

  it('refuses with the unknown-run-start reason when the saved meter lacks spent', () => {
    const malformed = { since: RUN_START, last: 50 } as unknown as SpendMeter

    const gate = tickGate(malformed)

    expect(gate).toMatchObject({ open: false })
    expect(JSON.stringify(gate)).toContain(NO_START)
  })

  it('counts the same run spend as the spawn gate for one meter', () => {
    const meter = { since: RUN_START, last: 50, spent: 6 }
    const pool: Pool = {
      name: 'pool-x',
      configDir: '/synthetic/x',
      humanUses: false,
      rule: { reserve_seven_day: 30, ceiling_five_hour: 85 },
    }
    const seat: Seat = { name: 'seat-a', prefix: 'sa', pool: 'pool-x', spend: { perRunPoints: 5 } }

    const spawn = seatSpawnGate({
      seat,
      pool,
      reading: { sevenDay: 50, fiveHour: 10, ageSeconds: 30 },
      runMeter: meter,
      dayMeter,
      model: 'opus',
      now: NOW,
    })

    expect(spawn.reason).toContain("run spend 6 points at or above the seat's per_run_points 5")
    expect(JSON.stringify(tickGate(meter))).toContain(
      "run spend 6 points at or above the seat's per_run_points 5",
    )
  })
})

describe('the seat tick with ledger samples and a watchdog meter across a seven_day reset', () => {
  const at = (hour: number, minute = 0) => new Date(2026, 8, 29, hour, minute).getTime()
  const ledger = {
    seats: {
      'seat-a': {
        samples: [
          { at: at(6, 30), sevenDay: 84 },
          { at: at(9), sevenDay: 85 },
          { at: at(10), sevenDay: 86 },
          { at: at(11), sevenDay: 0 },
        ],
      },
    },
  } as unknown as Ledger

  it('counts run and day spend from the ledger alone and stays open', () => {
    const gate = tickGate(
      { since: at(9), last: 0, spent: 1 },
      { ledger, now: new Date(at(11, 30)), sevenDay: 1, day: { since: DAY_START, last: 0, spent: 2 } },
    )

    expect(gate.open).toBe(true)
  })
})

describe('meterSpend with a malformed saved meter', () => {
  it('counts the meter as absent, so no caller gets NaN history', () => {
    const malformed = { since: RUN_START, last: 50 } as unknown as SpendMeter

    const spend = meterSpend(
      { run: malformed, day: { since: DAY_START, last: Number.NaN, spent: 0 } },
      50,
      NOW,
    )

    expect(spend).toMatchObject({ history: [], run: undefined, day: undefined })
  })
})
