import path from 'node:path'
import { z } from 'zod'
import { OPS } from './ops.js'
import { lintSlices, sliceWarnings } from './slice-lint.js'

/**
 * Parses what a tick-spawned agent leaves behind: the first line of its final
 * message (`Status:` for workers, `Verdict:` for reviewers), a closing
 * `PARKED <msgId>` line, and a planner's `burndown-slices` block. Anything
 * the parser cannot read is `unknown`, never a guess at success.
 */

export const STATUSES = ['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED', 'NEEDS_CONTEXT'] as const
export type Status = (typeof STATUSES)[number]
export type Verdict = 'APPROVE' | 'CHANGES'

export interface Report {
  status: Status | 'unknown'
  verdict?: Verdict
  /** The message id of the `chat_ask` a parked worker filed. */
  parked?: string
  pr?: string
  /** A planner's plan file, from its `Plan: <absolute path>` line. */
  plan?: string
  firstLine: string
  text: string
}

const unmarked = (line: string): string => line.replace(/[*`]/g, '').trim()

export function parseReport(text: string): Report {
  const lines = text
    .split('\n')
    .map(unmarked)
    .filter(line => line.length > 0)
  const firstLine = lines[0] ?? ''
  const report: Report = { status: 'unknown', firstLine, text }
  const status = /^Status:\s*([A-Z_]+)\s*$/.exec(firstLine)?.[1]
  if (STATUSES.includes(status as Status)) report.status = status as Status
  const verdict = /^Verdict:\s*(APPROVE|CHANGES)\s*$/.exec(firstLine)?.[1]
  if (verdict !== undefined) report.verdict = verdict as Verdict
  const parked = /^PARKED\s+(\S+)$/.exec(lines.at(-1) ?? '')?.[1]
  if (parked !== undefined) report.parked = parked
  const pr = field(lines, 'PR')
  if (pr !== undefined) report.pr = pr
  const plan = field(lines, 'Plan')
  if (plan !== undefined) report.plan = plan
  return report
}

const field = (lines: string[], label: string): string | undefined =>
  lines
    .map(line => new RegExp(`^${label}:\\s*(\\S.*?)\\s*$`).exec(line)?.[1])
    .find(value => value !== undefined)

export const CONTRACT_OPS = ['replace', 'remove', 'rename', 'migrate', 'add', 'extend', 'modify'] as const
export const DESTRUCTIVE_OPS: readonly (typeof CONTRACT_OPS)[number][] = [
  'replace',
  'remove',
  'rename',
  'migrate',
]

export const Contract = z.object({
  scope: z.string().trim().min(1),
  op: z.enum(CONTRACT_OPS),
})
export type Contract = z.infer<typeof Contract>

/**
 * CC-1259: one open PR the slice may share one exact owns path with, because the planner read both edits as line-local.
 * CC-1303: or one ledger slice, named by `task` and `slice`, whose owns hold the path before its PR opens.
 */
export const AcceptedOverlap = z
  .object({
    pr: z.number().int().positive().optional(),
    task: z.string().min(1).optional(),
    slice: z.string().min(1).optional(),
    path: z.string().min(1),
    why: z.string().trim().min(1),
  })
  .refine(
    a =>
      a.pr !== undefined
        ? a.task === undefined && a.slice === undefined
        : a.task !== undefined && a.slice !== undefined,
    { message: 'name either pr, or task and slice' },
  )
export type AcceptedOverlap = z.infer<typeof AcceptedOverlap>

/** `#<pr>`, or `<task> slice <slice>`: the holder an accepted overlap names, for reason lines. */
export const acceptedHolder = (a: AcceptedOverlap): string =>
  a.pr !== undefined ? `#${a.pr}` : `${a.task} slice ${a.slice}`

const PlannedSlice = z.object({
  n: z.string().min(1),
  title: z.string(),
  dependsOn: z.array(z.string()).default([]),
  owns: z.array(z.string()).default([]),
  /**
   * The checkout's basename or path when the work is not in the task's own repo (CC-946). Defaults to the
   * plan's singular `Repo:` header (CC-1293).
   */
  repo: z.string().optional(),
  points: z.number().optional(),
  doneWhen: z.string().optional(),
  contracts: z.array(Contract).default([]),
  /** CC-974: the ops the slice's doneWhen names; `[]` says its hits are subject matter. */
  ops: z.array(z.enum(OPS)).optional(),
  /** CC-1155: the semantic reason a slice waits on one whose owns it does not share. */
  dependsWhy: z.string().optional(),
  /** CC-1259: file-overlaps with an open PR the planner accepted; every other overlap still refuses. */
  overlapsAccepted: z.array(AcceptedOverlap).optional(),
})
/** `contracts` is optional on the type so fixtures built by hand stay valid; `readSlices` always fills it. */
export type PlannedSlice = Omit<z.infer<typeof PlannedSlice>, 'contracts'> & { contracts?: Contract[] }

/** A planner's slices and their advisory lines when they pass the lint, else the reason lines. */
export type SliceRead =
  | { slices: PlannedSlice[]; warnings: string[]; problems?: undefined }
  | { slices?: undefined; warnings?: undefined; problems: string[] }

const SLICES_BLOCK = /^```burndown-slices[ \t]*\n([\s\S]*?)^```[ \t]*$/m

/** The planner's slices, or why the plan's `burndown-slices` block is missing, unreadable, or fails the lint. */
export function readSlices(planText: string): SliceRead {
  const body = SLICES_BLOCK.exec(planText)?.[1]
  if (body === undefined) return { problems: ['plan has no burndown-slices block'] }
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch (err) {
    return { problems: [`burndown-slices block is not JSON: ${(err as Error).message}`] }
  }
  const parsed = z.array(PlannedSlice).min(1).safeParse(json)
  if (!parsed.success) return { problems: parsed.error.issues.map(shapeProblem) }
  const problems = lintSlices(parsed.data)
  if (problems.length > 0) return { problems }
  const slices = withDefaultRepo(parsed.data, planRepo(planText))
  return { slices, warnings: sliceWarnings(slices) }
}

const REPO_HEADER = /^\**Repo\**:\**(.*)$/m

/**
 * CC-1293: the checkout basename a plan's singular `Repo:` header names, read before the slices block.
 * A `Repos:` header names several, so each slice must name its own and this returns undefined.
 */
export function planRepo(planText: string): string | undefined {
  const fence = SLICES_BLOCK.exec(planText)?.index ?? planText.length
  const value = REPO_HEADER.exec(planText.slice(0, fence))?.[1]
  if (value === undefined) return undefined
  const token = value
    .replace(/[`*]/g, '')
    .trim()
    .split(/[\s,(;]/)[0]!
    .replace(/\.+$/, '')
  return token === '' ? undefined : path.basename(token)
}

const withDefaultRepo = (slices: PlannedSlice[], repo: string | undefined): PlannedSlice[] =>
  repo === undefined ? slices : slices.map(s => (s.repo === undefined ? { ...s, repo } : s))

const shapeProblem = (issue: z.core.$ZodIssue): string =>
  issue.path.length === 0
    ? `burndown-slices block: ${issue.message}`
    : `burndown-slices block at ${issue.path.join('.')}: ${issue.message}`

/** The planner's slices, or undefined when `readSlices` finds a problem. */
export const parseSlices = (planText: string): PlannedSlice[] | undefined => readSlices(planText).slices
