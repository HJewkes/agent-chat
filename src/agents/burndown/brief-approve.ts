import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { planPathFor } from './brief.js'
import { parseTask, readTaskText } from './source.js'
import type { Report } from '../../cli/command.js'

const PROPOSED = 'brief:proposed='
const BRIEF_SRC = 'brief:src='
const BRIEFER_SRC = 'brief:src=briefer'
const BRIEF_READY = /^brief:ready(=|$)/

/** What approval touches outside its own logic, so a test can stand in for the disk and `active-work`. */
export interface ApprovePorts {
  root: string
  initiatives: () => string[]
  planExists: (path: string) => boolean
  /** `active-work task edit <slug> <id> ...args`; throws on a non-zero exit. */
  edit: (slug: string, id: string, args: string[]) => void
}

/**
 * CC-1076: whether a briefer has answered, read by the tick when the briefer's claim finishes.
 * Approval swaps `brief:proposed` for `brief:ready` plus `brief:src=briefer`, adding both before removing
 * the proposal, so every state the task passes through satisfies this whichever of approve and tick runs first.
 */
export const briefAnswered = (tags: readonly string[]): boolean =>
  tags.some(t => t.startsWith(PROPOSED) || t === 'brief:proposed') ||
  (tags.includes(BRIEFER_SRC) && tags.some(t => BRIEF_READY.test(t)))

const refused = (message: string): Report => ({ ok: false, lines: [], errors: [message] })

/**
 * CC-940: promotes a briefer's `brief:proposed=<day>` to `brief:ready=<today>` and records `brief:src=briefer` (replacing any other src) through `active-work task edit`.
 * Refused when the task is unknown, carries no proposal, or its plan file is missing.
 */
export function approveBrief(taskId: string, ports: ApprovePorts, today: string): Report {
  const slug = ports.initiatives().find(s => readTaskText(ports.root, s, taskId) !== undefined)
  if (slug === undefined) return refused(`no task ${taskId} in any initiative`)
  const tags = parseTask(readTaskText(ports.root, slug, taskId) ?? '', taskId).tags
  const proposed = tags.find(t => t.startsWith(PROPOSED))
  if (proposed === undefined) return refused(`${taskId} carries no brief:proposed tag`)
  const plan = planPathFor(path.join(ports.root, slug), taskId)
  if (!ports.planExists(plan)) return refused(`no plan file at ${plan}`)
  try {
    const ready = `brief:ready=${today}`
    // Add first: a failure after it leaves the task with a ready tag, and a rerun finishes the cleanup.
    if (!tags.includes(ready)) ports.edit(slug, taskId, ['--add-tag', ready])
    if (!tags.includes(BRIEFER_SRC)) ports.edit(slug, taskId, ['--add-tag', BRIEFER_SRC])
    const stale = (t: string) =>
      t !== ready &&
      (t.startsWith(PROPOSED) || BRIEF_READY.test(t) || (t.startsWith(BRIEF_SRC) && t !== BRIEFER_SRC))
    for (const old of tags.filter(stale)) ports.edit(slug, taskId, ['--remove-tag', old])
  } catch (err) {
    return refused(`active-work task edit failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { ok: true, lines: [`${taskId}: ${proposed} -> brief:ready=${today}`] }
}

export function approvePortsOn(root: string): ApprovePorts {
  return {
    root,
    initiatives: () =>
      fs.readdirSync(root, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? [e.name] : [])),
    planExists: file => fs.existsSync(file),
    edit: (slug, id, args) => {
      execFileSync('active-work', ['task', 'edit', slug, id, ...args], { stdio: 'pipe', timeout: 30_000 })
    },
  }
}
