import { describe, expect, it } from 'vitest'
import { describeUnnamedCriterion, unnamedCriteria } from '../agents/burndown/ms-role.js'
import { parseMilestoneFile } from '../agents/burndown/milestones.js'
import { parseTaskTags } from '../agents/burndown/task-tags.js'

/** CC-720: the `ms-role:` tag and the criterion lint, over synthetic tasks. */

const parse = (tags: string[]) => parseTaskTags({ id: 'EX-1', tags })

describe('ms-role tag', () => {
  it.each([
    { tags: ['ms-role:criterion'], role: 'criterion' },
    { tags: ['ms-role:output'], role: 'output' },
    { tags: ['ms-role:output', 'ms-role:output'], role: 'output', code: 'duplicate-ms-role' },
    { tags: ['ms-role:output', 'ms-role:criterion'], role: 'output', code: 'duplicate-ms-role' },
    { tags: ['ms-role:bogus'], role: undefined, code: 'unknown-ms-role' },
    { tags: ['ms-role:'], role: undefined, code: 'empty-value' },
    { tags: [], role: undefined },
  ])('$tags', ({ tags, role, code }) => {
    const { task, errors } = parse(tags)
    expect(task.msRole).toBe(role)
    expect(errors.map(e => e.code)).toEqual(code ? [code] : [])
  })
})

const file = (check: string) =>
  parseMilestoneFile(
    `week: 2030-W01\nappetite_days: 5\nmilestones:\n  - id: M1\n    rank: 1\n    seat: s\n    done_when:\n      - kind: tasks-done\n        ${check}\n`,
    ['EX-1', 'EX-9'],
  )

describe('unnamedCriteria', () => {
  const tagged = (tags: string[]) => [parseTaskTags({ id: 'EX-1', tags }).task]
  it.each([
    { name: 'named directly', check: 'tasks: [EX-1]', tags: ['milestone:M1', 'ms-role:criterion'], out: [] },
    {
      name: 'named through its epic',
      check: 'epics: [EX-9]',
      tags: ['milestone:M1', 'epic:EX-9', 'ms-role:criterion'],
      out: [],
    },
    {
      name: 'named by no check',
      check: 'tasks: [EX-2]',
      tags: ['milestone:M1', 'ms-role:criterion'],
      out: [{ task: 'EX-1', milestone: 'M1' }],
    },
    {
      name: 'no milestone tag',
      check: 'tasks: [EX-1]',
      tags: ['ms-role:criterion'],
      out: [{ task: 'EX-1' }],
    },
    {
      name: 'an output task is not linted',
      check: 'tasks: [EX-2]',
      tags: ['milestone:M1', 'ms-role:output'],
      out: [],
    },
  ])('$name', ({ check, tags, out }) => {
    const result = file(check)
    expect(result.errors).toEqual([])
    expect(unnamedCriteria(tagged(tags), result.file?.milestones ?? [])).toEqual(out)
  })

  it('describes one line per task', () => {
    expect(describeUnnamedCriterion({ task: 'EX-1', milestone: 'M1' })).toBe(
      'unnamed-criterion EX-1 milestone:M1',
    )
    expect(describeUnnamedCriterion({ task: 'EX-1' })).toBe('unnamed-criterion EX-1 no milestone')
  })
})

describe('check ids that are not lists', () => {
  it.each(['tasks: EX-1', 'epics: 5', 'tasks: [EX-1, 2]'])(
    '%s is an error naming the check, not a schema failure',
    check => {
      const result = file(check)
      expect(result.file).toBeDefined()
      expect(result.errors).toEqual([
        { code: 'bad-check-ids', milestone: 'M1', id: `tasks-done[0].${check.split(':')[0]}` },
      ])
    },
  )
})
