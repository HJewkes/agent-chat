import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_LEDGER } from '../agents/burndown/ledger.js'
import { loadSeats, planSeats, type SeatTickDeps } from '../agents/burndown/seat-tick.js'
import { readInitiatives } from '../agents/burndown/source.js'

/** CC-1306: a seat's dispatch bills its pool by name, so a later seat on that pool sees it charged. */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'autonomy-2026-09-29')
const HOUR = 3_600_000
const NOW = new Date(2026, 8, 29, 10)
const DAY_START = new Date(2026, 8, 29, 7).getTime()

/** pool-x's five_hour ceiling is 75 and a dispatch charges +10, so exactly one dispatch fits under it. */
const ONE_DISPATCH_LEFT = 62

/** CC-1038 b's gate reason states the reading plus this tick's charge, e.g. `+ 10 charged: 1 dispatch(es) this tick`. */
const ONE_CHARGED = 'charged: 1 dispatch(es) this tick'

let root: string

function deps(): SeatTickDeps {
  return {
    autonomyRoot: root,
    root,
    now: NOW,
    reading: () => ({ reading: { sevenDay: 10, fiveHour: ONE_DISPATCH_LEFT, ageSeconds: 30 } }),
    meters: () => ({
      run: { since: NOW.getTime() - HOUR, last: 10, spent: 0 },
      day: { since: DAY_START, last: 10, spent: 0 },
    }),
  }
}

function plan(names: string[], charged?: string[]) {
  const { loaded, skipped } = loadSeats(names, { ...EMPTY_LEDGER }, deps())
  expect(skipped).toEqual([])
  return planSeats(
    loaded,
    {
      ledger: EMPTY_LEDGER,
      initiatives: readInitiatives(root),
      scopeTagAliases: {},
      ...(charged === undefined ? {} : { charged }),
    },
    root,
  )
}

function editSeatB(from: string, to: string): void {
  const seat = path.join(root, 'seats', 'seat-b.md')
  fs.writeFileSync(seat, fs.readFileSync(seat, 'utf8').replace(from, to))
}

const moveSeatBToPoolX = () => editSeatB('pool: pool-y\n', 'pool: pool-x\nconfig_dir: /tmp/pool-x\n')

function writeTask(slug: string, id: string): void {
  fs.mkdirSync(path.join(root, slug, 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(root, slug, 'brief.md'), '---\nstate: active\nrank: 1\n---\n')
  fs.writeFileSync(
    path.join(root, slug, 'tasks', `${id}.yml`),
    `id: ${id}\ntitle: task ${id}\npriority: 1\nseverity: high\nestimate: 2\n` +
      'done_when: The widget renders.\nstatus: open\ntags: []\nnotes: ""\n' +
      'created: 2026-09-01\nupdated: 2026-09-20\ndone_at: null\n',
  )
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-tick-cross-charge-'))
  fs.cpSync(FIXTURE, root, { recursive: true })
  editSeatB('spend:\n', 'concurrency:\n  implementers: 4\nspend:\n')
  writeTask('init-alpha', 'AA-1')
  writeTask('init-beta', 'BB-1')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('planSeats charges this tick dispatches by pool name', () => {
  it('refuses a seat on budget when an earlier seat on its pool took the last dispatch', () => {
    moveSeatBToPoolX()

    const result = plan(['seat-a', 'seat-b'])

    expect(result.dispatch.map(d => [d.task, d.account])).toEqual([['AA-1', 'pool-x']])
    const refusal = result.refusals.find(r => r.task === 'BB-1')
    expect(refusal).toMatchObject({ kind: 'budget' })
    expect(refusal?.reason).toContain('pool pool-x:')
    expect(refusal?.reason).toContain(ONE_CHARGED)
  })

  it('counts a claim spawn already charged to the pool this tick', () => {
    const result = plan(['seat-a'], ['pool-x'])

    expect(result.dispatch).toEqual([])
    const refusal = result.refusals.find(r => r.task === 'AA-1')
    expect(refusal).toMatchObject({ kind: 'budget' })
    expect(refusal?.reason).toContain('pool pool-x:')
    expect(refusal?.reason).toContain(ONE_CHARGED)
  })

  it('does not charge a seat on another pool for an earlier seat dispatch', () => {
    const result = plan(['seat-a', 'seat-b'])

    expect(result.dispatch.map(d => [d.task, d.account])).toEqual([
      ['AA-1', 'pool-x'],
      ['BB-1', 'pool-y'],
    ])
    expect(result.dispatch[1]?.reason ?? '').not.toContain(ONE_CHARGED)
  })
})
