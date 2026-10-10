import type { AgentIdentity } from '../../protocol.js'
import {
  FINISHED_PHASES,
  SHEPHERD_BIN,
  SHEPHERD_STATUS_ARGS,
  parseShepherdRows,
  shepherdTarget,
  targetRef,
} from '../burndown/shepherd.js'
import { run, type Runner } from '../burndown/exec.js'
import { readLedger, type Claim } from '../burndown/ledger.js'
import { openEvents } from './io.js'
import { reportHead, reportPr } from './retire-outcome.js'

/**
 * CC-934: the In flight section of `seats boot`, derived from the seat's agents, Shepherd's rows, the
 * newest verdicts events.db holds and the seat's non-done burndown claims, so no seat hand-keeps it in
 * queues/<seat>.md. Each source is a port that throws when it cannot answer; the boot prints one
 * `unavailable: <source>` line for it and carries on.
 */

export interface ShepherdFlight {
  repo: string
  pr: number | null
  branch: string | null
  runId: string
  task: string | null
  phase: string
  headSha: string | null
  nextAction: string | null
  pendingGate: string | null
  held: boolean
  stalled: boolean
}

export interface VerdictRecord {
  /** `owner/repo#n`. */
  pr: string
  head: string
  verdict: string
}

export interface InFlightPorts {
  /** The broker's roster without retired agents. */
  roster: () => Promise<AgentIdentity[]>
  /** Every row `titan-factory shepherd status --json` lists. */
  shepherd: () => Promise<ShepherdFlight[]>
  /** Newest first; one record per PR and head. */
  verdicts: () => Promise<VerdictRecord[]>
  /** Every claim in burndown.json. */
  claims: () => Promise<Claim[]>
}

export type InFlightSource = 'roster' | 'shepherd' | 'verdicts' | 'claims'

export interface FlightAgent {
  name: string
  profile: string
  state: string
  cwd: string
  /** The seat's claim this agent is named on. */
  claim?: string
}

export interface FlightPr {
  pr: string
  head: string | null
  /** `MERGE`, `FIX_FIRST` or `WAIT`, as the verdict names it. */
  verdict: string | null
  /** The head the newest verdict was for, when it is not this row's head. */
  verdictHead: string | null
  ci: string
  phase: string | null
  task: string | null
  agent: string | null
  claim: string | null
  nextAction: string | null
  pendingGate: string | null
  flags: string[]
}

export interface InFlight {
  prs: FlightPr[]
  agents: FlightAgent[]
  /** Claims with no PR yet and no agent on the roster. */
  claims: string[]
  unavailable: Array<{ source: InFlightSource; reason: string }>
}

const text = (v: unknown): string | null => {
  if (typeof v === 'string') return v === '' || v === 'none' ? null : v
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const key of ['reason', 'kind', 'name', 'action', 'gate'])
      if (typeof o[key] === 'string') return o[key]
  }
  return null
}

/**
 * Shepherd keeps every run it has finished, so the rows read here are only the live ones: finished
 * phases are dropped at this boundary. A body that is no JSON array throws.
 */
export function parseShepherdFlights(stdout: string): ShepherdFlight[] {
  const rows = parseShepherdRows(stdout, () => undefined)
  if (rows === undefined) throw new Error('shepherd status is not a JSON array')
  return rows
    .filter(r => !FINISHED_PHASES.includes(r.phase))
    .map(r => ({
      repo: r.repo,
      pr: r.pr,
      branch: r.branch ?? null,
      runId: r.runId,
      task: r.task ?? null,
      phase: r.phase,
      headSha: r.headSha,
      nextAction: text(r.nextAction),
      pendingGate: text(r.pendingGate),
      held: r.held !== null && r.held !== undefined,
      stalled: r.stalled !== null,
    }))
}

export function shepherdPort(exec: Runner = run): () => Promise<ShepherdFlight[]> {
  return async () => {
    const result = exec(SHEPHERD_BIN, SHEPHERD_STATUS_ARGS)
    if (result.status !== 0) throw new Error('shepherd status did not answer')
    return parseShepherdFlights(result.stdout)
  }
}

export const claimsPort = (file: string) => async (): Promise<Claim[]> => readLedger(file).claims

