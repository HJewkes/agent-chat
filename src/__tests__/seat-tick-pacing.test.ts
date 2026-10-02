import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gatePool } from '../agents/burndown/budget-gate.js'
import type { Ledger } from '../agents/burndown/ledger.js'
import { loadSeats, type SeatTickDeps } from '../agents/burndown/seat-tick.js'

/** CC-404: the burndown tick holds a reset-aware seat at the same day allowance as the watchdog and `seats status`. */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'autonomy-2026-09-29')
const NOW = new Date(2026, 8, 29, 10)
const DAY_START = new Date(2026, 8, 29, 7).getTime()
const DAY_MS = 24 * 3_600_000
/** A run that started at 09:30 on seven_day 50, well under seat-a's per_run_points 5. */
const RUN_START = new Date(2026, 8, 29, 9, 30).getTime()

let root: string

/** The fixture, with seat-a's frontmatter given `extra`. */
function autonomy(extra: string): string {
  fs.cpSync(FIXTURE, root, { recursive: true })
  const seatFile = path.join(root, 'seats', 'seat-a.md')
  fs.writeFileSync(
    seatFile,
    fs.readFileSync(seatFile, 'utf8').replace('pool: pool-x\n', `pool: pool-x\n${extra}`),
  )
  return root
}

function deps(autonomyRoot: string, sevenDay: number, resetDays: number): SeatTickDeps {
  return {
    autonomyRoot,
    root: autonomyRoot,
    now: NOW,
    reading: () => ({
      reading: { sevenDay, fiveHour: 10, ageSeconds: 30 },
      resetsAt: DAY_START + resetDays * DAY_MS,
    }),
    recordedRunStart: () => RUN_START,
  }
}

// pool-x's line is 70 and seven_day read 40 at 06:00, so 30 points are left at the day start.
const ledger = {
  seats: {
    'seat-a': {
      samples: [
        { at: DAY_START - 3_600_000, sevenDay: 40 },
        { at: RUN_START, sevenDay: 50 },
      ],
    },
  },
} as unknown as Ledger

const gateOf = (extra: string, sevenDay: number, resetDays: number) => {
  const { loaded, skipped } = loadSeats(['seat-a'], ledger, deps(autonomy(extra), sevenDay, resetDays))
  expect(skipped).toEqual([])
  return gatePool(loaded[0]!.budget)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-tick-pacing-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the tick gate for a reset-aware seat', () => {
  it('opens on day spend past per_day_points when the reset is half a day from 07:00', () => {
    expect(gateOf('pacing: reset-aware\n', 51, 0.5)).toMatchObject({ open: true })
  })

  it('stops at the allowance when the reset is three days from 07:00', () => {
    const gate = gateOf('pacing: reset-aware\n', 51, 3)
    expect(gate).toMatchObject({ open: false })
    expect(gate.reason).toContain(
      "day spend 11 points since 07:00 at or above the seat's reset-aware day allowance 10",
    )
  })

  it('keeps the per_day_points stop for a seat without the key', () => {
    const gate = gateOf('', 51, 0.5)
    expect(gate.reason).toContain("day spend 11 points since 07:00 at or above the seat's per_day_points 9")
  })
})
