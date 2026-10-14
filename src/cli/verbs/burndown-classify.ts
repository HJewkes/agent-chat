import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { requiredString } from '../../args.js'
import { activeWorkRoot } from '../../agents/active-work.js'
import { classifyTask, planIndex, renderClassFile, type ClassRow } from '../../agents/burndown/plan-class.js'
import { localDate } from '../../agents/burndown/seat-tick.js'
import { readTasks } from '../../agents/burndown/source.js'
import { defineVerb, Report } from '../command.js'

/**
 * TP-2418 b: classify every open task of the factory initiatives against section 2 of the accepted plan, and
 * with `--write` publish the official `off-plan-<date>.md` (plan-class v1) the briefers read. Never edits tasks.
 */

export interface ClassifyRequest {
  planPath: string
  initiatives: readonly string[]
  root: string
  outDir: string
  write: boolean
  now: Date
}

export interface ClassifyResult {
  rows: ClassRow[]
  written?: string
}

const NO_SECTION_2 = (planPath: string): string =>
  `${planPath} has no "## 2." section; refusing to classify (an empty plan would mark every task off)`

export function classifyOpenTasks(
  planText: string,
  planPath: string,
  root: string,
  initiatives: readonly string[],
) {
  const index = planIndex(planText)
  if (index === undefined) throw new Error(NO_SECTION_2(planPath))
  return initiatives.flatMap(initiative =>
    readTasks(root, initiative)
      .filter(task => task.status === 'open')
      .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
      .map(task => ({ ...classifyTask(index, task), id: task.id, initiative, ask: '-' })),
  )
}

/** Tmp file and rename, so a reader never sees a half-written file. */
function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

export function classifyFromDisk(req: ClassifyRequest): ClassifyResult {
  const planText = fs.readFileSync(req.planPath, 'utf8')
  const rows = classifyOpenTasks(planText, req.planPath, req.root, req.initiatives)
  if (!req.write) return { rows }
  const date = localDate(req.now)
  const file = path.join(req.outDir, `off-plan-${date}.md`)
  writeAtomic(file, renderClassFile(`Off-plan classification ${date} (plan ${req.planPath})`, rows))
  return { rows, written: file }
}

const pRow = (row: ClassRow): string => row.detail.split(' ')[0] ?? row.detail

const counted = (keys: readonly string[]): Map<string, number> =>
  keys.reduce((acc, key) => acc.set(key, (acc.get(key) ?? 0) + 1), new Map<string, number>())

/** The counts, then on rows per P row, then one line per off or ambiguous task. */
export function renderClassify(result: ClassifyResult): string[] {
  const by = counted(result.rows.map(row => row.class))
  const perP = counted(result.rows.filter(row => row.class === 'on').map(pRow))
  const sortedP = [...perP].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
  return [
    `on ${by.get('on') ?? 0} off ${by.get('off') ?? 0} ambiguous ${by.get('ambiguous') ?? 0}`,
    ...sortedP.map(([p, n]) => `  ${p} ${n}`),
    ...result.rows
      .filter(row => row.class !== 'on')
      .map(row => `${row.class} ${row.id} (${row.initiative}): ${row.detail}`),
    result.written === undefined ? 'dry run: nothing written (pass --write)' : `wrote ${result.written}`,
  ]
}

export const defaultFactoryReviewDir = (root: string): string =>
  path.join(root, 'claude-channels', 'sources', 'factory-review')

export const burndownClassifyVerb = defineVerb({
  name: 'burndown.classify',
  description:
    'classify every open task on, off or ambiguous against section 2 of the accepted plan; --write publishes off-plan-<date>.md (TP-2418)',
  args: z.object({
    plan: requiredString('plan'),
    initiative: z.array(z.string()).min(1),
    outDir: z.string().optional(),
    write: z.boolean().optional(),
    json: z.boolean().optional(),
  }),
  result: Report,
  cli: {
    options: {
      plan: {
        long: '--plan',
        description: 'the accepted factory plan whose "## 2." section names on-plan ids',
      },
      initiative: {
        long: '--initiative',
        description: 'an active-work initiative whose open tasks to classify (repeatable)',
      },
      outDir: {
        long: '--out-dir',
        description: 'where off-plan-<date>.md goes (default claude-channels factory-review)',
      },
      write: { long: '--write', description: 'write the file; without it the run is a dry run' },
      json: { long: '--json', description: 'one JSON record per task, one per line' },
    },
  },
  async run({ plan, initiative, outDir, write, json }) {
    try {
      const root = activeWorkRoot()
      const result = classifyFromDisk({
        planPath: plan,
        initiatives: initiative,
        root,
        outDir: outDir ?? defaultFactoryReviewDir(root),
        write: write === true,
        now: new Date(),
      })
      const lines = json === true ? result.rows.map(row => JSON.stringify(row)) : renderClassify(result)
      return { ok: true, lines }
    } catch (err) {
      return { ok: false, lines: [], errors: [err instanceof Error ? err.message : String(err)] }
    }
  },
})