const VERDICT_WORD = /^[\s*_`>#-]*verdict[*_`]*\s*:[\s*_`]*([A-Z_]+)/i
const VERDICT_SCAN = 2_000

/** Newest verdict per PR and head from messages whose body opens `Verdict:` and names `PR:` and `Head:`. */
export function eventsVerdictsPort(dbPath: string): () => Promise<VerdictRecord[]> {
  return async () => {
    const db = openEvents(dbPath)
    try {
      const rows = db
        .prepare(
          `SELECT body FROM events WHERE kind = 'message' AND body LIKE '%erdict%' ORDER BY id DESC LIMIT ?`,
        )
        .all(VERDICT_SCAN) as unknown as Array<{ body: string | null }>
      const seen = new Map<string, VerdictRecord>()
      for (const { body } of rows) {
        const verdict = VERDICT_WORD.exec(body ?? '')?.[1]?.toUpperCase()
        const pr = reportPr(body ?? '')
        const head = reportHead(body ?? '')
        if (verdict === undefined || pr === null || head === null) continue
        const key = `${pr.toLowerCase()}@${head}`
        if (!seen.has(key)) seen.set(key, { pr, head, verdict })
      }
      return [...seen.values()]
    } finally {
      db.close()
    }
  }
}

/** Branch carries the seat prefix as a name segment: `<prefix>-…`, bare or after a `/`. */
export const branchOfSeat = (branch: string | null, prefix: string): boolean =>
  branch !== null && branch.split('/').some(seg => seg.startsWith(`${prefix}-`))

/** What Shepherd's phase says of CI; phases after `ci` are reached only past it. */
function ciOf(phase: string | null): string {
  switch (phase) {
    case 'ci':
      return 'pending'
    case 'fixing':
      return 'failing'
    case 'review':
    case 'awaiting-approval':
    case 'merging':
    case 'post-merge':
    case 'done':
      return 'passed'
    default:
      return 'unknown'
  }
}

const claimLabel = (c: Claim): string => `${c.taskId}${c.slice === undefined ? '' : `/${c.slice}`} ${c.phase}`

const prKey = (pr: string): string => pr.toLowerCase()

/** The claim's PR as `owner/repo#n`, or the raw text when it is neither a URL nor a ref. */
const claimPr = (c: Claim): string | null => {
  const t = c.pr === undefined ? undefined : shepherdTarget(c.pr)
  return t === undefined ? null : targetRef(t)
}

export interface InFlightInput {
  seat: string
  prefix: string | undefined
  roster: AgentIdentity[] | undefined
  shepherd: ShepherdFlight[] | undefined
  verdicts: VerdictRecord[] | undefined
  claims: Claim[] | undefined
}

const seatAgent = (a: AgentIdentity, seat: string, prefix: string | undefined): boolean =>
  a.spawnedBy === seat || (prefix !== undefined && a.name.startsWith(`${prefix}-`))

/** Pure: the sources already read, joined on PR. A source that is undefined contributes nothing. */
export function deriveInFlight(input: InFlightInput): Omit<InFlight, 'unavailable'> {
  const { seat, prefix } = input
  const claims = (input.claims ?? []).filter(c => c.seat === seat && c.phase !== 'done')
  const agents = (input.roster ?? []).filter(a => seatAgent(a, seat, prefix))
  const claimByAgent = new Map(claims.flatMap(c => (c.agentName === undefined ? [] : [[c.agentName, c]])))
  const rows = (input.shepherd ?? []).filter(
    r => r.pr !== null && (prefix === undefined ? false : branchOfSeat(r.branch, prefix)),
  )
  const verdictFor = (pr: string, head: string | null): Pick<FlightPr, 'verdict' | 'verdictHead'> => {
    const mine = (input.verdicts ?? []).filter(v => prKey(v.pr) === prKey(pr))
    const exact = head === null ? undefined : mine.find(v => v.head === head)
    if (exact !== undefined) return { verdict: exact.verdict, verdictHead: null }
    const newest = mine[0]
    return newest === undefined
      ? { verdict: null, verdictHead: null }
      : { verdict: newest.verdict, verdictHead: newest.head }
  }
  const prs = new Map<string, FlightPr>()
  for (const r of rows) {
    const pr = `${r.repo}#${r.pr}`
    const claim = claims.find(c => claimPr(c) !== null && prKey(claimPr(c) as string) === prKey(pr))
    prs.set(prKey(pr), {
      pr,
      head: r.headSha,
      ...verdictFor(pr, r.headSha),
      ci: ciOf(r.phase),
      phase: r.phase,
      task: r.task,
      agent: claim?.agentName ?? null,
      claim: claim === undefined ? null : claimLabel(claim),
      nextAction: r.nextAction,
      pendingGate: r.pendingGate,
      flags: [...(r.held ? ['held'] : []), ...(r.stalled ? ['stalled'] : [])],
    })
  }
  for (const c of claims) {
    const pr = claimPr(c)
    if (pr === null || prs.has(prKey(pr))) continue
    prs.set(prKey(pr), {
      pr,
      head: c.prHead ?? null,
      ...verdictFor(pr, c.prHead ?? null),
      ci: 'unknown',
      phase: null,
      task: c.taskId,
      agent: c.agentName ?? null,
      claim: claimLabel(c),
      nextAction: null,
      pendingGate: null,
      flags: [],
    })
  }
  const names = new Set(agents.map(a => a.name))
  const hasPr = new Set([...prs.values()].flatMap(p => (p.agent === null ? [] : [p.agent])))
  return {
    prs: [...prs.values()],
    agents: agents
      .filter(a => !hasPr.has(a.name))
      .map(a => ({
        name: a.name,
        profile: a.profile,
        state: a.state,
        cwd: a.cwd,
        ...(claimByAgent.has(a.name) ? { claim: claimLabel(claimByAgent.get(a.name) as Claim) } : {}),
      }))
      .sort((x, y) => x.name.localeCompare(y.name)),
    claims: claims
      .filter(c => claimPr(c) === null && !(c.agentName !== undefined && names.has(c.agentName)))
      .map(claimLabel),
  }
}

type Settled<T> = { ok: true; value: T } | { ok: false; reason: string }

async function settle<T>(read: () => Promise<T>, plain: (err: unknown) => string): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read() }
  } catch (err) {
    return { ok: false, reason: plain(err) }
  }
}

