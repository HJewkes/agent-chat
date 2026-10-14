import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Refusal, Task } from '../agents/burndown/eligibility.js'
import { isOffPlan, readOffPlanIds } from '../agents/burndown/off-plan.js'
import { renderClassFile } from '../agents/burndown/plan-class.js'
import { offPlanRefusals, planningCandidates } from '../agents/burndown/planning-supply.js'
import { parseTask } from '../agents/burndown/source.js'

/** CC-1112: one predicate decides which tasks the briefers refuse. */

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const reviewDir = (files: Record<string, string>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'off-plan-'))
  dirs.push(root)
  const dir = path.join(root, 'claude-channels', 'sources', 'factory-review')
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text)
  return root
}

describe('isOffPlan', () => {
  const task = (id: string, priority: number, notes?: string): Pick<Task, 'id' | 'priority' | 'notes'> =>
    notes === undefined ? { id, priority } : { id, priority, notes }

  it('flags the plan note in any case', () => {
    const notes = 'Triage: Outside Accepted Factory Plan P-list.'
    expect(isOffPlan(task('X-1', 5, notes))).toBe(true)
  })

  it('leaves a fresh task at a default priority on plan', () => {
    expect(isOffPlan(task('X-1', 1842))).toBe(false)
  })

  it('leaves a triage-ranked 99 without the marker on plan', () => {
    expect(isOffPlan(task('X-1', 99))).toBe(false)
  })

  it('flags the notes marker at any priority', () => {
    const notes = 'outside accepted factory plan P-list'
    expect(isOffPlan(task('X-1', 1, notes))).toBe(true)
    expect(isOffPlan(task('X-1', 1842, notes))).toBe(true)
  })

  it('flags a listed id at a default priority', () => {
    expect(isOffPlan(task('X-1', 1842), new Set(['X-1']))).toBe(true)
  })

  it('flags an id the file listed and leaves an unlisted one', () => {
    expect(isOffPlan(task('X-1', 5), new Set(['X-1']))).toBe(true)
    expect(isOffPlan(task('X-2', 5), new Set(['X-1']))).toBe(false)
  })
})

describe('readOffPlanIds', () => {
  it('reads the ids of the newest file only', () => {
    const root = reviewDir({
      'off-plan-2026-10-01.md': '- X-1\n- X-2\n',
      'off-plan-2026-10-09.md': '- X-3 and X-4\n',
    })
    expect([...readOffPlanIds(root)].sort()).toEqual(['X-3', 'X-4'])
  })

  it('reads only the off and ambiguous rows of a plan-class v1 file', () => {
    const v1 = renderClassFile('classes', [
      { class: 'on', id: 'X-1', initiative: 'a', detail: 'P3', ask: '-' },
      { class: 'off', id: 'X-2', initiative: 'a', detail: 'no section-2 id or link', ask: '-' },
      { class: 'ambiguous', id: 'X-3', initiative: 'a', detail: 'mentions X-1', ask: 'm-1' },
    ])
    const root = reviewDir({ 'off-plan-2026-10-13.md': v1 })
    expect([...readOffPlanIds(root)].sort()).toEqual(['X-2', 'X-3'])
  })

  it('still reads every id of a legacy file, the dependency column included', () => {
    const root = reviewDir({ 'off-plan-2026-10-12.md': 'claude-channels|CC-1026|seat env|CC-1025\n' })
    expect([...readOffPlanIds(root)].sort()).toEqual(['CC-1025', 'CC-1026'])
  })

  it('returns no ids when the file or directory is missing', () => {
    expect(readOffPlanIds(reviewDir({})).size).toBe(0)
    expect(readOffPlanIds(path.join(os.tmpdir(), 'no-such-root-cc1112')).size).toBe(0)
  })
})

describe('parseTask', () => {
  it('reads folded notes', () => {
    const folded = 'id: X-1\ntitle: t\nnotes: "outside accepted factory\n  plan P-list"\n'
    expect(isOffPlan(parseTask(folded, 'X-1'))).toBe(true)
  })
})

describe('briefer selection', () => {
  const refusal = (task: string): Refusal => ({ initiative: 'a', task, kind: 'no-brief', reason: 'no brief' })
  const tasks = new Map([
    [
      'a',
      [
        { id: 'X-1', tags: [], priority: 1842 },
        { id: 'X-2', tags: [], priority: 5, notes: 'outside accepted factory plan P-list' },
        { id: 'X-3', tags: [], priority: 5 },
        { id: 'X-4', tags: [], priority: 5 },
      ],
    ],
  ])
  const refusals = ['X-1', 'X-2', 'X-3', 'X-4'].map(refusal)

  it('offers only on-plan tasks to briefers', () => {
    const offered = planningCandidates(refusals, tasks, new Set(['X-4'])).map(r => r.task)
    expect(offered).toEqual(['X-1', 'X-3'])
  })

  it('names every off-plan refusal', () => {
    const named = offPlanRefusals(refusals, tasks, new Set(['X-4'])).map(r => r.task)
    expect(named).toEqual(['X-2', 'X-4'])
  })
})
