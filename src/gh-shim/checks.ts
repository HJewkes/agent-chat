import { asJson, rollupCheckRun, rollupStatus } from './fields.js'

/** The three REST reads that together stand in for GraphQL's `statusCheckRollup`. */
export interface CommitChecks {
  checkRuns: unknown[]
  statuses: unknown[]
  /** `actions/runs?head_sha=`, read for each check suite's workflow name and event. */
  workflowRuns: unknown[]
}

export interface CheckEntry {
  bucket: string
  completedAt: string
  description: string
  event: string
  link: string
  name: string
  startedAt: string
  state: string
  workflow: string
}

const BUCKETS: Record<string, string> = {
  SUCCESS: 'pass',
  SKIPPED: 'skipping',
  NEUTRAL: 'skipping',
  CANCELLED: 'cancel',
  FAILURE: 'fail',
  ERROR: 'fail',
  TIMED_OUT: 'fail',
  ACTION_REQUIRED: 'fail',
  STARTUP_FAILURE: 'fail',
}

export const bucketOf = (state: string): string => BUCKETS[state] ?? 'pending'

function suiteWorkflows(workflowRuns: unknown[]): Map<unknown, { name: string; event: string }> {
  const bySuite = new Map<unknown, { name: string; event: string }>()
  for (const value of workflowRuns) {
    const run = asJson(value)
    bySuite.set(run.check_suite_id, { name: String(run.name ?? ''), event: String(run.event ?? '') })
  }
  return bySuite
}

export function rollup(checks: CommitChecks): Record<string, unknown>[] {
  const workflows = suiteWorkflows(checks.workflowRuns)
  const runs = checks.checkRuns.map(run =>
    rollupCheckRun(run, workflows.get(asJson(asJson(run).check_suite).id)?.name ?? ''),
  )
  return [...runs, ...checks.statuses.map(rollupStatus)]
}

function checkRunEntry(value: unknown, workflows: ReturnType<typeof suiteWorkflows>): CheckEntry {
  const run = asJson(value)
  const node = rollupCheckRun(value, '')
  const state = node.status === 'COMPLETED' ? String(node.conclusion) : String(node.status)
  const workflow = workflows.get(asJson(run.check_suite).id)
  return {
    bucket: bucketOf(state),
    completedAt: String(node.completedAt),
    description: String(asJson(run.output).title ?? ''),
    event: workflow?.event ?? '',
    link: String(node.detailsUrl),
    name: String(node.name),
    startedAt: String(node.startedAt),
    state,
    workflow: workflow?.name ?? '',
  }
}

function statusEntry(value: unknown): CheckEntry {
  const status = asJson(value)
  const state = String(status.state ?? '').toUpperCase()
  return {
    bucket: bucketOf(state),
    completedAt: String(status.updated_at ?? ''),
    description: String(status.description ?? ''),
    event: '',
    link: String(status.target_url ?? ''),
    name: String(status.context ?? ''),
    startedAt: String(status.created_at ?? ''),
    state,
    workflow: '',
  }
}

const BUCKET_RANK: Record<string, number> = { fail: 0, pending: 1 }

const byBucketThenName = (a: CheckEntry, b: CheckEntry): number =>
  (BUCKET_RANK[a.bucket] ?? 2) - (BUCKET_RANK[b.bucket] ?? 2) || a.name.localeCompare(b.name)

/** One entry per check name, the most recently started winning; failures, then pending, lead as in gh. */
export function checkEntries(checks: CommitChecks): CheckEntry[] {
  const workflows = suiteWorkflows(checks.workflowRuns)
  const all = [
    ...checks.checkRuns.map(run => checkRunEntry(run, workflows)),
    ...checks.statuses.map(statusEntry),
  ]
  const latest = new Map<string, CheckEntry>()
  for (const entry of all) {
    const held = latest.get(entry.name)
    if (held === undefined || entry.startedAt > held.startedAt) latest.set(entry.name, entry)
  }
  return [...latest.values()].sort(byBucketThenName)
}

/** gh's duration format, `2m28s`; undefined when either end is unset or out of order. */
export function duration(startedAt: string, completedAt: string): string | undefined {
  const ms = Date.parse(completedAt) - Date.parse(startedAt)
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  const total = Math.round(ms / 1000)
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
  return `${h ? `${h}h` : ''}${h || m ? `${m}m` : ''}${s}s`
}

const elapsed = (entry: CheckEntry): string =>
  (entry.bucket === 'pending' ? undefined : duration(entry.startedAt, entry.completedAt)) ?? '0'

/** gh's non-TTY table: name, bucket, elapsed, link, description, tab-separated. */
export const checksTable = (entries: readonly CheckEntry[]): string =>
  entries.map(e => [e.name, e.bucket, elapsed(e), e.link, e.description].join('\t') + '\n').join('')

/** gh exits 1 on any failure or cancellation, 8 while anything is pending. */
export function checksExitCode(entries: readonly CheckEntry[]): number {
  if (entries.some(e => e.bucket === 'fail' || e.bucket === 'cancel')) return 1
  return entries.some(e => e.bucket === 'pending') ? 8 : 0
}
