import { describe, expect, it } from 'vitest'
import { parsePlanningTasks, parseTaskTags, type TagError } from '../agents/burndown/task-tags.js'

/** CC-626: the `milestone:`, `epic:`, `dep:`, `cos:` and `due:` tag parser over synthetic tasks. */

describe('valid planning tags', () => {
  it.each([
    { name: 'no tags at all', tags: [], expected: { deps: [], cos: 'standard' } },
    {
      name: 'unrelated tags left alone',
      tags: ['wave:0', 'needs-owner'],
      expected: { deps: [], cos: 'standard' },
    },
    {
      name: 'milestone and epic',
      tags: ['milestone:M1', 'epic:EX-10'],
      expected: { milestone: 'M1', epic: 'EX-10', deps: [], cos: 'standard' },
    },
    {
      name: 'one dep per tag, deduplicated in order',
      tags: ['dep:EX-2', 'dep:EX-1', 'dep:EX-2'],
      expected: { deps: ['EX-2', 'EX-1'], cos: 'standard' },
    },
    { name: 'cos:expedite', tags: ['cos:expedite'], expected: { deps: [], cos: 'expedite' } },
    { name: 'cos:intangible', tags: ['cos:intangible'], expected: { deps: [], cos: 'intangible' } },
    {
      name: 'cos:fixed with a due date',
      tags: ['cos:fixed', 'due:2030-01-09'],
      expected: { deps: [], cos: 'fixed', due: '2030-01-09' },
    },
    {
      name: 'a due date without cos:fixed',
      tags: ['due:2030-01-09'],
      expected: { deps: [], cos: 'standard', due: '2030-01-09' },
    },
    {
      name: 'a brief:ready day, other brief: tags left alone',
      tags: ['brief:ready=2026-10-01', 'brief:wanted'],
      expected: { deps: [], cos: 'standard', briefReady: '2026-10-01' },
    },
    {
      name: 'the same single tag twice',
      tags: ['milestone:M1', 'milestone:M1'],
      expected: { milestone: 'M1', deps: [], cos: 'standard' },
    },
  ])('$name', ({ tags, expected }) => {
    const result = parseTaskTags({ id: 'EX-1', estimate: 2, tags })

    expect(result.errors).toEqual([])
    expect(result.task).toEqual({ id: 'EX-1', estimate: 2, ...expected })
  })

  it('omits a missing or null estimate', () => {
    expect(parseTaskTags({ id: 'EX-1', estimate: null, tags: null }).task).toEqual({
      id: 'EX-1',
      deps: [],
      cos: 'standard',
    })
  })
})

