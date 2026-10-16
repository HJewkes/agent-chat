import { burndownLedgerPath } from '../../paths.js'
import { heldUntil } from '../../agents/burndown/backoff.js'
import { shepherdTarget } from '../../agents/burndown/shepherd.js'
import {
  LEDGER_WAIT_MS,
  readLedger,
  withLedgerLock,
  writeLedger,
  type Claim,
  type Ledger,
  type LockResult,
  type LockWait,
} from '../../agents/burndown/ledger.js'
import type { Runner } from '../../agents/burndown/exec.js'
import { readSlices, type PlannedSlice } from '../../agents/burndown/report.js'
import {
  pendingOffLedger,
  sliceClaims,
  type PlanFile,
  type PlanReader,
} from '../../agents/burndown/seed-slices.js'
import { slicesReleasedUnclaimed } from '../../agents/burndown/slices-complete.js'
import type { Report } from '../command.js'

export type RetireCall = (name: string) => Promise<{ ok: boolean; reason?: string }>

const refusedReport = (message: string): Report => ({ ok: false, lines: [], errors: [message] })

/** CC-1181: the refusal after a wait that a tick held the lock through. */
const lockRefusal = (locked: Extract<LockResult<unknown>, { ran: false }>): Report =>
  refusedReport(
    `a tick held the ledger lock (pid ${locked.holder}) for the whole ${Math.round((locked.waited ?? 0) / 1000)}s wait; try again`,
  )

/** Newest first, the order `retireAll` in advance.ts uses; `spawned` is kept oldest first. */
const newestFirst = (claim: Claim): string[] => [...new Set([...(claim.spawned ?? [])].reverse())]

const describeClaim = (c: Claim): string =>
  `released ${c.taskId}${c.slice === undefined ? '' : ` slice ${c.slice}`} (${c.phase}${c.stalledReason === undefined ? '' : `, stalled: ${c.stalledReason}`})`

export async function retireNames(claim: Claim, retire: RetireCall): Promise<string[]> {
  const lines: string[] = []
  for (const name of newestFirst(claim)) {
    const reply = await retire(name).catch((err: Error) => ({ ok: false, reason: err.message }))
    lines.push(reply.ok ? `retired ${name}` : `left ${name}: ${reply.reason ?? 'refused'}`)
  }
  return lines
}

/**
 * Drops every held claim on `task`, counts the release toward its backoff (CC-700), then retires each
 * one's spawned agents; a refused retire never keeps a claim. A release with no held claim changes nothing,
 * except that a task with released slices and no slice claim (`slicesReleasedUnclaimed`) is cleared to reseed.
 * With `slice`, only that slice's claim is dropped (CC-978); see `releaseSlice`. `readPlan` lets it release an
 * unclaimed slice an off-ledger run holds (CC-1240).
 */
export async function releaseTask(
  task: string,
  retire: RetireCall,
  now = new Date(),
  slice?: string,
  readPlan?: PlanReader,
  wait: LockWait = { waitMs: LEDGER_WAIT_MS },
): Promise<Report> {
  const file = burndownLedgerPath()
  const locked = await withLedgerLock(
    file,
    () => {
      const ledger = readLedger(file)
      const dropped = ledger.claims.filter(
        c => c.taskId === task && c.phase !== 'done' && (slice === undefined || c.slice === slice),
      )
      if (dropped.length === 0 && slice !== undefined && waitsOnRun(ledger, task, slice, readPlan)) {
        writeLedger(file, releaseSlice(ledger, ledger.claims, task, slice))
        return { dropped, hold: undefined, unclaimed: true }
      }
      if (dropped.length === 0 && slice === undefined && slicesReleasedUnclaimed(ledger, task)) {
        writeLedger(file, withoutSliceReleases(ledger, task))
        return { dropped, hold: undefined, reseedable: true }
      }
      if (dropped.length === 0) return { dropped, hold: undefined }
      const claims = ledger.claims.filter(c => !dropped.includes(c))
      if (slice !== undefined) {
        writeLedger(file, releaseSlice(ledger, claims, task, slice))
        return { dropped, hold: undefined }
      }
      const record = { n: (ledger.releases?.[task]?.n ?? 0) + 1, at: now.toISOString() }
      writeLedger(file, {
        ...withoutSliceReleases(ledger, task),
        claims,
        releases: { ...ledger.releases, [task]: record },
      })
      return { dropped, hold: record }
    },
    { wait, announce: true },
  )
  if (!locked.ran) return lockRefusal(locked)
  const { dropped, hold } = locked.value
  const what = slice === undefined ? task : `${task} slice ${slice}`
  if ('unclaimed' in locked.value)
    return { ok: true, lines: [`released ${what}, which had no claim; the task no longer waits on it`] }
  if ('reseedable' in locked.value)
    return {
      ok: true,
      lines: [`released ${task}, whose slices were released with none held; it can be seeded again`],
    }
  if (dropped.length === 0) return refusedReport(`no held claim on ${what}`)
  const lines: string[] = []
  for (const claim of dropped) lines.push(describeClaim(claim), ...(await retireNames(claim, retire)))
  if (hold !== undefined)
    lines.push(`released ${hold.n} times; held until ${new Date(heldUntil(hold)).toISOString()}`)
  return { ok: true, lines }
}