/** Reads every port once; a port that throws is listed under `unavailable` and the rest still join. */
export async function readInFlight(
  ports: InFlightPorts,
  seat: string,
  prefix: string | undefined,
  plain: (err: unknown) => string,
): Promise<InFlight> {
  const [roster, shepherd, verdicts, claims] = await Promise.all([
    settle(ports.roster, plain),
    settle(ports.shepherd, plain),
    settle(ports.verdicts, plain),
    settle(ports.claims, plain),
  ])
  const value = <T>(s: Settled<T>): T | undefined => (s.ok ? s.value : undefined)
  const sources = { roster, shepherd, verdicts, claims }
  const unavailable = (Object.keys(sources) as InFlightSource[]).flatMap(source => {
    const s = sources[source]
    return s.ok ? [] : [{ source, reason: s.reason }]
  })
  const derived = deriveInFlight({
    seat,
    prefix,
    roster: value(roster),
    shepherd: value(shepherd),
    verdicts: value(verdicts),
    claims: value(claims),
  })
  return { ...derived, unavailable }
}

const SHORT = 8
const short = (sha: string | null): string => (sha === null ? '?' : sha.slice(0, SHORT))

const prLine = (p: FlightPr): string => {
  const verdict =
    p.verdict === null
      ? 'verdict none'
      : `verdict ${p.verdict}${p.verdictHead === null ? '' : ` (stale, at ${short(p.verdictHead)})`}`
  return [
    `pr ${p.pr}`,
    `head ${short(p.head)}`,
    verdict,
    `ci ${p.ci}`,
    ...(p.phase === null ? [] : [`phase ${p.phase}`]),
    ...(p.task === null ? [] : [`task ${p.task}`]),
    ...(p.agent === null ? [] : [`agent ${p.agent}`]),
    ...(p.claim === null ? [] : [`claim ${p.claim}`]),
    ...(p.pendingGate === null ? [] : [`gate ${p.pendingGate}`]),
    ...(p.nextAction === null ? [] : [`next ${p.nextAction}`]),
    ...p.flags,
  ].join(' | ')
}

export function inFlightLines(flight: InFlight, homeDir: string): string[] {
  const tilde = (p: string): string =>
    homeDir !== '' && p.startsWith(homeDir) ? `~${p.slice(homeDir.length)}` : p
  const agentLine = (a: FlightAgent): string =>
    [
      `agent ${a.name}`,
      a.profile,
      a.state,
      ...(a.claim === undefined ? [] : [`claim ${a.claim}`]),
      tilde(a.cwd),
    ].join(' | ')
  const body = [
    ...flight.prs.map(prLine),
    ...flight.agents.map(agentLine),
    ...flight.claims.map(c => `claim ${c} | no PR, no agent on the roster`),
  ]
  return [
    '== in flight (burndown claims, Shepherd, roster, verdicts)',
    ...(body.length === 0 ? ['in flight: none'] : body),
    ...flight.unavailable.map(u => `unavailable: ${u.source}`),
  ]
}
