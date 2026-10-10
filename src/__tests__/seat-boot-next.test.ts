import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlannedRow } from '../agents/burndown/plan-order.js'
import type { ScoredTask } from '../agents/burndown/score.js'
import type { BootDeps } from '../agents/seats/boot.js'
import type { ReadySource } from '../agents/seats/boot-read.js'
import { bootReport } from '../cli/verbs/seats.js'

/** CC-935: `seats boot` prints the seat's `brief:ready` tasks in CC-926's order with their age. Every task is synthetic. */

const SEAT = 'sample-coord'
const SEAT_FILE = `---\nname: ${SEAT}\npool: pool-a\n---\n# ${SEAT}\n`
const QUEUE = `# Queue\n\n## Next\n\n1. hand-kept handover item\n`
const NOW = new Date(2026, 9, 10, 12, 0)

let tmp: string
let root: string

interface Fixture {
  id: string
  priority: number
  tags?: string[]
  score?: number
  tier?: PlannedRow['tier']
  title?: string
}

const row = (f: Fixture): PlannedRow =>
  ({
    id: f.id,
    initiative: 'init',
    score: f.score ?? 1,
    tier: f.tier ?? 3,
    title: f.title ?? `title ${f.id}`,
    components: { W: 1 },
  }) as PlannedRow

const task = (f: Fixture): ScoredTask => ({
  id: f.id,
  title: f.title ?? `title ${f.id}`,
  priority: f.priority,
  tags: f.tags ?? [],
  slug: 'init',
})

const source = (fixtures: Fixture[]): ReadySource => ({
  order: fixtures.map(row),
  tasks: fixtures.map(task),
})

const deps = (ready: BootDeps['ready']): BootDeps => ({
  now: () => NOW,
  autonomyRoot: root,
  homeDir: tmp,
  eventsDb: path.join(tmp, 'events.db'),
  status: async () => {
    throw new Error('no broker')
  },
  inFlight: {
    roster: async () => [],
    shepherd: async () => [],
    verdicts: async () => [],
    claims: async () => [],
  },
  ready,
})

async function nextSection(ready: BootDeps['ready']): Promise<string[]> {
  const report = await bootReport(deps(ready), SEAT, undefined, false)
  expect(report.ok).toBe(true)
  const lines = report.lines
  const start = lines.indexOf('== next: brief:ready tasks, ranked')
  const end = lines.findIndex((line, i) => i > start && line.startsWith('== '))
  return lines.slice(start + 1, end)
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-boot-next-')))
  root = path.join(tmp, 'autonomy')
  fs.mkdirSync(path.join(root, 'seats'), { recursive: true })
  fs.mkdirSync(path.join(root, 'queues'), { recursive: true })
  fs.writeFileSync(path.join(root, 'seats', `${SEAT}.md`), SEAT_FILE)
  fs.writeFileSync(path.join(root, 'queues', `${SEAT}.md`), QUEUE)
})

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('seats boot Next (CC-935)', () => {
  it('lists ready tasks in the ready order with their age, leaving out tasks without a valid brief', async () => {
    const lines = await nextSection(async () =>
      source([
        { id: 'T-1', priority: 3, score: 9, tags: ['brief:ready=2026-10-09'] },
        { id: 'T-2', priority: 1, score: 1, tags: ['brief:ready=2026-10-03'] },
        { id: 'T-3', priority: 1, score: 5, tags: ['brief:ready=2026-10-10'] },
        { id: 'T-4', priority: 0, score: 9, tags: [] },
        { id: 'T-5', priority: 0, score: 9, tags: ['brief:ready'] },
        { id: 'T-6', priority: 4, tier: 0, tags: ['brief:ready=2026-10-08'] },
      ]),
    )

    expect(lines).toEqual([
      'T-6  p4  2d  title T-6',
      'T-3  p1  0d  title T-3',
      'T-2  p1  7d  title T-2',
      'T-1  p3  1d  title T-1',
    ])
  })

  it('shows the first ten with a count of the rest and cuts long titles', async () => {
    const fixtures = Array.from({ length: 13 }, (_, i) => ({
      id: `T-${String(i).padStart(2, '0')}`,
      priority: 2,
      tags: ['brief:ready=2026-10-10'],
      title: 'x'.repeat(80),
    }))

    const lines = await nextSection(async () => source(fixtures))

    expect(lines).toHaveLength(11)
    expect(lines[0]).toBe(`T-00  p2  0d  ${'x'.repeat(59)}…`)
    expect(lines[10]).toBe('+3 more')
  })

  it('prints one unavailable line when the tasks cannot be read and keeps the queue Next', async () => {
    const report = await bootReport(
      deps(async () => {
        throw new Error('no task dir')
      }),
      SEAT,
      undefined,
      false,
    )

    const at = report.lines.indexOf('== next: brief:ready tasks, ranked')
    expect(report.lines[at + 1]).toBe('unavailable: tasks')
    expect(report.lines[at + 2]).toMatch(/^== queue /)
    expect(report.lines).toContain('1. hand-kept handover item')
  })

  it('says so when no task is brief-ready', async () => {
    expect(await nextSection(async () => source([{ id: 'T-1', priority: 1 }]))).toEqual([
      'next: none brief:ready',
    ])
  })
})
