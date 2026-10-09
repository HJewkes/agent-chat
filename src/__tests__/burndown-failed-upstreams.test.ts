import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { failedUpstreamsOf } from '../agents/burndown/seat-plan.js'
import { loadSeats, planSeats, type SeatTickDeps } from '../agents/burndown/seat-tick.js'
import { renderPlan } from '../agents/burndown/tick.js'
import { readInitiatives } from '../agents/burndown/source.js'

/** CC-833: the seat plan blocks a dependent of a failed or released upstream as `upstream-failed`. */

const AUTONOMY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'autonomy-2026-09-29')
const NOW = new Date(2026, 8, 29, 10)
const RUN_START = NOW.getTime() - 3_600_000
const AT = '2026-09-29T07:00:00.000Z'

const claim = (taskId: string, patch: Partial<Claim>): Claim => ({
  taskId,
  initiative: 'init-alpha',
  seat: 'seat-a',
  namePrefix: 'sa',
  spawnedAt: AT,
  phase: 'implementing',
  phaseAt: AT,
  ...patch,
})

const ledgerWith = (claims: Claim[], ladder: Ledger['ladder'] = {}): Ledger => ({
  ...EMPTY_LEDGER,
  claims,
  ladder,
  seats: {
    'seat-a': {
      samples: [
        { at: new Date(2026, 8, 29, 6).getTime(), sevenDay: 38 },
        { at: RUN_START, sevenDay: 39 },
      ],
    },
  },
})

describe('burndown plan --seat behind a failed upstream', () => {
  let root: string

  const writeTask = (id: string, tags: string[], dir = 'tasks', status = 'open') => {
    fs.mkdirSync(path.join(root, 'init-alpha', dir), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'init-alpha', dir, `${id}.yml`),
      `id: ${id}\ntitle: task ${id}\npriority: 3\nseverity: high\nestimate: 2\n` +
        `done_when: The widget renders.\nstatus: ${status}\ntags: [${tags.join(', ')}]\nnotes: ''\n` +
        'created: 2026-09-01\nupdated: 2026-09-20\ndone_at: null\n',
    )
  }

  const deps = (): SeatTickDeps => ({
    autonomyRoot: root,
    root,
    now: NOW,
    reading: () => ({ reading: { sevenDay: 40, fiveHour: 10, ageSeconds: 30 } }),
    meters: () => ({ run: { since: RUN_START, last: 40, spent: 0 } }),
  })

  const planLines = (ledger: Ledger) => {
    const { loaded, skipped } = loadSeats(['seat-a'], ledger, deps())
    expect(skipped).toEqual([])
    const planned = planSeats(loaded, { ledger, initiatives: readInitiatives(root) }, root)
    const plan = { dispatch: planned.dispatch, refusals: planned.refusals, notOptedIn: [] }
    return { lines: renderPlan(plan, NOW), dispatched: planned.dispatch.map(d => d.task) }
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-failed-upstreams-'))
    fs.cpSync(AUTONOMY, root, { recursive: true })
    fs.mkdirSync(path.join(root, 'init-alpha'))
    fs.writeFileSync(path.join(root, 'init-alpha', 'brief.md'), '---\nstate: active\nrank: 1\n---\n')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('refuses a dependent of a failed-stall task as upstream-failed and does not dispatch it', () => {
    writeTask('AA-1', [])
    writeTask('AA-2', ['dep:AA-1'])
    const failed = claim('AA-1', {
      stalledReason: 'retry-spent: three attempts',
      stalledClass: 'failed',
      stallCode: 'retry-spent',
    })

    const { lines, dispatched } = planLines(ledgerWith([failed]))

    expect(dispatched).not.toContain('AA-2')
    expect(lines).toContain('refused init-alpha AA-2 [plan-blocked]: upstream-failed')
  })

  it('refuses a dependent of a released task as upstream-failed', () => {
    writeTask('AA-1', [])
    writeTask('AA-2', ['dep:AA-1'])
    const ladder = { 'AA-1#': { respawns: 1, lastAt: AT, releases: 1, code: 'no-progress' as const } }

    const { lines, dispatched } = planLines(ledgerWith([], ladder))

    expect(dispatched).not.toContain('AA-2')
    expect(lines).toContain('refused init-alpha AA-2 [plan-blocked]: upstream-failed')
  })

  it('leaves a dependent of a merged task free to dispatch', () => {
    writeTask('AA-1', [], path.join('tasks', 'archive'), 'done')
    writeTask('AA-2', ['dep:AA-1'])
    const merged = claim('AA-1', { phase: 'done', pr: 'https://example.invalid/pr/1' })
    const ladder = { 'AA-1#': { respawns: 0, lastAt: AT, releases: 1, code: 'no-progress' as const } }

    const { lines, dispatched } = planLines(ledgerWith([merged], ladder))

    expect(dispatched).toContain('AA-2')
    expect(lines.join('\n')).not.toContain('upstream-failed')
  })

  it('keeps a dependent of an open task dep-blocked, not upstream-failed', () => {
    writeTask('AA-1', [])
    writeTask('AA-2', ['dep:AA-1'])
    const running = claim('AA-1', {})

    const { lines, dispatched } = planLines(ledgerWith([running]))

    expect(dispatched).not.toContain('AA-2')
    expect(lines).toContain('refused init-alpha AA-2 [plan-blocked]: dep-blocked')
  })

  it('names each terminal upstream by its stall code and skips a stalled or requeued one', () => {
    const open = ['AA-1', 'AA-2', 'AA-3', 'AA-4'].map(id => ({ id }) as never)
    const ladder = {
      'AA-2#': { respawns: 1, lastAt: AT, releases: 1, code: 'lease-expired' as const },
      'AA-4#': { respawns: 1, lastAt: AT, releases: 1, code: 'no-progress' as const },
    }
    const claims = [
      claim('AA-1', { stalledReason: 'budget: spent', stalledClass: 'failed', stallCode: 'budget' }),
      claim('AA-3', {
        stalledReason: 'no-progress: idle',
        stalledClass: 'stalled',
        stallCode: 'no-progress',
      }),
      claim('AA-4', { phase: 'queued' }),
    ]

    expect(failedUpstreamsOf(ledgerWith(claims, ladder), open)).toEqual({
      'AA-1': 'budget',
      'AA-2': 'lease-expired',
    })
  })
})