describe('malformed planning tags', () => {
  it.each<{ name: string; tags: string[]; errors: Omit<TagError, 'task'>[] }>([
    {
      name: 'milestone: with no id',
      tags: ['milestone:'],
      errors: [{ code: 'empty-value', tag: 'milestone:' }],
    },
    { name: 'epic: with only spaces', tags: ['epic:  '], errors: [{ code: 'empty-value', tag: 'epic:  ' }] },
    { name: 'dep: with no id', tags: ['dep:'], errors: [{ code: 'empty-value', tag: 'dep:' }] },
    {
      name: 'an unknown class of service',
      tags: ['cos:rush'],
      errors: [{ code: 'unknown-cos', tag: 'cos:rush' }],
    },
    {
      name: 'a class of service in the wrong case',
      tags: ['cos:Fixed'],
      errors: [{ code: 'unknown-cos', tag: 'cos:Fixed' }],
    },
    {
      name: 'a due date that is not ISO',
      tags: ['due:09/01/2030'],
      errors: [{ code: 'bad-due', tag: 'due:09/01/2030' }],
    },
    {
      name: 'an impossible due date',
      tags: ['due:2030-02-30'],
      errors: [{ code: 'bad-due', tag: 'due:2030-02-30' }],
    },
    {
      name: 'cos:fixed with no due date',
      tags: ['cos:fixed'],
      errors: [{ code: 'fixed-without-due', tag: 'cos:fixed' }],
    },
    {
      name: 'cos:fixed with a bad due date reports only the date',
      tags: ['cos:fixed', 'due:soon'],
      errors: [{ code: 'bad-due', tag: 'due:soon' }],
    },
    {
      name: 'a brief:ready day that is not ISO',
      tags: ['brief:ready=10/01/2026'],
      errors: [{ code: 'bad-tag', tag: 'brief:ready=10/01/2026' }],
    },
    {
      name: 'an impossible brief:ready day',
      tags: ['brief:ready=2026-02-30'],
      errors: [{ code: 'bad-tag', tag: 'brief:ready=2026-02-30' }],
    },
    {
      name: 'brief:ready with no day',
      tags: ['brief:ready'],
      errors: [{ code: 'bad-tag', tag: 'brief:ready' }],
    },
    {
      name: 'two different brief:ready days',
      tags: ['brief:ready=2026-10-01', 'brief:ready=2026-10-02'],
      errors: [{ code: 'conflicting-tag', tag: 'brief:ready=2026-10-02' }],
    },
    {
      name: 'two different milestones',
      tags: ['milestone:M1', 'milestone:M2'],
      errors: [{ code: 'conflicting-tag', tag: 'milestone:M2' }],
    },
  ])('$name', ({ tags, errors }) => {
    const result = parseTaskTags({ id: 'EX-1', tags })

    expect(result.errors).toEqual(errors.map(e => ({ ...e, task: 'EX-1' })))
  })

  it('reads no briefReady from a malformed brief:ready tag', () => {
    expect(parseTaskTags({ id: 'EX-1', tags: ['brief:ready=soon'] }).task).not.toHaveProperty('briefReady')
  })

  it('keeps the first value of a conflicting tag', () => {
    expect(parseTaskTags({ id: 'EX-1', tags: ['cos:expedite', 'cos:intangible'] }).task.cos).toBe('expedite')
  })

  it('reports a null tag as bad-tag instead of throwing, and reads the rest', () => {
    const result = parseTaskTags({ id: 'EX-1', tags: [null, 'milestone:M1'] })

    expect(result.errors).toEqual([{ code: 'bad-tag', task: 'EX-1', tag: 'null' }])
    expect(result.task.milestone).toBe('M1')
  })

  it.each([NaN, Infinity, -1])('rejects estimate %s as bad-estimate and drops it', estimate => {
    const result = parseTaskTags({ id: 'EX-1', estimate, tags: [] })

    expect(result.errors).toEqual([{ code: 'bad-estimate', task: 'EX-1', tag: `estimate:${estimate}` }])
    expect(result.task).not.toHaveProperty('estimate')
  })

  it('carries a bad estimate through parsePlanningTasks', () => {
    expect(parsePlanningTasks([{ id: 'EX-1', estimate: NaN }]).errors).toEqual([
      { code: 'bad-estimate', task: 'EX-1', tag: 'estimate:NaN' },
    ])
  })
})

describe('dep: edges across the task list', () => {
  const tasks = [
    { id: 'EX-1', estimate: 3, tags: ['milestone:M1'] },
    { id: 'EX-2', estimate: 2, tags: ['milestone:M1', 'dep:EX-1'] },
  ]

  it.each<{ name: string; tags: string[]; otherIds: string[]; errors: TagError[] }>([
    { name: 'a dep on a listed task', tags: ['dep:EX-2'], otherIds: [], errors: [] },
    {
      name: 'a dep on a task outside the list but known',
      tags: ['dep:EX-0'],
      otherIds: ['EX-0'],
      errors: [],
    },
    {
      name: 'a dep on a missing task',
      tags: ['dep:EX-404'],
      otherIds: [],
      errors: [{ code: 'unknown-dep', task: 'EX-3', tag: 'dep:EX-404' }],
    },
    {
      name: 'a malformed tag and a missing dep together',
      tags: ['cos:rush', 'dep:EX-404'],
      otherIds: [],
      errors: [
        { code: 'unknown-cos', task: 'EX-3', tag: 'cos:rush' },
        { code: 'unknown-dep', task: 'EX-3', tag: 'dep:EX-404' },
      ],
    },
  ])('$name', ({ tags, otherIds, errors }) => {
    const result = parsePlanningTasks([...tasks, { id: 'EX-3', estimate: 1, tags }], otherIds)

    expect(result.errors).toEqual(errors)
    expect(result.tasks.map(t => t.id)).toEqual(['EX-1', 'EX-2', 'EX-3'])
  })

  it('carries the estimate and edges a critical-path pass needs', () => {
    expect(parsePlanningTasks(tasks).tasks[1]).toEqual({
      id: 'EX-2',
      estimate: 2,
      milestone: 'M1',
      deps: ['EX-1'],
      cos: 'standard',
    })
  })
})
