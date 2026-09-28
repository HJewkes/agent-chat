import { z } from 'zod'

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

const PlannedSlice = z.object({
  n: z.string().min(1),
  title: z.string(),
  dependsOn: z.array(z.string()).default([]),
  owns: z.array(z.string()).default([]),
})
export type PlannedSlice = z.infer<typeof PlannedSlice>

const SLICES_BLOCK = /^```burndown-slices[ \t]*\n([\s\S]*?)^```[ \t]*$/m

/** The planner's slices, or undefined when the block is missing, not JSON, empty, or names an unknown dependency. */
export function parseSlices(planText: string): PlannedSlice[] | undefined {
  const body = SLICES_BLOCK.exec(planText)?.[1]
  if (body === undefined) return undefined
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return undefined
  }
  const parsed = z.array(PlannedSlice).min(1).safeParse(json)
  if (!parsed.success) return undefined
  const names = new Set(parsed.data.map(s => s.n))
  if (names.size !== parsed.data.length) return undefined
  if (parsed.data.some(s => s.dependsOn.some(dep => !names.has(dep)))) return undefined
  return parsed.data
}
