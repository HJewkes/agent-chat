import path from 'node:path'
import { FINISHED_PHASES, parseShepherdRows } from '../../shepherd-client.js'
import type { Ledger } from '../burndown/ledger.js'
import { isRead } from './explain.js'
import type {
  FileClaim,
  LiveSnapshot,
  ParkKept,
  ParkKeptClass,
  PrRow,
  ProcessRow,
  Read,
  Roster,
  Shepherd,
  ShepherdRun,
  WorktreeRow,
} from './types.js'

/**
 * CC-1282 (K2): read live state into K1's `LiveSnapshot`. Read-only: every reader is a query, none writes the ledger
 * or sends a broker mutation. A reader that throws becomes that input's `{ error }`, so its counts print `unread`.
 */

/** A park-kept line as the broker logs it, keyed by agent: the tree is that agent's roster `cwd`. */
export interface KeptLine {
  agentId: string
  reason: string
  at: string
}

/** Shepherd's `prs --json` snapshot: open PRs per repo, and when the snapshot was last taken. */
export interface PrSnapshot {
  at?: string
  byRepo: Record<string, PrRow[]>
}

export interface LiveReaders {
  now: () => Date
  tickMs: number
  sweepMs: number
  roster: () => Promise<{ roster: Roster; semaphore?: { held: number; cap: number } }>
  list: () => Promise<{ sessions: string[]; fileClaims: FileClaim[] }>
  processes: () => Promise<ProcessRow[]>
  seatRepos: () => Promise<string[]>
  worktrees: (repo: string) => Promise<WorktreeRow[]>
  shepherdPrs: () => Promise<PrSnapshot>
  /** One `gh` call for the repo's open PRs; used only when Shepherd's snapshot is unread or stale (R10). */
  ghPrs: (repo: string) => Promise<PrRow[]>
  shepherd: () => Promise<Shepherd>
  ledger: () => Promise<Ledger>
  lastTick: () => Promise<LiveSnapshot['lastTick']>
  parkKept: () => Promise<KeptLine[]>
}

export const PR_SNAPSHOT_MAX_AGE_MS = 10 * 60_000

/** One line, since a count line quotes it: a failed command's message carries the command and its stderr. */
const message = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err))
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .join(' / ')

async function attempt<T>(fn: () => Promise<T>): Promise<Read<T>> {
  try {
    return { value: await fn() }
  } catch (err) {
    return { error: message(err) }
  }
}

const once = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
  let memo: Promise<T> | undefined
  return () => (memo ??= fn())
}

export async function readLive(r: LiveReaders): Promise<LiveSnapshot> {
  const now = r.now()
  const seatRepos = once(() => attempt(r.seatRepos))
  const [roster, list, processes, worktrees, prs, shepherd, ledger, lastTick, kept] = await Promise.all([
    attempt(r.roster),
    attempt(r.list),
    attempt(r.processes),
    perRepo(seatRepos, r.worktrees),
    readPrs(r, seatRepos, now),
    attempt(r.shepherd),
    attempt(r.ledger),
    attempt(r.lastTick),
    attempt(r.parkKept),
  ])
  const rosterRead = map(roster, v => v.roster)
  return {
    now,
    tickMs: r.tickMs,
    sweepMs: r.sweepMs,
    roster: rosterRead,
    processes,
    sessions: both(list, rosterRead, (l, ros) => seatSessions(l.sessions, ros)),
    fileClaims: map(list, v => v.fileClaims),
    worktrees,
    prs,
    shepherd,
    ledger,
    semaphore: isRead(roster) ? semaphoreOf(roster.value.semaphore) : roster,
    parkKept: both(kept, rosterRead, keptTrees),
    ...(isRead(lastTick) && lastTick.value !== undefined ? { lastTick: lastTick.value } : {}),
  }
}

const map = <T, U>(read: Read<T>, fn: (v: T) => U): Read<U> =>
  isRead(read) ? { value: fn(read.value) } : read

const both = <A, B, U>(a: Read<A>, b: Read<B>, fn: (a: A, b: B) => U): Read<U> =>
  isRead(a) ? (isRead(b) ? { value: fn(a.value, b.value) } : b) : a

const semaphoreOf = (
  slots: { held: number; cap: number } | undefined,
): Read<{ held: number; cap: number }> =>
  slots === undefined ? { error: 'broker reported no slot semaphore' } : { value: slots }

/** Registered sessions that are no spawned agent: seats and humans, which run a process but hold no slot. */
const seatSessions = (sessions: string[], roster: Roster): string[] => {
  const agents = new Set(roster.rows.map(row => row.name))
  return [...new Set(sessions)].filter(name => !agents.has(name))
}

async function perRepo<T>(
  repos: () => Promise<Read<string[]>>,
  read: (repo: string) => Promise<T>,
): Promise<Record<string, Read<T>>> {
  const list = await repos()
  if (!isRead(list)) return { 'seat repos': list }
  const entries = await Promise.all(
    list.value.map(async repo => [repo, await attempt(() => read(repo))] as const),
  )
  return Object.fromEntries(entries)
}

/** Shepherd's snapshot when it is fresh; otherwise one `gh` read per seat repo (R10). */
async function readPrs(
  r: LiveReaders,
  repos: () => Promise<Read<string[]>>,
  now: Date,
): Promise<LiveSnapshot['prs']> {
  const snapshot = await attempt(r.shepherdPrs)
  if (isRead(snapshot) && isFresh(snapshot.value.at, now))
    return Object.fromEntries(
      Object.entries(snapshot.value.byRepo).map(([repo, rows]) => [repo, { value: rows }]),
    )
  return perRepo(repos, r.ghPrs)
}

