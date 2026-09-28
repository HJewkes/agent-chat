import fs from 'node:fs'
import path from 'node:path'
import { taskScalars } from '../agents/active-work.js'
import type { DoneTask } from './types.js'

/** Tasks closed in the window, across every initiative under the active-work root. Read-only. */

const localDate = (ms: number): string => {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const listYml = (dir: string): string[] => {
  try {
    return fs
      .readdirSync(dir)
      .filter(name => name.endsWith('.yml'))
      .map(name => path.join(dir, name))
  } catch {
    return []
  }
}

/** GitHub pull URLs first, then `PR #N` and `(#N)` mentions; at most three, in order of appearance. */
export function prRefs(text: string): string[] {
  const urls = text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? []
  const numbers = [...text.matchAll(/\bPR #(\d+)|\(#(\d+)\)/g)].map(m => `#${m[1] ?? m[2]}`)
  return [...new Set([...urls, ...numbers])].slice(0, 3)
}

function doneTask(file: string, initiative: string, sinceDate: string): DoneTask | undefined {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const s = taskScalars(text)
  const doneAt = s.done_at ?? ''
  if (s.status !== 'done' || doneAt === 'null' || doneAt < sinceDate) return undefined
  const id = s.id ?? path.basename(file, '.yml')
  return { id, title: s.title ?? '(untitled)', initiative, doneAt, prs: prRefs(s.notes ?? '') }
}

/**
 * `done_at` is a date, so the file's mtime narrows it to the window; a task
 * edited after it closed can still reappear, which errs towards showing it.
 */
export function doneTasks(root: string, sinceMs: number): DoneTask[] {
  let slugs: string[]
  try {
    slugs = fs.readdirSync(root).filter(s => !s.startsWith('.'))
  } catch {
    return []
  }
  const sinceDate = localDate(sinceMs)
  return slugs.flatMap(slug => {
    const dir = path.join(root, slug, 'tasks')
    return [...listYml(dir), ...listYml(path.join(dir, 'archive'))]
      .filter(file => fs.statSync(file).mtimeMs >= sinceMs)
      .flatMap(file => doneTask(file, slug, sinceDate) ?? [])
  })
}