/**
 * One slice's release: the task's other slices keep their claims, the task stays seeded, and the dropped
 * slice no longer gates its dependents. No backoff is counted, since that would hold the other slices back.
 */
function releaseSlice(ledger: Ledger, claims: Claim[], task: string, slice: string): Ledger {
  const released = [...new Set([...(ledger.slicesReleased?.[task] ?? []), slice])]
  return { ...ledger, claims, slicesReleased: { ...ledger.slicesReleased, [task]: released } }
}

/**
 * CC-1240: every slice claim of the task is done, and the plan's slice has no claim but an off-ledger run that
 * never opened a PR. Releasing it is the only way the task stops waiting on that run. With no plan reader, none is.
 */
function waitsOnRun(ledger: Ledger, task: string, slice: string, readPlan?: PlanReader): boolean {
  const claims = ledger.claims.filter(c => c.taskId === task && c.slice !== undefined)
  const parent = claims[0]
  if (readPlan === undefined || parent === undefined || claims.some(c => c.phase !== 'done')) return false
  return pendingOffLedger(ledger, readPlan)(parent.initiative, task).includes(slice)
}

/**
 * A whole-task release lets the task be seeded again. CC-1256: so does one with no held claim, which only
 * clears the released slices and counts no backoff, since no agent was dropped.
 */
function withoutSliceReleases(ledger: Ledger, task: string): Ledger {
  const { slicesReleased: all, ...rest } = ledger
  const { [task]: _cleared, ...kept } = all ?? {}
  return Object.keys(kept).length === 0 ? rest : { ...rest, slicesReleased: kept }
}

/** CC-1141 b: what a re-link reads of a PR from GitHub. */
export interface LinkedPull {
  title: string
  state: string
  branch: string
}

/** CC-1141 b: the reads a re-link of a slice with no held claim needs; without them, only a queued slice links. */
export interface LinkPorts {
  plan: PlanReader
  /** The PR's title, state and head branch; undefined when GitHub could not tell. */
  pull: (pr: string) => LinkedPull | undefined
  now?: Date
}

// REST, never GraphQL: the owner's account hits GraphQL rate limits.
export const pullReader =
  (exec: Runner) =>
  (pr: string): LinkedPull | undefined => {
    const target = shepherdTarget(pr)
    if (target === undefined) return undefined
    const result = exec('gh', [
      'api',
      `repos/${target.repo}/pulls/${target.pr}`,
      '--jq',
      '{title, state, branch: .head.ref}',
    ])
    if (result.status !== 0) return undefined
    try {
      const pull = JSON.parse(result.stdout) as Partial<LinkedPull>
      const fields = [pull.title, pull.state, pull.branch]
      return fields.every(f => typeof f === 'string') ? (pull as LinkedPull) : undefined
    } catch {
      return undefined
    }
  }

const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The whole task id, any case, so `CC-12` never names `CC-1`. */
export const namesTask = (text: string, task: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9])${escaped(task)}(?![0-9])`, 'i').test(text)

/**
 * CC-978: records a hand-dispatched PR on a queued slice, so the tick never dispatches the slice and
 * finishes it when the PR merges. Refused for a claim that is not queued or a PR Shepherd cannot name.
 * CC-1141 b: with `ports`, a released slice is re-created as a queued claim carrying the PR.
 * CC-1044 c: an implementing slice with no PR takes one too, so a PR the tick never linked still finishes it.
 */
export async function linkSlicePr(
  task: string,
  slice: string,
  pr: string,
  wait: LockWait = { waitMs: LEDGER_WAIT_MS },
  ports?: LinkPorts,
): Promise<Report> {
  if (shepherdTarget(pr) === undefined)
    return refusedReport(`${pr} is not a GitHub PR (owner/repo#n or its URL)`)
  const file = burndownLedgerPath()
  const locked = await withLedgerLock(file, () => linkHeld(file, task, slice, pr), {
    wait,
    announce: true,
  })
  if (!locked.ran) return lockRefusal(locked)
  if (locked.value === NO_CLAIM && ports !== undefined) return relinkSlice(task, slice, pr, ports, wait)
  if (locked.value !== undefined)
    return refusedReport(
      `${task} slice ${slice} ${locked.value}; only a queued or unlinked implementing slice takes a link`,
    )
  return {
    ok: true,
    lines: [`linked ${task} slice ${slice} to ${pr}; the tick finishes it when the PR merges`],
  }
}

const NO_CLAIM = 'has no held claim'

