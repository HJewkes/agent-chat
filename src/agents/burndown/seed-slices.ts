import fs from 'node:fs'
import path from 'node:path'
import type { Action } from './advance.js'
import { planPathFor } from './brief.js'
import type { Step } from './execute.js'
import type { Claim, Ledger } from './ledger.js'
import type { DispatchRecord } from '../seats/dispatch-record.js'
import {
  adoptOffLedger,
  firstDispatches,
  offLedgerRunsIn,
  seatDispatchRecords,
  type OffLedgerRun,
  type SeatPrReader,
  type SliceRuns,
} from './off-ledger-adopt.js'
import { defaultAutonomyRoot } from './policy.js'
import { readSlices, type PlannedSlice } from './report.js'
import { mergedFlagKey, slicesSettled } from './slices-complete.js'

/**
 * CC-927 (item 179 S3): a seat-written `sources/<ID>-plan.md` is the brief. A brief-ready task
 * whose plan holds a `burndown-slices` block that passes the planner's lint is queued as slice
 * claims of the shape a planner's report leaves, and no planner is spawned. A plan that fails
 * the lint blocks the task rather than being planned over. Pure but for `diskPlanReader`.
 */

/**
 * A task's plan file: its path, and its text when the file exists. Read for a seat, it also carries the slice
 * agents that seat's dispatch log shows for the task (CC-1233), or why the log could not be read, since the
 * tick hands the drift resync only a plan reader.
 */
export interface PlanFile {
  path: string
  text: string | undefined
  ranOffLedger?: string[]
  /** CC-1240: each of those agents' first dispatch, so a PR merged before the run is not taken for its work. */
  ranSince?: Record<string, string>
  runsUnread?: string
}

/** The seat whose dispatch log names the task's slice agents. */
export interface SeatRef {
  seat: string
  prefix: string
}

export type PlanReader = (initiative: string, taskId: string, seat?: SeatRef) => PlanFile

