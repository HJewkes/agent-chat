import { describe, expect, it } from 'vitest'
import { criticalPath } from '../agents/burndown/critical-path.js'
import type { TaggedTask } from '../agents/burndown/task-tags.js'

/** CC-627: total float, the critical path and the cycle report over synthetic tasks. */

const T = (id: string, estimate: number | undefined, deps: string[] = [], milestone = 'M1'): TaggedTask => ({
  id,
  ...(estimate !== undefined && { estimate }),
  milestone,
  deps,
  cos: 'standard',
})

const floatsOf = (tasks: TaggedTask[], milestone?: string) =>
  Object.fromEntries(criticalPath(tasks, milestone).tasks.map(t => [t.id, t.float]))

describe('total float', () => {
  it.each<{
    name: string
    tasks: TaggedTask[]
    floats: Record<string, number>
    path: string[]
    length: number
  }>([
    {
      name: 'a linear chain is all critical',
      tasks: [T('EX-1', 2), T('EX-2', 3, ['EX-1']), T('EX-3', 1, ['EX-2'])],
      floats: { 'EX-1': 0, 'EX-2': 0, 'EX-3': 0 },
      path: ['EX-1', 'EX-2', 'EX-3'],
      length: 6,
    },
    {
      name: 'a diamond gives the short branch positive float',
      tasks: [T('EX-1', 1), T('EX-2', 3, ['EX-1']), T('EX-3', 1, ['EX-1']), T('EX-4', 2, ['EX-2', 'EX-3'])],
      floats: { 'EX-1': 0, 'EX-2': 0, 'EX-3': 2, 'EX-4': 0 },
      path: ['EX-1', 'EX-2', 'EX-4'],
      length: 6,
    },
    {
      name: 'independent tasks float against the longest',
      tasks: [T('EX-1', 1), T('EX-2', 3)],
      floats: { 'EX-1': 2, 'EX-2': 0 },
      path: ['EX-2'],
      length: 3,
    },
    {
      name: 'fractional estimates leave no rounding error',
      tasks: [T('EX-1', 0.1), T('EX-2', 0.2, ['EX-1']), T('EX-3', 0.3)],
      floats: { 'EX-1': 0, 'EX-2': 0, 'EX-3': 0 },
      path: ['EX-1', 'EX-3', 'EX-2'],
      length: 0.3,
    },
    { name: 'an empty input', tasks: [], floats: {}, path: [], length: 0 },
  ])('$name', ({ tasks, floats, path, length }) => {
    const result = criticalPath(tasks)

    expect(floatsOf(tasks)).toEqual(floats)
    expect(result.criticalPath).toEqual(path)
    expect(result.length).toBe(length)
    expect(result.cycles).toEqual([])
  })

  it('reports early and late start and finish for a task with float', () => {
    const tasks = [
      T('EX-1', 1),
      T('EX-2', 3, ['EX-1']),
      T('EX-3', 1, ['EX-1']),
      T('EX-4', 2, ['EX-2', 'EX-3']),
    ]

    expect(criticalPath(tasks).tasks.find(t => t.id === 'EX-3')).toEqual({
      id: 'EX-3',
      duration: 1,
      earlyStart: 1,
      earlyFinish: 2,
      lateStart: 3,
      lateFinish: 4,
      float: 2,
    })
  })
})

describe('cycles', () => {
  it.each<{ name: string; tasks: TaggedTask[]; cycles: string[][]; floats: Record<string, number> }>([
    {
      name: 'a two-task cycle',
      tasks: [T('EX-1', 2), T('EX-2', 1, ['EX-3']), T('EX-3', 1, ['EX-2']), T('EX-4', 1)],
      cycles: [['EX-2', 'EX-3']],
      floats: { 'EX-1': 0, 'EX-4': 1 },
    },
    {
      name: 'a three-task cycle with a task after it',
      tasks: [T('EX-1', 1, ['EX-3']), T('EX-2', 1, ['EX-1']), T('EX-3', 1, ['EX-2']), T('EX-4', 2, ['EX-3'])],
      cycles: [['EX-1', 'EX-2', 'EX-3']],
      floats: { 'EX-4': 0 },
    },
    {
      name: 'a task depending on itself',
      tasks: [T('EX-1', 1, ['EX-1']), T('EX-2', 1)],
      cycles: [['EX-1']],
      floats: { 'EX-2': 0 },
    },
    {
      name: 'two separate cycles',
      tasks: [T('EX-1', 1, ['EX-2']), T('EX-2', 1, ['EX-1']), T('EX-3', 1, ['EX-4']), T('EX-4', 1, ['EX-3'])],
      cycles: [
        ['EX-1', 'EX-2'],
        ['EX-3', 'EX-4'],
      ],
      floats: {},
    },
  ])('reports $name without throwing and still floats the rest', ({ tasks, cycles, floats }) => {
    expect(criticalPath(tasks).cycles).toEqual(cycles)
    expect(floatsOf(tasks)).toEqual(floats)
  })
})

describe('dependencies outside the milestone', () => {
  it('treats a dep on another milestone as satisfied and reports it', () => {
    const tasks = [T('EX-1', 5, [], 'M2'), T('EX-2', 1, ['EX-1']), T('EX-3', 2)]

    const result = criticalPath(tasks, 'M1')

    expect(floatsOf(tasks, 'M1')).toEqual({ 'EX-2': 1, 'EX-3': 0 })
    expect(result.externalDeps).toEqual([{ task: 'EX-2', dep: 'EX-1' }])
    expect(result.length).toBe(2)
  })

  it('treats a dep on a closed or unknown task as satisfied', () => {
    const result = criticalPath([T('EX-1', 1, ['EX-90']), T('EX-2', 1, ['EX-1'])])

    expect(result.criticalPath).toEqual(['EX-1', 'EX-2'])
    expect(result.externalDeps).toEqual([{ task: 'EX-1', dep: 'EX-90' }])
  })

  it('takes every task when no milestone is named', () => {
    expect(floatsOf([T('EX-1', 1, [], 'M2'), T('EX-2', 1, ['EX-1'])])).toEqual({ 'EX-1': 0, 'EX-2': 0 })
  })
})

describe('estimates', () => {
  it.each([
    { name: 'missing', estimate: undefined },
    { name: 'NaN', estimate: Number.NaN },
    { name: 'infinite', estimate: Number.POSITIVE_INFINITY },
    { name: 'negative', estimate: -2 },
  ])('a $name estimate is duration 0 and reported', ({ estimate }) => {
    const result = criticalPath([T('EX-1', 2), T('EX-2', estimate, ['EX-1']), T('EX-3', 1, ['EX-2'])])

    expect(result.tasks.find(t => t.id === 'EX-2')?.duration).toBe(0)
    expect(result.criticalPath).toEqual(['EX-1', 'EX-2', 'EX-3'])
    expect(result.length).toBe(3)
    expect(result.unestimated).toEqual(['EX-2'])
  })

  it('keeps the first of two tasks with one id', () => {
    const result = criticalPath([T('EX-1', 2), T('EX-1', 9)])

    expect(result.tasks.map(t => t.duration)).toEqual([2])
  })
})
