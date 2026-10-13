import type { Task } from './eligibility.js'
import { backlogIds, onPlan, planSectionIds } from './seat-scope.js'

/**
 * TP-2418: the plan-class v1 file, the official on/off-plan source (owner item 253(4)). Every open task is on
 * (the accepted plan's section 2 names it or a link of it), ambiguous (its text mentions a section-2 id) or off.
 * Readers treat ambiguous as off until the owner answers. Pure.
 */

export const PLAN_CLASS_MARKER = '<!-- plan-class v1 -->'
export const SECTION_2 = 'section-2'
export const OFF_REASON = 'no section-2 id or link'

export type PlanClass = 'on' | 'off' | 'ambiguous'

export interface PlanIndex {
  /** Every task id in section 2. */
  ids: ReadonlySet<string>
  /** The P row each id falls under; an id absent here is matched as `section-2`. */
  rows: ReadonlyMap<string, string>
}

export interface Classification {
  class: PlanClass
  /** The matched P row (or `section-2`) for on, else the reason. */
  detail: string
}

export interface ClassRow extends Classification {
  id: string
  initiative: string
  /** The owner ask's message id, or `-` when none was sent. */
  ask: string
}

const TABLE_ROW = /^\|\s*(P\d+)\s*\|/
const P_LABEL = /\b(P\d+):|\b([A-Z]{1,5}-\d+)\b/g

const sectionTwo = (text: string): string => {
  const lines = text.split('\n')
  const after = lines.slice(lines.findIndex(line => /^## 2[.\s]/.test(line)) + 1)
  const end = after.findIndex(line => line.startsWith('## '))
  return (end < 0 ? after : after.slice(0, end)).join('\n')
}

/** Ids under the nearest preceding `P<n>:` label of their paragraph. */
function paragraphRows(section: string, rows: Map<string, string>): void {
  for (const paragraph of section.split(/\n\s*\n/)) {
    if (paragraph.trimStart().startsWith('|')) continue
    let label: string | undefined
    for (const [, p, id] of paragraph.matchAll(P_LABEL)) {
      if (p !== undefined) label = p
      else if (id !== undefined && label !== undefined && !rows.has(id)) rows.set(id, label)
    }
  }
}

/** The section-2 ids and their P rows: a `| P<n> |` table row wins over a paragraph label. Undefined without section 2. */
export function planIndex(planText: string): PlanIndex | undefined {
  const ids = planSectionIds(planText)
  if (ids === undefined) return undefined
  const section = sectionTwo(planText)
  const rows = new Map<string, string>()
  for (const line of section.split('\n')) {
    const p = TABLE_ROW.exec(line)?.[1]
    if (p === undefined) continue
    for (const id of backlogIds(line)) if (!rows.has(id)) rows.set(id, p)
  }
  paragraphRows(section, rows)
  return { ids, rows }
}

const rowOf = (index: PlanIndex, id: string): string => index.rows.get(id) ?? SECTION_2

type Classifiable = Pick<Task, 'id' | 'title' | 'tags' | 'notes' | 'doneWhen'>

export function classifyTask(index: PlanIndex, task: Classifiable): Classification {
  if (onPlan(index.ids, task)) {
    if (index.ids.has(task.id)) return { class: 'on', detail: rowOf(index, task.id) }
    const link = task.tags.find(tag => onPlan(index.ids, { id: '', tags: [tag] })) ?? ''
    return { class: 'on', detail: `${rowOf(index, link.slice(link.indexOf(':') + 1))} via ${link}` }
  }
  const text = [task.title, task.notes ?? '', task.doneWhen ?? ''].join('\n')
  const mentioned = [...backlogIds(text)].find(id => index.ids.has(id))
  if (mentioned !== undefined) return { class: 'ambiguous', detail: `mentions ${mentioned}` }
  return { class: 'off', detail: OFF_REASON }
}

const cell = (value: string): string => value.replaceAll('|', '/').replaceAll('\n', ' ')

export function renderClassFile(title: string, rows: readonly ClassRow[]): string {
  const lines = rows.map(
    r => `| ${r.class} | ${r.id} | ${cell(r.initiative)} | ${cell(r.detail)} | ${cell(r.ask)} |`,
  )
  const header = ['| class | id | initiative | match-or-reason | ask |', '|---|---|---|---|---|']
  return [PLAN_CLASS_MARKER, `# ${title}`, '', ...header, ...lines, ''].join('\n')
}

const DATA_ROW = /^\|\s*(on|off|ambiguous)\s*\|\s*([A-Z][A-Z0-9]*-\d+)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|\s*$/

/** The rows of a plan-class v1 file; undefined when the text carries no v1 marker. */
export function parseClassFile(text: string): ClassRow[] | undefined {
  if (!text.split('\n').some(line => line.trim() === PLAN_CLASS_MARKER)) return undefined
  return text.split('\n').flatMap(line => {
    const m = DATA_ROW.exec(line.trim())
    if (m === null) return []
    const [, cls, id, initiative, detail, ask] = m
    return [
      {
        class: cls as PlanClass,
        id: id!,
        initiative: initiative!.trim(),
        detail: detail!.trim(),
        ask: ask!.trim(),
      },
    ]
  })
}
