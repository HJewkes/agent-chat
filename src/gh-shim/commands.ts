import type { ShimRequest } from './argv.js'
import { checkEntries, checksExitCode, checksTable, rollup, type CommitChecks } from './checks.js'
import { asJson, changedFile, pick, PULL_FIELDS, RUN_FIELDS, SINGLE_PULL_FIELDS } from './fields.js'
import { runJobs, runWatch } from './watch.js'

/** Thrown for a shape the shim does not answer; the caller hands the command to the real gh. */
export class Unsupported extends Error {}

export interface ShimIo {
  /** `gh api <path>` against REST, parsed; throws on a non-zero exit. */
  api: (path: string) => unknown
  currentBranch: () => string | undefined
  jq: (value: unknown, expr: string) => string
  out: (text: string) => void
  err: (text: string) => void
  sleep: (ms: number) => Promise<void>
}

type Json = Record<string, unknown>
type PrRequest = Extract<ShimRequest, { kind: 'pr-view' | 'pr-checks' }>

const PLACEHOLDER_REPO = '{owner}/{repo}'

/** `--repo` takes OWNER/REPO or HOST/OWNER/REPO; anything else is not ours to interpret. */
export function repoPath(repo: string | undefined): string {
  if (repo === undefined) return PLACEHOLDER_REPO
  const parts = repo.replace(/^https?:\/\//, '').split('/')
  const [owner, name] = parts.length === 3 && parts[0] === 'github.com' ? parts.slice(1) : parts
  if (parts.length > 3 || !owner || !name || !/^[\w.-]+$/.test(owner + name)) throw new Unsupported(repo)
  return `${owner}/${name}`
}

const PULL_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/

/** REST's `head=` filter needs the owner, which the `{owner}` placeholder only yields through one read. */
const ownerOf = (io: ShimIo, repo: string): string =>
  repo === PLACEHOLDER_REPO
    ? String(asJson(asJson(io.api(`repos/${repo}`)).owner).login)
    : (repo.split('/')[0] as string)

function pullByBranch(io: ShimIo, repo: string, branch: string): Json {
  const query = `head=${encodeURIComponent(`${ownerOf(io, repo)}:${branch}`)}&per_page=1`
  for (const state of ['open', 'all']) {
    const [pull] = io.api(`repos/${repo}/pulls?${query}&state=${state}`) as unknown[]
    if (pull !== undefined) return io.api(`repos/${repo}/pulls/${String(asJson(pull).number)}`) as Json
  }
  throw new Error(`no pull requests found for branch "${branch}"`)
}

function resolvePull(io: ShimIo, req: PrRequest): { repo: string; pull: Json } {
  const url = req.selector?.match(PULL_URL)
  const repo = url ? (url[1] as string) : repoPath(req.repo)
  const number = url ? url[2] : req.selector?.match(/^#?(\d+)$/)?.[1]
  if (number !== undefined) return { repo, pull: io.api(`repos/${repo}/pulls/${number}`) as Json }
  const branch = req.selector ?? io.currentBranch()
  if (branch === undefined || branch.includes(':')) throw new Unsupported('pull selector')
  return { repo, pull: pullByBranch(io, repo, branch) }
}

/** One page of a REST list; a total past the page means a failure could be cut off, so gh answers instead. */
function onePage(io: ShimIo, path: string, key: string): unknown[] {
  const body = asJson(io.api(path))
  const items = body[key] as unknown[]
  if (typeof body.total_count === 'number' && body.total_count > items.length) throw new Unsupported(path)
  return items
}

const commitChecks = (io: ShimIo, repo: string, sha: string): CommitChecks => ({
  checkRuns: onePage(io, `repos/${repo}/commits/${sha}/check-runs?per_page=100`, 'check_runs'),
  statuses: onePage(io, `repos/${repo}/commits/${sha}/status?per_page=100`, 'statuses'),
  workflowRuns: asJson(io.api(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`))
    .workflow_runs as unknown[],
})

const EXTRA_PR_FIELDS = new Set(['files', 'statusCheckRollup'])

function requireFields(fields: readonly string[], known: (field: string) => boolean): void {
  const unknown = fields.find(field => !known(field))
  if (unknown !== undefined) throw new Unsupported(`field ${unknown}`)
}

function emit(io: ShimIo, value: unknown, jq: string | undefined): void {
  io.out(jq === undefined ? `${JSON.stringify(value)}\n` : io.jq(value, jq))
}

function prView(io: ShimIo, req: Extract<ShimRequest, { kind: 'pr-view' }>): number {
  requireFields(req.fields, f => f in PULL_FIELDS || f in SINGLE_PULL_FIELDS || EXTRA_PR_FIELDS.has(f))
  const { repo, pull } = resolvePull(io, req)
  const extras: Record<string, (p: Json) => unknown> = {
    files: p =>
      (io.api(`repos/${repo}/pulls/${String(p.number)}/files?per_page=100`) as unknown[]).map(changedFile),
    statusCheckRollup: p => rollup(commitChecks(io, repo, String(asJson(p.head).sha))),
  }
  emit(io, pick(pull, req.fields, { ...PULL_FIELDS, ...SINGLE_PULL_FIELDS, ...extras }), req.jq)
  return 0
}

function listPath(io: ShimIo, req: Extract<ShimRequest, { kind: 'pr-list' }>, repo: string): string {
  const state = req.state === 'merged' ? 'closed' : req.state
  const params = [`state=${state}`, `per_page=${req.state === 'merged' ? 100 : req.limit}`]
  if (req.base !== undefined) params.push(`base=${encodeURIComponent(req.base)}`)
  if (req.head !== undefined) {
    const head = req.head.includes(':') ? req.head : `${ownerOf(io, repo)}:${req.head}`
    params.push(`head=${encodeURIComponent(head)}`)
  }
  return `repos/${repo}/pulls?${params.join('&')}`
}

function prList(io: ShimIo, req: Extract<ShimRequest, { kind: 'pr-list' }>): number {
  requireFields(req.fields, f => f in PULL_FIELDS)
  const repo = repoPath(req.repo)
  const pulls = (io.api(listPath(io, req, repo)) as Json[]).filter(p => req.state !== 'merged' || p.merged_at)
  emit(
    io,
    pulls.slice(0, req.limit).map(p => pick(p, req.fields, PULL_FIELDS)),
    req.jq,
  )
  return 0
}

const CHECK_FIELDS = new Set<string>([
  'bucket',
  'completedAt',
  'description',
  'event',
  'link',
  'name',
  'startedAt',
  'state',
  'workflow',
])

function prChecks(io: ShimIo, req: Extract<ShimRequest, { kind: 'pr-checks' }>): number {
  if (req.fields !== undefined) requireFields(req.fields, f => CHECK_FIELDS.has(f))
  const { repo, pull } = resolvePull(io, req)
  const entries = checkEntries(commitChecks(io, repo, String(asJson(pull.head).sha)))
  if (req.fields !== undefined) {
    const table = Object.fromEntries([...CHECK_FIELDS].map(f => [f, (e: Json) => e[f]]))
    emit(
      io,
      entries.map(e => pick(e as unknown as Json, req.fields as string[], table)),
      req.jq,
    )
    return 0
  }
  if (entries.length === 0) {
    io.err(`no checks reported on the '${String(asJson(pull.head).ref)}' branch\n`)
    return 1
  }
  io.out(checksTable(entries))
  return checksExitCode(entries)
}

function runView(io: ShimIo, req: Extract<ShimRequest, { kind: 'run-view' }>): number {
  requireFields(req.fields, f => f in RUN_FIELDS || f === 'jobs')
  const repo = repoPath(req.repo)
  const run = asJson(io.api(`repos/${repo}/actions/runs/${req.runId}`))
  const jobs: Record<string, (r: Json) => unknown> = { jobs: () => runJobs(io, repo, req.runId) }
  emit(io, pick(run, req.fields, { ...RUN_FIELDS, ...jobs }), req.jq)
  return 0
}

export function runRequest(io: ShimIo, req: ShimRequest): Promise<number> {
  switch (req.kind) {
    case 'pr-view':
      return Promise.resolve(prView(io, req))
    case 'pr-list':
      return Promise.resolve(prList(io, req))
    case 'pr-checks':
      return Promise.resolve(prChecks(io, req))
    case 'run-view':
      return Promise.resolve(runView(io, req))
    case 'run-watch':
      return runWatch(io, req, repoPath(req.repo))
  }
}
