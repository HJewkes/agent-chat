import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_LEDGER, type Ledger } from '../agents/burndown/ledger.js'
import { loadSeats, planSeats, type SeatTickDeps } from '../agents/burndown/seat-tick.js'
import { readInitiatives } from '../agents/burndown/source.js'

/** CC-1128 b: the tick reads the seat's `plan_file`, and its section 2 ids pass the scope filter. */

const AUTONOMY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'autonomy-2026-09-29')
const NOW = new Date(2026, 8, 29, 10)
const PLAN =
  '# Plan\n\n## 1. Context\n\nAA-2 is context.\n\n## 2. Priority order\n\n| P1 | AA-1 |\n\n## 3. Later\n'

describe('planSeats over the seat plan_file', () => {
  let base: string
  let root: string
  const runStart = NOW.getTime() - 3_600_000
  const ledger: Ledger = {
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
  const deps = (): SeatTickDeps => ({
    autonomyRoot: root,
    root,
    now: NOW,
    reading: () => ({ reading: { sevenDay: 40, fiveHour: 10, ageSeconds: 30 } }),
    meters: () => ({ run: { since: runStart, last: 40, spent: 0 } }),
  })

  const addTask = (id: string, tags: string[]) =>
    fs.writeFileSync(
      path.join(root, 'init-alpha', 'tasks', `${id}.yml`),
      `id: ${id}\ntitle: task ${id}\npriority: 5\nseverity: high\nestimate: 2\n` +
        `done_when: The widget renders.\nstatus: open\ntags: [${tags.join(', ')}]\nnotes: ''\n` +
        'created: 2026-09-01\nupdated: 2026-09-20\ndone_at: null\n',
    )

  /** seat-a scoped to `lane:a`, sharing init-alpha with seat-b so scope narrowing applies. */
  const scopeSeats = (planFile: string) => {
    const seats = path.join(root, 'seats')
    const seatA = fs.readFileSync(path.join(seats, 'seat-a.md'), 'utf8')
    fs.writeFileSync(
      path.join(seats, 'seat-a.md'),
      seatA.replace(
        'unclaimed_engineering:',
        `scope_tags: [lane:a]\nplan_file: ${planFile}\nunclaimed_engineering:`,
      ),
    )
    const seatB = fs.readFileSync(path.join(seats, 'seat-b.md'), 'utf8')
    fs.writeFileSync(
      path.join(seats, 'seat-b.md'),
      seatB.replace('initiatives:\n', 'initiatives:\n  init-alpha: 0.5\n'),
    )
  }

  const run = () => {
    const { loaded, skipped } = loadSeats(['seat-a'], ledger, deps())
    expect(skipped).toEqual([])
    return planSeats(loaded, { ledger, initiatives: readInitiatives(root), scopeTagAliases: {} }, root)
  }
  const outOfScope = (plan: ReturnType<typeof run>) =>
    plan.refusals.filter(r => r.kind === 'out-of-scope').map(r => r.task)

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-plan-scope-'))
    root = path.join(base, 'autonomy')
    fs.cpSync(AUTONOMY, root, { recursive: true })
    fs.mkdirSync(path.join(root, 'init-alpha', 'tasks'), { recursive: true })
    fs.writeFileSync(path.join(root, 'init-alpha', 'brief.md'), '---\nstate: active\nrank: 1\n---\n')
    addTask('AA-1', [])
    addTask('AA-2', [])
  })

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('passes an untagged plan id and still refuses an untagged id the plan does not name', () => {
    fs.writeFileSync(path.join(root, 'plan.md'), PLAN)
    scopeSeats('plan.md')

    const plan = run()

    expect(plan.dispatch.map(d => d.task)).toEqual(['AA-1'])
    expect(outOfScope(plan)).toEqual(['AA-2'])
    expect([...(plan.outcomes[0]?.plan ?? [])]).toEqual(['AA-1'])
  })

  it('passes a task whose parent: tag names a plan id', () => {
    fs.writeFileSync(path.join(root, 'plan.md'), PLAN)
    scopeSeats('plan.md')
    addTask('AA-3', ['parent:AA-1'])

    expect(outOfScope(run())).toEqual(['AA-2'])
  })

  it('resolves plan_file against the autonomy root, not the working directory', () => {
    fs.writeFileSync(path.join(base, 'plan.md'), PLAN)
    scopeSeats('../plan.md')

    const plan = run()

    expect(outOfScope(plan)).toEqual(['AA-2'])
    expect(plan.notes.filter(n => n.startsWith('plan '))).toEqual([])
  })

  it('reads an absolute plan_file as given', () => {
    fs.writeFileSync(path.join(base, 'plan.md'), PLAN)
    scopeSeats(path.join(base, 'plan.md'))

    expect(outOfScope(run())).toEqual(['AA-2'])
  })

  it('degrades a missing plan file to tag-only scope with one note and no refusal', () => {
    scopeSeats('missing.md')

    const plan = run()

    expect(outOfScope(plan)).toEqual(['AA-1', 'AA-2'])
    expect(plan.refusals.filter(r => r.kind === 'plan-blocked')).toEqual([])
    expect(plan.notes.filter(n => /^plan .*tag-only/.test(n))).toEqual([
      expect.stringContaining('plan missing.md: '),
    ])
    expect(plan.outcomes[0]?.plan).toBeUndefined()
  })

  it('degrades a plan file without a section 2 to tag-only scope with a note', () => {
    fs.writeFileSync(path.join(root, 'plan.md'), '# Plan\n\n## 1. Context\n\nAA-1\n')
    scopeSeats('plan.md')

    const plan = run()

    expect(outOfScope(plan)).toEqual(['AA-1', 'AA-2'])
    expect(plan.notes).toContain('plan plan.md: no "## 2." section; scope is tag-only')
  })
})
