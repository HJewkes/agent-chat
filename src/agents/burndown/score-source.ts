import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { parseIsoDay, type ScoredTask } from './score.js'

/** The scorer's task reader: `tasks/*.yml` or `active-work task list` JSON, both into `ScoredTask`, open tasks only. CLI-only. */

const text = z
  .union([z.string(), z.number(), z.boolean()])
  .nullish()
  .transform(v => (v === null || v === undefined ? undefined : String(v)))

const TaskFields = z.looseObject({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.number(),
  severity: text,
  estimate: z.number().nullish(),
  done_when: text,
  notes: text,
  tags: z
    .array(z.unknown())
    .nullish()
    .transform(v => v?.map(String)),
  created: text,
  updated: text,
})

const COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})$/

/** YAML reads an unquoted `20260918` as a number; ISO-shape it so the age term can parse it. */
function isoDate(v: string | undefined, field: string, where: string): string | undefined {
  if (v === undefined || !COMPACT_DATE.test(v)) return v
  const iso = v.replace(COMPACT_DATE, '$1-$2-$3')
  if (parseIsoDay(iso) === undefined) throw new Error(`open task ${where} has an invalid ${field} date: ${v}`)
  return iso
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Refuses names that could leave the root: separators, `..`, empty. */
export function assertSafeName(kind: string, name: string): void {
  if (!SAFE_NAME.test(name) || name.includes('..'))
    throw new Error(`unsafe ${kind} name: ${JSON.stringify(name)}`)
}

const KEYS = ['severity', 'estimate', 'done_when', 'notes', 'tags', 'created', 'updated'] as const

function toScoredTask(raw: unknown, slug: string, where: string): ScoredTask {
  const parsed = TaskFields.safeParse(raw)
  if (!parsed.success) throw new Error(`open task ${where} is malformed: ${parsed.error.message}`)
  const t = parsed.data
  const optional = Object.fromEntries(
    KEYS.flatMap(k => (t[k] === undefined || t[k] === null ? [] : [[k, t[k]]])),
  )
  const dates = Object.fromEntries(
    (['created', 'updated'] as const).flatMap(k =>
      t[k] === undefined ? [] : [[k, isoDate(t[k], k, where)]],
    ),
  )
  return { id: t.id, title: t.title, priority: t.priority, ...optional, ...dates, slug }
}

const isOpen = (raw: unknown): raw is Record<string, unknown> =>
  raw !== null &&
  typeof raw === 'object' &&
  !Array.isArray(raw) &&
  (raw as { status?: unknown }).status === 'open'

/** One task file; undefined when it is not a mapping or not open, as score.py `load_tasks` skips them. */
export function parseScoredTask(yamlText: string, slug: string, where = slug): ScoredTask | undefined {
  const raw: unknown = parse(yamlText)
  return isOpen(raw) ? toScoredTask(raw, slug, where) : undefined
}

const ListShape = z.union([
  z.object({ tasks: z.array(z.unknown()) }),
  z.object({ data: z.object({ tasks: z.array(z.unknown()) }) }),
])

/** `active-work task list --json` output (enveloped or bare `{tasks}`); each entry carries its own `slug`. */
export function tasksFromList(json: unknown): ScoredTask[] {
  const parsed = ListShape.safeParse(json)
  if (!parsed.success) throw new Error(`task list JSON is malformed: ${parsed.error.message}`)
  const tasks = 'tasks' in parsed.data ? parsed.data.tasks : parsed.data.data.tasks
  return tasks.filter(isOpen).map((raw, i) => {
    const slug = raw.slug
    if (typeof slug !== 'string') throw new Error(`task list entry ${i} has no slug`)
    return toScoredTask(raw, slug, `${slug}#${i}`)
  })
}

const reportSkip = (message: string): void => {
  process.stderr.write(`${message}\n`)
}

/** Open tasks under `<root>/<slug>/tasks/*.yml` for each slug, files in name order; a malformed open task is reported and skipped. */
export function readScoredTasks(
  root: string,
  slugs: Iterable<string>,
  onSkip: (message: string) => void = reportSkip,
): ScoredTask[] {
  return [...slugs].flatMap(slug => {
    assertSafeName('initiative slug', slug)
    const dir = path.join(root, slug, 'tasks')
    let files: string[]
    try {
      files = fs.readdirSync(dir).filter(name => name.endsWith('.yml'))
    } catch {
      return []
    }
    return files.sort().flatMap(file => {
      try {
        const task = parseScoredTask(fs.readFileSync(path.join(dir, file), 'utf8'), slug, `${slug}/${file}`)
        return task === undefined ? [] : [task]
      } catch (err) {
        onSkip(`skipping ${slug}/${file}: ${err instanceof Error ? err.message : String(err)}`)
        return []
      }
    })
  })
}
