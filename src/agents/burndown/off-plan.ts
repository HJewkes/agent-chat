import fs from 'node:fs'
import path from 'node:path'
import type { Task } from './eligibility.js'

/**
 * CC-1112: triage marks a task off-plan when its notes say it lies outside the accepted factory plan, when its
 * priority is 99 or worse, or when the newest off-plan file lists its id. Briefers refuse such a task; the
 * tick's own selection does not read this.
 */

const NOTE = 'outside accepted factory plan p-list'
const PRIORITY_FLOOR = 99
const TASK_ID = /\b[A-Z][A-Z0-9]*-\d+\b/g
const FILE = /^off-plan-.+\.md$/

export const OFF_PLAN_REASON = 'off-plan'

export function isOffPlan(
  task: Pick<Task, 'id' | 'priority' | 'notes'>,
  listed: ReadonlySet<string> = new Set(),
): boolean {
  if (task.priority !== undefined && task.priority >= PRIORITY_FLOOR) return true
  if (task.notes?.toLowerCase().includes(NOTE) === true) return true
  return listed.has(task.id)
}

/** The task ids the newest `off-plan-<date>.md` lists; no such file means no extra ids. */
export function readOffPlanIds(autonomyRoot: string, initiative = 'claude-channels'): Set<string> {
  const dir = path.join(autonomyRoot, initiative, 'sources', 'factory-review')
  try {
    const newest = fs
      .readdirSync(dir)
      .filter(name => FILE.test(name))
      .sort()
      .at(-1)
    if (newest === undefined) return new Set()
    return new Set(fs.readFileSync(path.join(dir, newest), 'utf8').match(TASK_ID) ?? [])
  } catch {
    return new Set()
  }
}
