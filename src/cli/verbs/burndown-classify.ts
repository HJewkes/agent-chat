import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { requiredString } from '../../args.js'
import { activeWorkRoot } from '../../agents/active-work.js'
import {
  applyAnswer,
  carryAsks,
  classifyTask,
  hasAsk,
  needsAsk,
  NOT_SENT,
  parseClassFile,
  planIndex,
  renderClassFile,
  type ClassRow,
  type OwnerAnswer,
} from '../../agents/burndown/plan-class.js'
import { localDate } from '../../agents/burndown/seat-tick.js'
import { readTasks } from '../../agents/burndown/source.js'
import type { ClientMessage, ServerMessage } from '../../protocol.js'
import { defineVerb, Report, type VerbContext } from '../command.js'
import { serviceRequest } from './ask.js'

/**
 * TP-2418 b: classify every open task of the factory initiatives against section 2 of the accepted plan, and
 * with `--write` publish the official `off-plan-<date>.md` (plan-class v1) the briefers read. Never edits tasks.
 * TP-2418 c: with `--ask`, each ambiguous task gets one two-way on/off owner ask, recorded in the file's ask
 * column, and a later run applies the answer.
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
  warnings: string[]
}

/** The owner-ask half of the broker, so tests can stand in for it. */
export interface AskPorts {
  /** Files one ask for an ambiguous row and returns its message id; throws when it cannot. */
  ask(row: ClassRow): Promise<string>
  /** The owner's answers to these asks, keyed by the ask's message id. */
  answers(askIds: readonly string[]): Promise<Map<string, OwnerAnswer>>
}

/** At most this many asks per run (Q4: up to 40 a day at the 3-hourly cadence). */
export const ASK_CAP = 5

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

const FILE = /^off-plan-.+\.md$/