const isFresh = (at: string | undefined, now: Date): boolean =>
  at !== undefined && now.getTime() - Date.parse(at) <= PR_SNAPSHOT_MAX_AGE_MS

/** Both spellings the ledger records on `Claim.pr`, since K1 looks a claim's PR up by exact string. */
export const prKeys = (repo: string, pr: number): string[] => [
  `${repo}#${pr}`,
  `https://github.com/${repo}/pull/${pr}`,
]

function keptTrees(lines: KeptLine[], roster: Roster): ParkKept[] {
  const cwd = new Map(roster.rows.map(row => [row.agentId, row.cwd]))
  return lines.flatMap(line => {
    const tree = cwd.get(line.agentId)
    return tree === undefined
      ? []
      : [{ tree, class: keptClass(line.reason), reason: line.reason, at: line.at }]
  })
}

const KEPT_CLASSES: readonly (readonly [RegExp, ParkKeptClass])[] = [
  [/^burndown claim .* holds the tree/, 'claim-hold'],
  [/fix round/, 'shepherd-fix-round'],
  [/^ignored files/, 'ignored-files'],
  [/not on origin|unpushed/, 'unpushed'],
  [/uncommitted|untracked|modified|dirty/, 'dirty'],
  [/also works in|process/, 'process'],
]

/** The class of a keep the broker logged as text only; anything unrecognised is an `error` keep. */
export const keptClass = (reason: string): ParkKeptClass =>
  KEPT_CLASSES.find(([re]) => re.test(reason))?.[1] ?? 'error'

const KEPT_EVENTS: ReadonlySet<string> = new Set(['implementer_park_kept', 'reviewer_park_kept'])

/** Park-kept lines of `broker.log` (before K12 records them in `events.db`); other lines are skipped. */
export function parseParkKept(log: string): KeptLine[] {
  return log.split('\n').flatMap(line => {
    if (!line.includes('_park_kept')) return []
    try {
      const row = JSON.parse(line) as Record<string, unknown>
      const { ts, event, agentId, reason } = row
      if (typeof event !== 'string' || !KEPT_EVENTS.has(event)) return []
      if (typeof ts !== 'string' || typeof agentId !== 'string' || typeof reason !== 'string') return []
      return [{ agentId, reason, at: ts }]
    } catch {
      return []
    }
  })
}

const SETTINGS_ARG = /agents\/([^/\s]+)\/settings\.json/
const NAME_ARG = /--name[= ](\S+)/

/** `ps -eo pid,args` rows whose executable is `claude`, with the agent id from its settings path and its `--name`. */
export function parseProcesses(ps: string): ProcessRow[] {
  return ps.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\S+)(.*)$/.exec(line)
    if (match === null || path.basename(match[2] as string) !== 'claude') return []
    const args = `${match[2]}${match[3]}`
    const agentId = SETTINGS_ARG.exec(args)?.[1]
    const name = NAME_ARG.exec(args)?.[1]
    return [
      {
        pid: Number(match[1]),
        ...(agentId === undefined ? {} : { agentId }),
        ...(name === undefined ? {} : { name }),
      },
    ]
  })
}

/**
 * `shepherd status --json`: a bare run list today, or an object carrying `runs` and K14's `reviewSlots`. A slot
 * reading with a `rosterError`, or none at all, is left out, so K1 prints Shepherd's reviewers as unread (R11).
 */
export function parseShepherdStatus(stdout: string): Shepherd {
  const parsed = JSON.parse(stdout) as unknown
  const body = (Array.isArray(parsed) ? { runs: parsed } : parsed) as {
    runs?: unknown
    reviewSlots?: unknown
  }
  const rows = Array.isArray(body.runs)
    ? parseShepherdRows(JSON.stringify(body.runs), () => undefined)
    : undefined
  if (rows === undefined) throw new Error('shepherd status --json carried no run list')
  const runs: ShepherdRun[] = rows.flatMap(row =>
    row.pr === null
      ? []
      : prKeys(row.repo, row.pr).map(pr => ({ pr, ended: FINISHED_PHASES.includes(row.phase) })),
  )
  const slots = reviewSlotsOf(body.reviewSlots)
  return slots === undefined ? { runs } : { runs, reviewSlots: slots }
}

function reviewSlotsOf(raw: unknown): Shepherd['reviewSlots'] {
  const slots = raw as { running?: unknown; cap?: unknown; rosterError?: unknown } | undefined
  if (slots === undefined || slots === null || slots.rosterError !== undefined) return undefined
  const { running, cap } = slots
  if (!Array.isArray(running) || !running.every(n => typeof n === 'string') || typeof cap !== 'number')
    return undefined
  return { running, cap }
}

interface SnapshotPr {
  repo?: unknown
  number?: unknown
  state?: unknown
  source?: unknown
  at?: unknown
}

/** `shepherd prs --json`: open and recently merged PRs; the newest snapshot row's `at` dates the snapshot. */
export function parsePrSnapshot(stdout: string): PrSnapshot {
  const parsed = JSON.parse(stdout) as unknown
  if (!Array.isArray(parsed)) throw new Error('shepherd prs --json is not a list')
  const byRepo: Record<string, PrRow[]> = {}
  let at: string | undefined
  for (const pr of parsed as SnapshotPr[]) {
    if (typeof pr.repo !== 'string' || typeof pr.number !== 'number') continue
    if (pr.state !== 'open' && pr.state !== 'merged' && pr.state !== 'closed') continue
    if (pr.source === 'snapshot' && typeof pr.at === 'string' && (at === undefined || pr.at > at)) at = pr.at
    const rows = prKeys(pr.repo, pr.number).map(key => ({ pr: key, state: pr.state as PrRow['state'] }))
    ;(byRepo[pr.repo] ??= []).push(...rows)
  }
  return at === undefined ? { byRepo } : { at, byRepo }
}
