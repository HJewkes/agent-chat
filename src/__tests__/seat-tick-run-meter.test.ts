import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gatePool } from '../agents/burndown/budget-gate.js'
import type { Ledger } from '../agents/burndown/ledger.js'
import { loadSeats, type SeatTickDeps } from '../agents/burndown/seat-tick.js'
import type { Pool, Seat } from '../agents/seats/charter.js'
import type { SpendMeter } from '../agents/seats/stops.js'
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

function tickGate(run: SpendMeter | undefined) {
  const deps: SeatTickDeps = {
    autonomyRoot: root,
    root,
    now: NOW,
    reading: () => ({ reading: { sevenDay: 50, fiveHour: 10, ageSeconds: 30 } }),
    recordedRunStart: () => run?.since,
    meters: () => ({ run, day: dayMeter }),
  }
  const { loaded, skipped } = loadSeats(['seat-a'], EMPTY, deps)
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
