import fs from 'node:fs'
import path from 'node:path'
import type { Task } from './eligibility.js'
import { parseClassFile } from './plan-class.js'

/**
 * CC-1112: triage marks a task off-plan when its notes say it lies outside the accepted factory plan, or when
 * the newest off-plan file lists its id. Briefers refuse such a task; the tick's own selection does not read
 * this. Priority is never a verdict: it is an ordinal that `task add` defaults to max+1 (CC-1301). A file in the plan-class v1 format (TP-2418, `plan-class.ts`) lists
 * its off and ambiguous rows; a file without the v1 marker is the legacy list, where every id it names counts.
 */

const NOTE = 'outside accepted factory plan p-list'
const TASK_ID = /\b[A-Z][A-Z0-9]*-\d+\b/g
const FILE = /^off-plan-.+\.md$/

export const OFF_PLAN_REASON = 'off-plan'

export function isOffPlan(
  task: Pick<Task, 'id' | 'notes'>,
  listed: ReadonlySet<string> = new Set(),
): boolean {
  if (task.notes?.toLowerCase().includes(NOTE) === true) return true
  return listed.has(task.id)
}

/** The ids a file marks off plan: v1 off and ambiguous rows, or every id of a legacy file. */
export function offPlanIdsOf(text: string): Set<string> {
  const rows = parseClassFile(text)
  if (rows === undefined) return new Set(text.match(TASK_ID) ?? [])
  return new Set(rows.filter(row => row.class !== 'on').map(row => row.id))
}

/** The task ids the newest `off-plan-<date>.md` marks off plan; no such file means no extra ids. */
export function readOffPlanIds(autonomyRoot: string, initiative = 'claude-channels'): Set<string> {
  const dir = path.join(autonomyRoot, initiative, 'sources', 'factory-review')
  try {
    const newest = fs
      .readdirSync(dir)
      .filter(name => FILE.test(name))
      .sort()
      .at(-1)
    if (newest === undefined) return new Set()
    return offPlanIdsOf(fs.readFileSync(path.join(dir, newest), 'utf8'))
  } catch {
    return new Set()
  }
}
