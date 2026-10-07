import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collisionCheck } from '../agents/burndown/collision.js'
import type { Runner } from '../agents/burndown/exec.js'
import { EMPTY_LEDGER, type Ledger } from '../agents/burndown/ledger.js'
import { loadSeats, planSeats, type SeatTickDeps } from '../agents/burndown/seat-tick.js'
import { readInitiatives } from '../agents/burndown/source.js'

/** CC-794: the seat tick's landed check reads every repo in the seat's list, through planSeats. */

const AUTONOMY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'autonomy-2026-09-29')
const NOW = new Date(2026, 8, 29, 10)
const SIBLING = '/tmp/repos/alpha-docs'
const NON_GIT = '/tmp/repos/alpha-bin'
const runStart = NOW.getTime() - 3_600_000
const ledger: Ledger = {
  ...EMPTY_LEDGER,
  seats: {
    'seat-a': {
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

/** Plans seat-a over one task, git answering per checkout: `log` gives its subjects, `fetch` fails for `broken`. */
function plan(subjectsByRepo: Record<string, string>, broken?: string, read: string[] = []) {
  const exec: Runner = (bin, args, cwd) => {
    if (cwd !== undefined) read.push(cwd)
    if (bin === 'gh') return { status: 0, stdout: '' }
    if (args[0] === 'fetch' && cwd === broken) return { status: 1, stdout: '' }
    return { status: 0, stdout: args[0] === 'log' ? (subjectsByRepo[cwd ?? ''] ?? 'init\n') : '' }
  }
  const { loaded, skipped } = loadSeats(['seat-a'], ledger, deps())
  expect(skipped).toEqual([])
  const collision = collisionCheck(ledger, { names: [], claims: [] }, exec)
  return planSeats(loaded, { ledger, initiatives: readInitiatives(root), collision }, root)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-tick-landed-'))
  fs.cpSync(AUTONOMY, root, { recursive: true })
  fs.mkdirSync(path.join(root, 'init-alpha', 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(root, 'init-alpha', 'brief.md'), '---\nstate: active\nrank: 1\n---\n')
  fs.writeFileSync(
    path.join(root, 'init-alpha', 'tasks', 'AA-1.yml'),
    'id: AA-1\ntitle: task AA-1\npriority: 1\nseverity: high\nestimate: 2\n' +
      'done_when: The widget renders.\nstatus: open\ntags: []\nnotes: ""\n' +
      'created: 2026-09-01\nupdated: 2026-09-20\ndone_at: null\n',
  )
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('planSeats landed check across the seat repos', () => {
  it('dispatches a task that landed nowhere', () => {
    expect(plan({}).dispatch.map(d => d.task)).toEqual(['AA-1'])
  })

  it('refuses a task landed in a sibling repo of the initiative', () => {
    const planned = plan({ [SIBLING]: 'AA-1 Land it (#9)\n' })

    expect(planned.dispatch).toEqual([])
    expect(planned.refusals).toEqual([
      expect.objectContaining({
        task: 'AA-1',
        kind: 'landed',
        reason: expect.stringContaining('AA-1 Land it'),
      }),
    ])
  })

  it('names the sibling repo whose git read failed', () => {
    const planned = plan({}, SIBLING)

    expect(planned.refusals).toEqual([
      expect.objectContaining({
        kind: 'landed',
        reason: `reader git-subjects failed: no default-branch subjects in ${SIBLING}`,
      }),
    ])
  })

  it('never reads a repo marked git: false, and dispatches past it', () => {
    const seatFile = path.join(root, 'seats', 'seat-a.md')
    fs.writeFileSync(
      seatFile,
      fs
        .readFileSync(seatFile, 'utf8')
        .replace(
          'concurrency:',
          `  - {path: ${NON_GIT}, git: false, initiatives: [init-alpha]}\nconcurrency:`,
        ),
    )
    const read: string[] = []

    const planned = plan({}, NON_GIT, read)

    expect(planned.refusals).toEqual([])
    expect(planned.dispatch.map(d => d.task)).toEqual(['AA-1'])
    expect(read).not.toContain(NON_GIT)
    expect(read).toContain(SIBLING)
  })
})
