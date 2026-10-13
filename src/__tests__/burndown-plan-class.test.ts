import { describe, expect, it } from 'vitest'
import {
  classifyTask,
  type ClassRow,
  OFF_REASON,
  parseClassFile,
  PLAN_CLASS_MARKER,
  planIndex,
  renderClassFile,
} from '../agents/burndown/plan-class.js'

/** TP-2418: the plan-class v1 classifier and file format. */

const PLAN = [
  '# Factory plan',
  '',
  '## 1. Goals',
  '',
  'CC-500 is a goal, not a plan row.',
  '',
  '## 2. Priority order',
  '',
  '**Progress at 10-10.** P1: TP-1 merged, TP-9 reviewed. P3: TP-3 left, CC-1120 slices b to d.',
  '',
  '| P | Work | Tasks |',
  '|---|---|---|',
  '| P1 | **Review chain.** TP-1 then TP-2. | TP-1, TP-2 |',
  '| P3 | **Dispatch.** | TP-3, TP-9 |',
  '',
  'Unlabelled paragraph naming TP-7.',
  '',
  '## 3. Later',
  '',
  'TP-8 is out of section 2.',
].join('\n')

const index = planIndex(PLAN)!
const task = (
  id: string,
  extra: Partial<{ title: string; tags: string[]; notes: string; doneWhen: string }> = {},
) => ({
  id,
  title: extra.title ?? 'untitled',
  tags: extra.tags ?? [],
  ...(extra.notes === undefined ? {} : { notes: extra.notes }),
  ...(extra.doneWhen === undefined ? {} : { doneWhen: extra.doneWhen }),
})

describe('planIndex', () => {
  it('has no index for a plan without section 2', () => {
    expect(planIndex('# plan\n\n## 1. Goals\n\nTP-1\n')).toBeUndefined()
  })

  it('takes the ids between section 2 and the next heading only', () => {
    expect([...index.ids].sort()).toEqual(['CC-1120', 'TP-1', 'TP-2', 'TP-3', 'TP-7', 'TP-9'])
  })

  it('maps a paragraph-only id to the nearest preceding P label', () => {
    expect(index.rows.get('CC-1120')).toBe('P3')
  })
})

describe('classifyTask', () => {
  it('matches a task in a P table row to that row, not the progress paragraph before it', () => {
    expect(classifyTask(index, task('TP-9'))).toEqual({ class: 'on', detail: 'P3' })
  })

  it('matches a section-2 id under no P label as section-2', () => {
    expect(classifyTask(index, task('TP-7'))).toEqual({ class: 'on', detail: 'section-2' })
  })

  it('puts a task on plan through a parent link to a section-2 id', () => {
    const linked = task('TP-50', { tags: ['factory', 'parent:TP-9'] })
    expect(classifyTask(index, linked)).toEqual({ class: 'on', detail: 'P3 via parent:TP-9' })
  })

  it('marks a task ambiguous when its title only mentions a section-2 id', () => {
    const mention = task('CC-1300', { title: 'CC-1120 a-c: follow-up' })
    expect(classifyTask(index, mention)).toEqual({ class: 'ambiguous', detail: 'mentions CC-1120' })
  })

  it('marks a task ambiguous on a mention in notes or done_when', () => {
    expect(classifyTask(index, task('X-1', { notes: 'see TP-2' })).class).toBe('ambiguous')
    expect(classifyTask(index, task('X-2', { doneWhen: 'TP-3 lands' })).class).toBe('ambiguous')
  })

  it('marks a task off with the reason when nothing ties it to section 2', () => {
    const loose = task('TP-60', { title: 'TP-8 polish', tags: ['blocked-by:TP-8', 'kind:x'] })
    expect(classifyTask(index, loose)).toEqual({ class: 'off', detail: OFF_REASON })
  })
})

describe('plan-class v1 file', () => {
  const rows: ClassRow[] = [
    { class: 'on', id: 'TP-9', initiative: 'titan-platform', detail: 'P3', ask: '-' },
    {
      class: 'ambiguous',
      id: 'CC-1300',
      initiative: 'claude-channels',
      detail: 'mentions CC-1120',
      ask: 'm-1',
    },
    { class: 'off', id: 'TP-60', initiative: 'titan-platform', detail: OFF_REASON, ask: '-' },
  ]

  it('round-trips its rows through render and parse', () => {
    const text = renderClassFile('Plan classes 2026-10-13', rows)
    expect(text.startsWith(PLAN_CLASS_MARKER)).toBe(true)
    expect(parseClassFile(text)).toEqual(rows)
  })

  it('reads no rows from a file without the marker', () => {
    expect(parseClassFile('| on | TP-9 | t | P3 | - |\n')).toBeUndefined()
  })
})
