import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseMilestoneFile, type MilestoneError } from '../agents/burndown/milestones.js'

/** CC-626: the milestone file loader over a synthetic fixture and inline variants. */

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'milestones',
  '2030-W01.yml',
)
const VALID = fs.readFileSync(FIXTURE, 'utf8')
const TASK_IDS = ['EX-10', 'EX-20', 'EX-30']

const file = (milestones: string) => `week: 2030-W01\nappetite_days: 7\nmilestones:\n${milestones}`

describe('a valid milestone file', () => {
  it('loads every milestone by rank with its epics, checks and gate', () => {
    const result = parseMilestoneFile(VALID, TASK_IDS)

    expect(result.errors).toEqual([])
    expect(result.file?.week).toBe('2030-W01')
    expect(result.file?.appetiteDays).toBe(7)
    expect(result.file?.milestones.map(m => m.id)).toEqual(['M1', 'M2', 'M3'])
    expect(result.file?.milestones[0]).toEqual({
      id: 'M1',
      rank: 1,
      seat: 'seat-a',
      epics: ['EX-10', 'EX-20'],
      doneWhen: [
        { kind: 'tasks-done', epic: 'EX-10', tag: 'wave:0' },
        { kind: 'metric', name: 'sample_share', window: 20, min: 0.9 },
      ],
    })
  })

  it('defaults a milestone with no epics or checks to empty lists', () => {
    const m3 = parseMilestoneFile(VALID, TASK_IDS).file?.milestones[2]

    expect(m3?.epics).toEqual([])
    expect(m3?.doneWhen).toEqual([])
  })
})

describe('gated milestones', () => {
  it.each([
    { name: 'gate open while its milestone is not done', done: [], state: 'open' },
    { name: 'gate closed once its milestone is done', done: ['M2'], state: 'closed' },
    { name: 'gate unaffected by another milestone being done', done: ['M1'], state: 'open' },
  ])('$name', ({ done, state }) => {
    const result = parseMilestoneFile(VALID, TASK_IDS, done)

    expect(result.errors).toEqual([])
    expect(result.file?.milestones.find(m => m.id === 'M3')?.gate).toEqual({ by: 'M2', state })
  })

  it('leaves an ungated milestone without a gate', () => {
    expect(parseMilestoneFile(VALID, TASK_IDS).file?.milestones[0]).not.toHaveProperty('gate')
  })
})

const M = (id: string, rank: number, extra = '') => `  - { id: ${id}, rank: ${rank}, seat: s${extra} }\n`

describe('semantic errors', () => {
  it.each<{ name: string; yaml: string; errors: MilestoneError[] }>([
    {
      name: 'an epic that is not a task',
      yaml: file(M('M1', 1, ', epics: [EX-10, EX-99]')),
      errors: [{ code: 'unknown-epic', milestone: 'M1', id: 'EX-99' }],
    },
    {
      name: 'a gate naming no milestone',
      yaml: file(M('M1', 1, ', gated_by: M9')),
      errors: [{ code: 'unknown-gate', milestone: 'M1', id: 'M9' }],
    },
    {
      name: 'a milestone gated by itself',
      yaml: file(M('M1', 1, ', gated_by: M1')),
      errors: [{ code: 'gate-cycle', milestone: 'M1', id: 'M1' }],
    },
    {
      name: 'two milestones gating each other',
      yaml: file(M('M1', 1, ', gated_by: M2') + M('M2', 2, ', gated_by: M1')),
      errors: [
        { code: 'gate-cycle', milestone: 'M1', id: 'M2' },
        { code: 'gate-cycle', milestone: 'M2', id: 'M1' },
      ],
    },
    {
      name: 'a repeated milestone id',
      yaml: file(M('M1', 1) + M('M1', 2)),
      errors: [{ code: 'duplicate-milestone', milestone: 'M1' }],
    },
    {
      name: 'two milestones sharing a rank',
      yaml: file(M('M1', 1) + M('M2', 1)),
      errors: [{ code: 'duplicate-rank', milestone: 'M2', id: '1', message: 'also M1' }],
    },
  ])('$name', ({ yaml, errors }) => {
    const result = parseMilestoneFile(yaml, TASK_IDS)

    expect(result.errors).toEqual(errors)
    expect(result.file).toBeDefined()
  })

  it('reports an unknown gate as open so the milestone yields nothing', () => {
    const result = parseMilestoneFile(file(M('M1', 1, ', gated_by: M9')), TASK_IDS)

    expect(result.file?.milestones[0]?.gate).toEqual({ by: 'M9', state: 'open' })
  })
})

describe('unreadable files', () => {
  it.each([
    { name: 'broken YAML', yaml: 'week: [2030-W01', code: 'yaml', id: undefined },
    {
      name: 'a malformed week',
      yaml: 'week: W01\nappetite_days: 7\nmilestones: []',
      code: 'schema',
      id: 'week',
    },
    {
      name: 'no milestones list',
      yaml: 'week: 2030-W01\nappetite_days: 7',
      code: 'schema',
      id: 'milestones',
    },
    {
      name: 'a milestone with no seat',
      yaml: file('  - { id: M1, rank: 1 }'),
      code: 'schema',
      id: 'milestones.0.seat',
    },
    {
      name: 'a check with no kind',
      yaml: file('  - { id: M1, rank: 1, seat: s, done_when: [{ name: x }] }'),
      code: 'schema',
      id: 'milestones.0.done_when.0.kind',
    },
    { name: 'a scalar document', yaml: 'just text', code: 'schema', id: '' },
    {
      name: 'a misspelt gated_by',
      yaml: file(M('M1', 1, ', gate_by: M2')),
      code: 'schema',
      id: 'milestones.0',
    },
    {
      name: 'a misspelt top-level key',
      yaml: `${file(M('M1', 1))}apetite_days: 7\n`,
      code: 'schema',
      id: '',
    },
  ])('$name returns a $code error and no file without throwing', ({ yaml, code, id }) => {
    const result = parseMilestoneFile(yaml, TASK_IDS)

    expect(result.file).toBeUndefined()
    expect(result.errors[0]).toMatchObject({ code, ...(id !== undefined && { id }) })
  })
})