/** Why a held claim cannot take the PR: a phase past implementing, or an implementing claim holding another PR. */
function linkRefusal(claim: Claim, pr: string): string | undefined {
  if (claim.phase === 'queued') return undefined
  if (claim.phase !== 'implementing') return `is not queued or implementing (${claim.phase})`
  if (claim.pr === undefined || claim.pr === pr) return undefined
  return `already holds ${claim.pr}`
}

/** Links the queued or unlinked implementing claim, or says why it refuses. */
function linkHeld(file: string, task: string, slice: string, pr: string): string | undefined {
  const ledger = readLedger(file)
  const claim = ledger.claims.find(c => c.taskId === task && c.slice === slice && c.phase !== 'done')
  if (claim === undefined) return NO_CLAIM
  const refusal = linkRefusal(claim, pr)
  if (refusal !== undefined) return refusal
  writeLedger(file, { ...ledger, claims: ledger.claims.map(c => (c === claim ? { ...c, pr } : c)) })
  return undefined
}

/** CC-1141 b: an open PR naming the task re-creates the slice's queued claim from the plan. */
async function relinkSlice(
  task: string,
  slice: string,
  pr: string,
  ports: LinkPorts,
  wait: LockWait,
): Promise<Report> {
  const what = `${task} slice ${slice}`
  const pull = ports.pull(pr)
  if (pull === undefined) return refusedReport(`${what} has no held claim, and ${pr} could not be read`)
  if (pull.state !== 'open') return refusedReport(`${what} has no held claim, and ${pr} is ${pull.state}`)
  if (!namesTask(pull.title, task) && !namesTask(pull.branch, task))
    return refusedReport(`${what} has no held claim, and neither ${pr}'s title nor its branch names ${task}`)
  const file = burndownLedgerPath()
  const locked = await withLedgerLock(file, () => relinkLocked(file, task, slice, pr, ports), {
    wait,
    announce: true,
  })
  if (!locked.ran) return lockRefusal(locked)
  if (locked.value !== undefined) return refusedReport(`${what}: ${locked.value}`)
  return {
    ok: true,
    lines: [`re-created ${what} as a queued claim linked to ${pr}; it finishes when the PR merges`],
  }
}

/** Writes the re-created claim, or says why it cannot. */
function relinkLocked(
  file: string,
  task: string,
  slice: string,
  pr: string,
  ports: LinkPorts,
): string | undefined {
  const ledger = readLedger(file)
  const ofTask = ledger.claims.filter(c => c.taskId === task)
  const existing = ofTask.find(c => c.slice === slice)
  if (existing !== undefined) return `its claim is ${existing.phase}; only a released slice re-links`
  // Only the seeder writes a whole plan, with the seat and name prefix its seat dispatches under; a re-link
  // copies both from a claim it seeded and adds back the one slice that seeding's plan is missing.
  const parent = ofTask.find(c => c.slice !== undefined)
  if (parent === undefined) return `the task holds no slice claim; ${SEED_FIRST}`
  const planned = plannedSlices(ports.plan(parent.initiative, task), slice)
  if (typeof planned === 'string') return planned
  const missing = unseeded(ledger, ofTask, planned, task).filter(n => n !== slice)
  if (missing.length > 0) return `slices ${missing.join(', ')} have no claim either; ${SEED_FIRST}`
  const named = planned.filter(s => s.n === slice)
  const added = sliceClaims(parent, named, ports.now ?? new Date()).map(c => ({ ...c, pr }))
  writeLedger(file, unreleased({ ...ledger, claims: [...ledger.claims, ...added] }, task, slice))
  return undefined
}

const SEED_FIRST = 'release the task so the tick seeds it, then link the queued slice'

/** The plan slices with neither a claim nor a release: the ones the seeding that this re-link extends never wrote. */
function unseeded(ledger: Ledger, ofTask: Claim[], planned: PlannedSlice[], task: string): string[] {
  const covered = new Set([...ofTask.map(c => c.slice), ...(ledger.slicesReleased?.[task] ?? [])])
  return planned.map(s => s.n).filter(n => !covered.has(n))
}

/** Every slice of the plan, or why the plan or the named slice cannot be read. */
function plannedSlices({ path, text }: PlanFile, slice: string): PlannedSlice[] | string {
  if (text === undefined) return `no plan at ${path}`
  const read = readSlices(text)
  if (read.slices === undefined) return `plan unreadable: ${read.problems.join('; ')}`
  return read.slices.some(s => s.n === slice) ? read.slices : `slice ${slice} is not in ${path}`
}

/** Drops the slice from the task's released slices, and the task's key once none is left. */
function unreleased(ledger: Ledger, task: string, slice: string): Ledger {
  const left = (ledger.slicesReleased?.[task] ?? []).filter(n => n !== slice)
  if (left.length > 0) return { ...ledger, slicesReleased: { ...ledger.slicesReleased, [task]: left } }
  return ledger.slicesReleased?.[task] === undefined ? ledger : withoutSliceReleases(ledger, task)
}
