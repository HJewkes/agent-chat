import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spendSince } from '../agents/burndown/budget-gate.js'
import type { Ledger } from '../agents/burndown/ledger.js'
import { loadSeats, type SeatTickDeps } from '../agents/burndown/seat-tick.js'

/** CC-1080: samples read from another pool's account never join the series, so a cross-pool drop is no reset. */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'autonomy-2026-09-29')
const HOUR = 3_600_000
const NOW = new Date(2026, 8, 29, 10)
const DAY_START = new Date(2026, 8, 29, 7).getTime()
const OLD_DIR = '/accounts/personal'

let root: string

function deps(sevenDay: number): SeatTickDeps {
  return {
    autonomyRoot: root,
    root,
    now: NOW,
    reading: () => ({ reading: { sevenDay, fiveHour: 10, ageSeconds: 30 } }),
    meters: () => ({}),
  }
}

const oldPoolSamples = [
  { at: DAY_START - 5 * HOUR, sevenDay: 55 },
  { at: DAY_START - 4 * HOUR, sevenDay: 47 },
  { at: DAY_START - 3 * HOUR, sevenDay: 56 },
]

function stateAfter(previous: Record<string, unknown>) {
  const ledger = { seats: { 'seat-a': previous } } as unknown as Ledger
  const { loaded } = loadSeats(['seat-a'], ledger, deps(22))
  return loaded[0]!
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-tick-switch-'))
  fs.cpSync(FIXTURE, root, { recursive: true })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('a seat that changed billing pool', () => {
  it('drops the old pool samples and counts only the new pool spend', () => {
    const seat = stateAfter({ samples: oldPoolSamples, configDir: OLD_DIR })
    const history = [...seat.budget.history, { at: DAY_START - HOUR, sevenDay: 14 }]
    expect(seat.budget.history).toEqual([])
    expect(spendSince(history, DAY_START, { at: NOW.getTime(), sevenDay: 22 })).toBe(8)
    expect(seat.state.configDir).toBe(seat.dispatch.configDir)
  })

  it('drops samples a ledger without a pool key holds, since their pool is unknown', () => {
    expect(stateAfter({ samples: oldPoolSamples }).budget.history).toEqual([])
  })

  it('keeps the samples of an unchanged pool', () => {
    const first = stateAfter({ samples: [] })
    const seat = stateAfter({ samples: oldPoolSamples, configDir: first.dispatch.configDir })
    expect(seat.budget.history).toHaveLength(3)
  })
})