/** The rows of the newest v1 file in the review dir, whose ask column says who was already asked. */
function newestRows(outDir: string): ClassRow[] {
  if (!fs.existsSync(outDir)) return []
  const newest = fs
    .readdirSync(outDir)
    .filter(name => FILE.test(name))
    .sort()
    .at(-1)
  return newest === undefined
    ? []
    : (parseClassFile(fs.readFileSync(path.join(outDir, newest), 'utf8')) ?? [])
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function readAnswers(rows: readonly ClassRow[], asks: AskPorts, warnings: string[]) {
  const askIds = rows.filter(row => row.class === 'ambiguous' && hasAsk(row.ask)).map(row => row.ask)
  if (askIds.length === 0) return new Map<string, OwnerAnswer>()
  try {
    return await asks.answers(askIds)
  } catch (err) {
    warnings.push(`owner answers not read, rows stay ambiguous: ${message(err)}`)
    return new Map<string, OwnerAnswer>()
  }
}

/** Asks about the first ASK_CAP unasked ambiguous rows; after one failure the rest are `not-sent`. */
async function sendAsks(rows: readonly ClassRow[], asks: AskPorts, warnings: string[]) {
  const due = new Set(rows.filter(needsAsk).slice(0, ASK_CAP))
  let failed = false
  const out: ClassRow[] = []
  for (const row of rows) {
    if (!due.has(row) || failed) {
      out.push(due.has(row) ? { ...row, ask: NOT_SENT } : row)
      continue
    }
    try {
      out.push({ ...row, ask: await asks.ask(row) })
    } catch (err) {
      failed = true
      warnings.push(`owner asks not sent, the next run retries: ${message(err)}`)
      out.push({ ...row, ask: NOT_SENT })
    }
  }
  return out
}

async function settleAmbiguous(rows: readonly ClassRow[], asks: AskPorts, warnings: string[]) {
  const answers = await readAnswers(rows, asks, warnings)
  return sendAsks(
    rows.map(row => applyAnswer(row, answers.get(row.ask))),
    asks,
    warnings,
  )
}

export async function classifyFromDisk(req: ClassifyRequest, asks?: AskPorts): Promise<ClassifyResult> {
  const planText = fs.readFileSync(req.planPath, 'utf8')
  const classified = classifyOpenTasks(planText, req.planPath, req.root, req.initiatives)
  const fresh = carryAsks(classified, newestRows(req.outDir))
  const warnings: string[] = []
  const rows = asks === undefined ? fresh : await settleAmbiguous(fresh, asks, warnings)
  if (!req.write) return { rows, warnings }
  const date = localDate(req.now)
  const file = path.join(req.outDir, `off-plan-${date}.md`)
  writeAtomic(file, renderClassFile(`Off-plan classification ${date} (plan ${req.planPath})`, rows))
  return { rows, written: file, warnings }
}

const askText = (row: ClassRow): string =>
  `${row.id}: on plan? It ${row.detail}, which section 2 of the accepted factory plan names.`

type AskResult = Extract<ServerMessage, { t: 'service_ask_result' }>
type AnswersResult = Extract<ServerMessage, { t: 'answers_since_result' }>

/** Pages through the label's answers from the start; a label carries only these asks, so it stays short. */
async function answersTo(ctx: VerbContext, label: string, askIds: readonly string[]) {
  const wanted = new Set(askIds)
  const found = new Map<string, OwnerAnswer>()
  let after: string | undefined
  do {
    const frame = { t: 'answers_since', name: label, limit: 50, ...(after ? { after } : {}) } as const
    const res = (await serviceRequest(ctx, frame, 'answers_since_result')) as AnswersResult
    if (res.error !== undefined) throw new Error(res.error)
    for (const answer of res.answers) if (wanted.has(answer.questionId)) found.set(answer.questionId, answer)
    after = res.next
  } while (after !== undefined && found.size < wanted.size)
  return found
}

/** The broker side of AskPorts: `service_ask` and `answers_since` under one service label (CC-169). */
export function brokerAsks(ctx: VerbContext, label: string): AskPorts {
  return {
    async ask(row) {
      const frame: ClientMessage = {
        t: 'service_ask',
        as: label,
        text: askText(row),
        task: row.id,
        initiative: row.initiative,
        header: `${row.id}: on or off the factory plan?`,
        options: ['on', 'off'],
        recommended: 'off',
        default: 'off',
        door: 'two-way',
        blocking: 'continue',
        onNoAnswer: 'stays off plan; briefers skip it',
      }
      const res = (await serviceRequest(ctx, frame, 'service_ask_result')) as AskResult
      if (!res.ok || !res.msgId) throw new Error(res.reason ?? 'ask refused')
      return res.msgId
    },
    answers: askIds => answersTo(ctx, label, askIds),
  }
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
    ask: z.string().optional(),
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
      ask: {
        long: '--ask <label>',
        description:
          'ask the owner on/off once per ambiguous task under this service label, and apply answers (needs --write)',
      },
      json: { long: '--json', description: 'one JSON record per task, one per line' },
    },
  },
  async run({ plan, initiative, outDir, write, ask, json }, ctx) {
    if (ask !== undefined && write !== true)
      return {
        ok: false,
        lines: [],
        errors: ['--ask needs --write: an ask the file does not record is sent again'],
      }
    try {
      const root = activeWorkRoot()
      const request = {
        planPath: plan,
        initiatives: initiative,
        root,
        outDir: outDir ?? defaultFactoryReviewDir(root),
        write: write === true,
        now: new Date(),
      }
      const result = await classifyFromDisk(request, ask === undefined ? undefined : brokerAsks(ctx, ask))
      ctx.warnings.push(...result.warnings)
      const lines = json === true ? result.rows.map(row => JSON.stringify(row)) : renderClassify(result)
      return { ok: true, lines }
    } catch (err) {
      return { ok: false, lines: [], errors: [err instanceof Error ? err.message : String(err)] }
    }
  },
})
