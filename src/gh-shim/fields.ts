/**
 * REST payloads reshaped into the JSON gh's GraphQL-backed `--json` emits, field by field.
 *
 * A field missing from these tables is not guessed at: the caller passes the command through.
 */

type Json = Record<string, unknown>

const obj = (value: unknown): Json => (value !== null && typeof value === 'object' ? (value as Json) : {})

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** gh marshals an unset Go time as its zero value rather than null. */
const time = (value: unknown): string => (typeof value === 'string' ? value : '0001-01-01T00:00:00Z')

const upper = (value: unknown): string => str(value).toUpperCase()

const prState = (pull: Json): string =>
  pull.merged_at ? 'MERGED' : str(pull.state) === 'closed' ? 'CLOSED' : 'OPEN'

const MERGEABLE: Record<string, string> = { true: 'MERGEABLE', false: 'CONFLICTING' }

const actor = (user: unknown): Json => {
  const u = obj(user)
  return { id: str(u.node_id), is_bot: u.type === 'Bot', login: str(u.login), name: '' }
}

const label = (value: unknown): Json => {
  const l = obj(value)
  return { color: str(l.color), description: str(l.description), id: str(l.node_id), name: str(l.name) }
}

/** Fields answerable from one pull object, as `pulls` returns it in a list or singly. */
export const PULL_FIELDS: Record<string, (pull: Json) => unknown> = {
  author: pull => actor(pull.user),
  baseRefName: pull => str(obj(pull.base).ref),
  baseRefOid: pull => str(obj(pull.base).sha),
  body: pull => str(pull.body),
  closed: pull => pull.state === 'closed',
  closedAt: pull => pull.closed_at ?? null,
  createdAt: pull => pull.created_at,
  headRefName: pull => str(obj(pull.head).ref),
  headRefOid: pull => str(obj(pull.head).sha),
  id: pull => str(pull.node_id),
  isCrossRepository: pull => obj(obj(pull.head).repo).full_name !== obj(obj(pull.base).repo).full_name,
  isDraft: pull => pull.draft === true,
  labels: pull => (Array.isArray(pull.labels) ? pull.labels.map(label) : []),
  locked: pull => pull.locked === true,
  mergeCommit: pull => (pull.merged_at ? { oid: str(pull.merge_commit_sha) } : null),
  mergedAt: pull => pull.merged_at ?? null,
  number: pull => pull.number,
  state: prState,
  title: pull => str(pull.title),
  updatedAt: pull => pull.updated_at,
  url: pull => str(pull.html_url),
}

/** Fields only the single-pull endpoint carries; `pulls?state=` list items omit them. */
export const SINGLE_PULL_FIELDS: Record<string, (pull: Json) => unknown> = {
  additions: pull => pull.additions,
  changedFiles: pull => pull.changed_files,
  deletions: pull => pull.deletions,
  mergeable: pull => MERGEABLE[String(pull.mergeable)] ?? 'UNKNOWN',
  mergeStateStatus: pull => upper(pull.mergeable_state || 'unknown'),
}

/** Nested objects keep GraphQL's field order; only the top level is sorted. */
export const changedFile = (value: unknown): Json => {
  const f = obj(value)
  return { path: str(f.filename), additions: f.additions, deletions: f.deletions }
}

/** One commit check run, in the shape of a `statusCheckRollup` CheckRun node. */
export const rollupCheckRun = (value: unknown, workflowName: string): Json => {
  const run = obj(value)
  return {
    __typename: 'CheckRun',
    completedAt: time(run.completed_at),
    conclusion: upper(run.conclusion),
    detailsUrl: str(run.details_url),
    name: str(run.name),
    startedAt: time(run.started_at),
    status: upper(run.status),
    workflowName,
  }
}

/** One legacy commit status, in the shape of a `statusCheckRollup` StatusContext node. */
export const rollupStatus = (value: unknown): Json => {
  const status = obj(value)
  return {
    __typename: 'StatusContext',
    context: str(status.context),
    startedAt: time(status.created_at),
    state: upper(status.state),
    targetUrl: str(status.target_url),
  }
}

/** Fields of `gh run view --json`, from `actions/runs/<id>`. */
export const RUN_FIELDS: Record<string, (run: Json) => unknown> = {
  attempt: run => run.run_attempt,
  conclusion: run => str(run.conclusion),
  createdAt: run => time(run.created_at),
  databaseId: run => run.id,
  displayTitle: run => str(run.display_title),
  event: run => str(run.event),
  headBranch: run => str(run.head_branch),
  headSha: run => str(run.head_sha),
  name: run => str(run.name),
  number: run => run.run_number,
  startedAt: run => time(run.run_started_at),
  status: run => str(run.status),
  updatedAt: run => time(run.updated_at),
  url: run => str(run.html_url),
  workflowDatabaseId: run => run.workflow_id,
  workflowName: run => str(run.name),
}

const step = (value: unknown): Json => {
  const s = obj(value)
  return {
    completedAt: time(s.completed_at),
    conclusion: str(s.conclusion),
    name: str(s.name),
    number: s.number,
    startedAt: time(s.started_at),
    status: str(s.status),
  }
}

export const runJob = (value: unknown): Json => {
  const job = obj(value)
  return {
    completedAt: time(job.completed_at),
    conclusion: str(job.conclusion),
    databaseId: job.id,
    name: str(job.name),
    startedAt: time(job.started_at),
    status: str(job.status),
    steps: Array.isArray(job.steps) ? job.steps.map(step) : [],
    url: str(job.html_url),
  }
}

/** Keys sorted, as gh's exporter writes them. */
export function pick(
  source: Json,
  fields: readonly string[],
  table: Record<string, (s: Json) => unknown>,
): Json {
  const picked: Json = {}
  for (const field of [...fields].sort()) picked[field] = table[field]?.(source)
  return picked
}

export const asJson = obj