const planText = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function seatRuns(autonomyRoot: string, taskId: string, { seat, prefix }: SeatRef): Partial<PlanFile> {
  try {
    const records = seatDispatchRecords(autonomyRoot, seat) ?? []
    const ranOffLedger = sliceRunsIn(records, taskId, prefix)
    return { ranOffLedger, ranSince: firstDispatches(records, ranOffLedger) }
  } catch (err) {
    return {
      runsUnread: `slice runs unread for seat ${seat}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export const diskPlanReader =
  (root: string, autonomyRoot?: string): PlanReader =>
  (initiative, taskId, seat) => {
    const file = planPathFor(path.join(root, initiative), taskId)
    const runs = seat === undefined ? {} : seatRuns(autonomyRoot ?? defaultAutonomyRoot(root), taskId, seat)
    return { path: file, text: planText(file), ...runs }
  }

type Parent = Pick<Claim, 'taskId' | 'initiative' | 'seat' | 'namePrefix'>

/** One `queued` claim per slice, keeping the parent's seat and name prefix so its agents count as the seat's. */
export function sliceClaims(parent: Parent, slices: readonly PlannedSlice[], now: Date): Claim[] {
  const at = now.toISOString()
  return slices.map(s => ({
    taskId: parent.taskId,
    initiative: parent.initiative,
    spawnedAt: at,
    phase: 'queued',
    phaseAt: at,
    slice: s.n,
    dependsOn: s.dependsOn,
    ...(s.owns.length === 0 ? {} : { owns: s.owns }),
    ...(s.repo === undefined ? {} : { repo: s.repo }),
    ...((s.contracts ?? []).length === 0 ? {} : { contracts: s.contracts }),
    ...(parent.seat === undefined ? {} : { seat: parent.seat }),
    ...(parent.namePrefix === undefined ? {} : { namePrefix: parent.namePrefix }),
  }))
}

/** The tick adds the seeded claims before its dispatches; a tick that seeded nothing writes nothing. */
export const seedSteps = (seeds: readonly Claim[] = []): Step[] =>
  seeds.length === 0 ? [] : [{ kind: 'ledger', actions: [{ kind: 'add', claims: [...seeds] }] }]

/** `warnings` are the slice lint's advisory lines (CC-1155); they never block seeding. */
/** `notes` say how each slice run outside the ledger was adopted or left alone (CC-1233). */
/** `merged`: every slice of the task is done, so there is nothing to seed and nothing to refuse (CC-1049). */
/**
 * `pending`: every claim is done, but a slice's off-ledger run has no claim yet, so the task is not merged (CC-1240).
 * `claims` adopts the runs whose branch PR is open or merged; the rest wait on a PR or a slice release.
 */
export type Seeding =
  | { claims: Claim[]; plan: string; warnings: string[]; notes: string[] }
  | { blocked: string }
  | { merged: true }
  | { pending: string[]; claims: Claim[]; notes: string[] }

export type { SliceRuns }

const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * CC-1121 b: the `<prefix>-<id>-<slice>` agents a seat's dispatch log records for `taskId`. A slice
 * run by hand leaves no ledger claim, so only this log shows that seeding it would run it again.
 */
export function sliceRunsIn(records: readonly DispatchRecord[], taskId: string, prefix: string): string[] {
  const name = new RegExp(`^${escaped(prefix)}-${escaped(taskId.toLowerCase())}-[a-z]$`)
  const agents = records.filter(r => r.task === taskId && name.test(r.agent)).map(r => r.agent)
  return [...new Set(agents)]
}

/**
 * Why a task whose slices were seeded before is not seeded again. A held slice claim reads "already queued";
 * CC-1256: released slices with none held name the slices and how to reseed.
 */
function alreadySeeded(taskId: string, planPath: string, ledger: Ledger): string | undefined {
  const held = ledger.claims.some(c => c.taskId === taskId && c.slice !== undefined && c.phase !== 'done')
  if (held) return `${planPath}: slices of ${taskId} were already queued; close the task or replan it`
  const released = ledger.slicesReleased?.[taskId]
  if (released === undefined) return undefined
  return (
    `${planPath}: slices ${released.join(', ')} of ${taskId} were released and none is held; ` +
    `close the task, or run agent-chat burndown release ${taskId} to reseed`
  )
}

/**
 * The task's slices from its plan file, why the plan blocks it, or undefined when there is no
 * plan file and the planner runs as before. A task whose slices were queued, or had one released, is not seeded
 * twice (`alreadySeeded`); CC-1233: slices whose agents ran outside the ledger are adopted by their branch PRs, and seeding waits a
 * tick while any of those PRs could not be read.
 */
export function seedSlices(
  parent: Parent,
  plan: PlanFile,
  ledger: Ledger,
  now: Date,
  ranOffLedger?: SliceRuns,
): Seeding | undefined {
  if (plan.text === undefined) return undefined
  if (slicesSettled(ledger, parent.taskId))
    return settledSeeding(
      parent,
      plan.text,
      ledger,
      now,
      ranOffLedger?.(parent.taskId, parent.initiative) ?? [],
    )
  const seeded = alreadySeeded(parent.taskId, plan.path, ledger)
  if (seeded !== undefined) return { blocked: seeded }
  const read = readSlices(plan.text)
  if (read.slices === undefined) return { blocked: `${plan.path}: ${read.problems.join('; ')}` }
  const runs = ranOffLedger?.(parent.taskId, parent.initiative) ?? []
  const unread = runs.filter(r => r.pr === undefined).map(r => r.agent)
  if (unread.length > 0)
    return {
      blocked: `${plan.path}: could not read the branch PRs of ${unread.join(', ')}, slice agents of ${parent.taskId} that ran outside the ledger; seeding waits a tick`,
    }
  const { claims, notes } = adoptOffLedger(sliceClaims(parent, read.slices, now), runs)
  return { claims, plan: plan.path, warnings: read.warnings, notes }
}

const hasPr = (r: OffLedgerRun): boolean => r.pr?.kind === 'open' || r.pr?.kind === 'merged'

/** Why a settled task's slice waits on its off-ledger run, and how to stop waiting on a run that was abandoned. */
const pendingNote = (parent: Parent, r: OffLedgerRun): string =>
  `${parent.initiative} ${parent.taskId} slice ${r.slice} ran as ${r.agent} outside the ledger with ${r.pr === undefined ? 'a branch PR that could not be read' : 'no open or merged PR yet'}, so the task is not merged; if that run was abandoned, run agent-chat burndown release ${parent.taskId} --slice ${r.slice}`

/**
 * CC-1240: every claim of the task is done. A plan slice whose off-ledger run has an open or merged branch PR is
 * adopted as at seeding; one whose run has none keeps the task from being merged until its PR opens or it is released.
 */
function settledSeeding(
  parent: Parent,
  text: string,
  ledger: Ledger,
  now: Date,
  runs: readonly OffLedgerRun[],
): Seeding {
  const slices = readSlices(text).slices ?? []
  const waiting = unclaimedRuns(ledger, parent.taskId, runs).filter(r => slices.some(s => s.n === r.slice))
  if (waiting.length === 0) return { merged: true }
  const adoptable = waiting.filter(hasPr)
  const pending = waiting.filter(r => !hasPr(r))
  const queued = sliceClaims(
    parent,
    slices.filter(s => adoptable.some(r => r.slice === s.n)),
    now,
  )
  const adopted = adoptOffLedger(queued, adoptable)
  return {
    pending: pending.map(r => r.slice),
    claims: adopted.claims,
    notes: [...adopted.notes, ...pending.map(r => pendingNote(parent, r))],
  }
}

/** CC-977: the update actions that carry an edited plan into its queued slice claims, and a note for each change or drift. */
export interface Resync {
  actions: Action[]
  notes: string[]
}

type SliceFields = Pick<Claim, 'owns' | 'dependsOn' | 'repo' | 'contracts'>

/** The fields `sliceClaims` sets, with `undefined` where it would leave one out. */
function sliceFields(s: PlannedSlice): SliceFields {
  return {
    owns: s.owns.length === 0 ? undefined : s.owns,
    dependsOn: s.dependsOn,
    repo: s.repo,
    contracts: (s.contracts ?? []).length === 0 ? undefined : s.contracts,
  }
}

/** Each field normalised so `[]` equals absent and order does not count. */
const shown = (f: SliceFields): Record<keyof SliceFields, string> => ({
  owns: JSON.stringify([...(f.owns ?? [])].sort()),
  dependsOn: JSON.stringify([...(f.dependsOn ?? [])].sort()),
  repo: JSON.stringify(f.repo ?? null),
  contracts: JSON.stringify((f.contracts ?? []).map(c => `${c.op} ${c.scope}`).sort()),
})

const FIELDS = ['owns', 'dependsOn', 'repo', 'contracts'] as const

function resyncClaim(claim: Claim, slice: PlannedSlice, plan: string): Resync {
  const next = sliceFields(slice)
  const [before, after] = [shown(claim), shown(next)]
  const changed = FIELDS.filter(f => before[f] !== after[f])
  if (changed.length === 0) return { actions: [], notes: [] }
  const what = changed.map(f => `${f} ${before[f]} -> ${after[f]}`).join('; ')
  return {
    actions: [{ kind: 'update', key: { taskId: claim.taskId, slice: claim.slice }, patch: next }],
    notes: [`resynced ${claim.initiative} ${claim.taskId} slice ${claim.slice} from ${plan}: ${what}`],
  }
}

/** CC-1240: the runs whose slice has no claim and was not released; each waits on a PR to be adopted. */
function unclaimedRuns<T extends { slice: string }>(ledger: Ledger, taskId: string, runs: readonly T[]): T[] {
  const claimed = new Set(ledger.claims.filter(c => c.taskId === taskId).map(c => c.slice))
  const released = ledger.slicesReleased?.[taskId] ?? []
  return runs.filter(r => !claimed.has(r.slice) && !released.includes(r.slice))
}

/**
 * CC-1240: the slices of tasks whose claims are all done that an off-ledger run still holds with no claim, by
 * `<initiative>/<task>`. Such a task is not merged: its PR may open, and the resync then adopts it.
 */
export function pendingOffLedger(
  ledger: Ledger,
  readPlan: PlanReader,
): (initiative: string, taskId: string) => string[] {
  return (initiative, taskId) => {
    const parent = ledger.claims.find(
      c => c.initiative === initiative && c.taskId === taskId && c.slice !== undefined,
    )
    if (parent === undefined) return []
    const plan = readPlan(...planOf(parent))
    if (plan.text === undefined) return []
    const inPlan = new Set(readSlices(plan.text).slices?.map(s => s.n))
    const runs = (plan.ranOffLedger ?? []).map(agent => ({ agent, slice: agent.slice(-1) }))
    return unclaimedRuns(ledger, taskId, runs)
      .filter(r => inPlan.has(r.slice))
      .map(r => r.slice)
  }
}

const isWaiting = (c: Claim): boolean =>
  c.phase === 'queued' && c.agentName === undefined && c.pr === undefined

/**
 * CC-1233: why the resync holds a new slice rather than queue it: the seat's dispatch log shows its
 * `<prefix>-<id>-<slice>` agent, or the log could not be read, which holds every new slice. A claim with no seat
 * names no log, so none ran.
 */
function heldBy(plan: PlanFile): (slice: string) => string | undefined {
  return slice => {
    if (plan.runsUnread !== undefined) return plan.runsUnread
    const agent = (plan.ranOffLedger ?? []).find(a => a.slice(-1) === slice)
    return agent === undefined ? undefined : `its agent ${agent} ran outside the ledger`
  }
}

/**
 * CC-1240: the held slices whose off-ledger run now has an open or merged branch PR, adopted as `adoptOffLedger`
 * does at seeding. A run whose PR could not be read, or has none, stays held.
 */
function adoptedRuns(
  parent: Claim,
  held: readonly PlannedSlice[],
  plan: PlanFile,
  prOf: SeatPrReader | undefined,
  now: Date,
): { claims: Claim[]; notes: string[] } {
  const reader = parent.seat === undefined ? undefined : prOf?.(parent.seat, parent.initiative)
  if (reader === undefined || plan.runsUnread !== undefined) return { claims: [], notes: [] }
  const agents = (plan.ranOffLedger ?? []).filter(a => held.some(s => s.n === a.slice(-1)))
  const runs = offLedgerRunsIn(plan.ranSince ?? {}, agents, reader)
  const adoptable = runs.filter(r => r.pr?.kind === 'open' || r.pr?.kind === 'merged')
  const queued = sliceClaims(
    parent,
    held.filter(s => adoptable.some(r => r.slice === s.n)),
    now,
  )
  const adopted = adoptOffLedger(queued, adoptable)
  return { claims: adopted.claims, notes: adopted.notes }
}

function resyncTask(
  ledger: Ledger,
  claims: readonly Claim[],
  plan: PlanFile,
  now: Date,
  prOf?: SeatPrReader,
): Resync {
  const { initiative, taskId } = claims[0] as Claim
  if (plan.text === undefined) return { actions: [], notes: [] }
  const read = readSlices(plan.text)
  if (read.slices === undefined)
    return {
      actions: [],
      notes: [
        `plan drift ${initiative} ${taskId}: ${plan.path} fails the lint (${read.problems.join('; ')}); queued slices keep their owns`,
      ],
    }
  const inPlan = new Set(read.slices.map(s => s.n))
  const known = new Set([...claims.map(c => c.slice), ...(ledger.slicesReleased?.[taskId] ?? [])])
  const unclaimed = read.slices.filter(s => !known.has(s.n))
  const why = heldBy(plan)
  const fresh = unclaimed.filter(s => why(s.n) === undefined)
  const adopting = adoptedRuns(
    claims[0] as Claim,
    unclaimed.filter(s => !fresh.includes(s)),
    plan,
    prOf,
    now,
  )
  const adoptedSlices = new Set(adopting.claims.map(c => c.slice))
  const held = unclaimed.filter(s => !fresh.includes(s) && !adoptedSlices.has(s.n))
  const removed = claims.filter(c => !inPlan.has(c.slice as string))
  const dropped = removed.filter(isWaiting)
  const stuck = removed.filter(c => c.phase !== 'done' && !isWaiting(c))
  const kept = claims.filter(c => isWaiting(c) && inPlan.has(c.slice as string))
  const each = kept.map(c =>
    resyncClaim(c, read.slices.find(s => s.n === c.slice) as PlannedSlice, plan.path),
  )
  const added = [...sliceClaims(claims[0] as Claim, fresh, now), ...adopting.claims]
  const adds: Action[] = added.length === 0 ? [] : [{ kind: 'add', claims: added }]
  const drops = dropped.map((c): Action => ({
    kind: 'update',
    key: { taskId, slice: c.slice },
    patch: { phase: 'done' },
  }))
  return {
    actions: [...adds, ...drops, ...each.flatMap(r => r.actions)],
    notes: [
      ...fresh.map(s => `plan drift ${initiative} ${taskId}: queued new slice ${s.n} from ${plan.path}`),
      ...adopting.notes,
      ...held.map(
        s =>
          `plan drift ${initiative} ${taskId}: did not queue new slice ${s.n} from ${plan.path}: ${why(s.n) as string}`,
      ),
      ...dropped.map(
        c =>
          `plan drift ${initiative} ${taskId}: dropped queued slice ${c.slice} that ${plan.path} no longer lists`,
      ),
      ...stuck.map(
        c =>
          `plan drift ${initiative} ${taskId}: slice ${c.slice} is ${c.phase} with ${c.pr === undefined ? 'an agent' : 'a PR'} but ${plan.path} no longer lists it; run agent-chat burndown release ${taskId} to reseed`,
      ),
      ...each.flatMap(r => r.notes),
    ],
  }
}

/**
 * CC-977: re-reads the plan of every task holding slice claims. A queued slice with no agent or PR takes the plan's
 * `owns`, `dependsOn`, `repo` and `contracts`. CC-1231: a plan slice with no claim is queued, and a waiting claim
 * for a slice the plan removed is marked done; a claim with an agent, a PR or a done phase is never touched, and a
 * removed slice that is live keeps its note. CC-1240: a new slice held for an off-ledger run is adopted once that
 * run's branch PR is open or merged, also on a seated task whose claims are all done until a seat is told it merged. A
 * failing plan only earns a note, and a missing plan changes nothing.
 */
export function resyncQueuedSlices(
  ledger: Ledger,
  readPlan: PlanReader,
  now: Date = new Date(),
  prOf?: SeatPrReader,
): Resync {
  const tasks = new Map<string, Claim[]>()
  for (const c of ledger.claims.filter(c => c.slice !== undefined)) {
    const key = `${c.initiative}/${c.taskId}`
    tasks.set(key, [...(tasks.get(key) ?? []), c])
  }
  const flagged = new Set(ledger.slicesFlagged ?? [])
  const each = [...tasks.values()].map(claims => {
    const first = claims[0] as Claim
    if (claims.some(c => c.phase !== 'done'))
      return resyncTask(ledger, claims, readPlan(...planOf(first)), now, prOf)
    const key = mergedFlagKey(first.initiative, first.taskId)
    const told = flagged.has(key) || flagged.has(`${key}:released`)
    if (told || first.seat === undefined || first.namePrefix === undefined) return { actions: [], notes: [] }
    return adoptSettled(ledger, first, readPlan(...planOf(first)), now, prOf)
  })
  return { actions: each.flatMap(r => r.actions), notes: each.flatMap(r => r.notes) }
}

/**
 * CC-1240: a task whose claims are all done, and that no seat was told merged, adopts each plan slice its seat's
 * off-ledger run holds with no claim once that run's branch PR is open or merged. Nothing else of the plan is read.
 */
function adoptSettled(ledger: Ledger, parent: Claim, plan: PlanFile, now: Date, prOf?: SeatPrReader): Resync {
  if (plan.text === undefined || (plan.ranOffLedger ?? []).length === 0) return { actions: [], notes: [] }
  const runs = (plan.ranOffLedger ?? []).map(agent => ({ agent, slice: agent.slice(-1) }))
  const waiting = new Set(unclaimedRuns(ledger, parent.taskId, runs).map(r => r.slice))
  const held = (readSlices(plan.text).slices ?? []).filter(s => waiting.has(s.n))
  const adopting = adoptedRuns(parent, held, plan, prOf, now)
  return {
    actions: adopting.claims.length === 0 ? [] : [{ kind: 'add', claims: adopting.claims }],
    notes: adopting.notes,
  }
}

/** The claim's plan, read with its seat's dispatch log when it has a seat (CC-1233). */
function planOf({ initiative, taskId, seat, namePrefix }: Claim): Parameters<PlanReader> {
  return seat === undefined || namePrefix === undefined
    ? [initiative, taskId]
    : [initiative, taskId, { seat, prefix: namePrefix }]
}

/** The resync's ledger step, written before any seeding or dispatch in the same tick. */
export const resyncSteps = (resync: Resync): Step[] =>
  resync.actions.length === 0 ? [] : [{ kind: 'ledger', actions: [...resync.actions] }]
