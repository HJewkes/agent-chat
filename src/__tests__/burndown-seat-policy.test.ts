import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collisionCheck } from '../agents/burndown/collision.js'
import type { Runner } from '../agents/burndown/exec.js'
import { EMPTY_LEDGER } from '../agents/burndown/ledger.js'
import { loadPolicy } from '../agents/burndown/policy.js'
import { scoredPlanFromDisk } from '../agents/burndown/score-render.js'
import { loadSeats, planSeats, type SeatTickDeps } from '../agents/burndown/seat-tick.js'
import { readInitiatives } from '../agents/burndown/source.js'

/**
 * TP-1974 a: each seat's hard stops and defaults resolve through coordinator `resolveSeatPolicy`, so a seat's
 * `extra_hard_stops` reach stop-short, a seat never drops a charter class, and `stop_short_factor` only goes down.
 * The fixture charter stops at broker-restart, deploy and spend-money with stop_short_factor 0.8. A declared human op
 * refuses as needs-human before stop-short is read, so the cases use `ops:publish` under the release grant: its
 * classes are npm-publish and tag-move.
 */

const AUTONOMY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'autonomy-2026-09-29')
const NOW = new Date(2026, 8, 29, 10)
const runStart = NOW.getTime() - 3_600_000
const ledger = {
  ...EMPTY_LEDGER,
  seats: {
    'seat-a': {
      configDir: '/tmp/pool-x',
      samples: [
        { at: new Date(2026, 8, 29, 6).getTime(), sevenDay: 38 },
        { at: runStart, sevenDay: 39 },
      ],
    },
  },
}

let root: string

const deps = (): SeatTickDeps => ({
  autonomyRoot: root,
  root,
  now: NOW,
  reading: () => ({ reading: { sevenDay: 40, fiveHour: 10, ageSeconds: 30 } }),
  meters: () => ({ run: { since: runStart, last: 40, spent: 0 } }),
})

const git: Runner = bin => ({ status: 0, stdout: bin === 'git' ? 'init\n' : '' })

function edit(file: string, from: string | RegExp, to: string): void {
  const full = path.join(root, file)
  fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace(from, to))
}

/** Appends `lines` to seat-a's frontmatter. */
const editSeatA = (lines: string) => edit(path.join('seats', 'seat-a.md'), /\n---\s*$/, `\n${lines}\n---\n`)

function writeTask(tags: string[]): void {
  fs.writeFileSync(
    path.join(root, 'init-alpha', 'tasks', 'AA-1.yml'),
    'id: AA-1\ntitle: task AA-1\npriority: 1\nseverity: high\nestimate: 2\n' +
      `done_when: The widget renders.\nstatus: open\ntags: [${tags.join(', ')}]\nnotes: ""\n` +
      'created: 2026-09-01\nupdated: 2026-09-20\ndone_at: null\n',
  )
}

function planSeatA() {
  const { loaded, skipped } = loadSeats(['seat-a'], ledger, deps())
  expect(skipped).toEqual([])
  const collision = collisionCheck(ledger, { names: [], claims: [] }, git)
  return planSeats(
    loaded,
    { ledger, initiatives: readInitiatives(root), scopeTagAliases: {}, collision },
    root,
  )
}

const stopShortOf = (planned: ReturnType<typeof planSeatA>) =>
  planned.refusals.filter(r => r.kind === 'stop-short').map(r => r.reason)

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-policy-'))
  fs.cpSync(AUTONOMY, root, { recursive: true })
  fs.mkdirSync(path.join(root, 'init-alpha', 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(root, 'init-alpha', 'brief.md'), '---\nstate: active\nrank: 1\n---\n')
  edit(path.join('seats', 'seat-a.md'), 'grants_extra: [', 'grants_extra: [release-through-ci, ')
  writeTask(['ops:publish'])
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('a seat resolving its policy over the charter', () => {
  it('dispatches a publish task when neither charter nor seat stops at npm-publish', () => {
    const planned = planSeatA()

    expect(stopShortOf(planned)).toEqual([])
    expect(planned.dispatch.map(d => d.task)).toEqual(['AA-1'])
  })

  it("stops short at a class only the seat's extra_hard_stops adds", () => {
    editSeatA('extra_hard_stops: [npm-publish]')

    const planned = planSeatA()

    expect(stopShortOf(planned)).toEqual(['done_when stops short at npm-publish'])
    expect(planned.dispatch).toEqual([])
  })

  it('keeps every charter class for a seat that lists fewer hard_stops', () => {
    edit('charter.md', 'hard_stops: [', 'hard_stops: [npm-publish, ')
    editSeatA('hard_stops: [deploy]')

    const planned = planSeatA()

    expect(stopShortOf(planned)).toEqual(['done_when stops short at npm-publish'])
    expect(loadPolicy(root, 'seat-a').hardStops).toEqual([
      'npm-publish',
      'broker-restart',
      'deploy',
      'spend-money',
    ])
  })

  it.each([
    ['clamps a seat stop_short_factor above the charter down to it', 0.95, 0.8],
    ['keeps a seat stop_short_factor below the charter', 0.5, 0.5],
  ])('%s', (_name, seatFactor, resolved) => {
    editSeatA(`defaults:\n  stop_short_factor: ${seatFactor}`)

    const { loaded } = loadSeats(['seat-a'], ledger, deps())

    expect(loaded[0]?.policy.defaults.stop_short_factor).toBe(resolved)
  })

  it("shows the seat's extra_hard_stops in plan --scored (TP-1974 b)", () => {
    editSeatA('extra_hard_stops: [npm-publish]')

    const plan = scoredPlanFromDisk({
      seat: 'seat-a',
      top: 5,
      today: '2026-09-29',
      autonomyRoot: root,
      activeWorkRoot: root,
    })

    expect(plan.order.map(row => [row.id, row.stopShort])).toEqual([['AA-1', ['npm-publish']]])
  })
})
