import fs from 'node:fs'
import path from 'node:path'
import type { Action } from './advance.js'
import { planPathFor } from './brief.js'
import type { Step } from './execute.js'
import type { Claim, Ledger } from './ledger.js'
import type { DispatchRecord } from '../seats/dispatch-record.js'
import { adoptOffLedger, seatDispatchRecords, type SliceRuns } from './off-ledger-adopt.js'
import { defaultAutonomyRoot } from './policy.js'
import { readSlices, type PlannedSlice } from './report.js'
import { slicesMerged } from './slices-complete.js'

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
    return { ranOffLedger: sliceRunsIn(seatDispatchRecords(autonomyRoot, seat) ?? [], taskId, prefix) }
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
export type Seeding =
  | { claims: Claim[]; plan: string; warnings: string[]; notes: string[] }
  | { blocked: string }
  | { merged: true }

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
 * The task's slices from its plan file, why the plan blocks it, or undefined when there is no
 * plan file and the planner runs as before. A task whose slices were queued, or had one released, is not seeded
 * twice; CC-1233: slices whose agents ran outside the ledger are adopted by their branch PRs, and seeding waits a
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
  if (slicesMerged(ledger, parent.taskId)) return { merged: true }
  const seeded =
    ledger.claims.some(c => c.taskId === parent.taskId && c.slice !== undefined && c.phase !== 'done') ||
    ledger.slicesReleased?.[parent.taskId] !== undefined
  if (seeded)
    return {
      blocked: `${plan.path}: slices of ${parent.taskId} were already queued; close the task or replan it`,
    }
  const read = readSlices(plan.text)
  if (read.slices === undefined) return { blocked: `${plan.path}: ${read.problems.join('; ')}` }
  const runs = ranOffLedger?.(parent.taskId) ?? []
  const unread = runs.filter(r => r.pr === undefined).map(r => r.agent)
  if (unread.length > 0)
    return {
      blocked: `${plan.path}: could not read the branch PRs of ${unread.join(', ')}, slice agents of ${parent.taskId} that ran outside the ledger; seeding waits a tick`,
    }
  const { claims, notes } = adoptOffLedger(sliceClaims(parent, read.slices, now), runs)
  return { claims, plan: plan.path, warnings: read.warnings, notes }
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

const isWaiting = (c: Claim): boolean =>
  c.phase === 'queued' && c.agentName === undefined && c.pr === undefined

/**
 * CC-1233: the slices whose `<prefix>-<id>-<slice>` agent the seat's dispatch log shows, which the resync never
 * queues. A log that could not be read holds every new slice. A claim with no seat names no log, so none ran.
 */
function ranSlices(plan: PlanFile): { slices: Set<string> | undefined; why: string } {
  if (plan.runsUnread !== undefined) return { slices: undefined, why: plan.runsUnread }
  const agents = plan.ranOffLedger ?? []
  return {
    slices: new Set(agents.map(a => a.slice(-1))),
    why: `its agent ${agents.join(', ')} ran outside the ledger`,
  }
}

function resyncTask(ledger: Ledger, claims: readonly Claim[], plan: PlanFile, now: Date): Resync {
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
  const ran = ranSlices(plan)
  const fresh = unclaimed.filter(s => ran.slices !== undefined && !ran.slices.has(s.n))
  const held = unclaimed.filter(s => !fresh.includes(s))
  const removed = claims.filter(c => !inPlan.has(c.slice as string))
  const dropped = removed.filter(isWaiting)
  const stuck = removed.filter(c => c.phase !== 'done' && !isWaiting(c))
  const kept = claims.filter(c => isWaiting(c) && inPlan.has(c.slice as string))
  const each = kept.map(c =>
    resyncClaim(c, read.slices.find(s => s.n === c.slice) as PlannedSlice, plan.path),
  )
  const adds: Action[] =
    fresh.length === 0 ? [] : [{ kind: 'add', claims: sliceClaims(claims[0] as Claim, fresh, now) }]
  const drops = dropped.map((c): Action => ({
    kind: 'update',
    key: { taskId, slice: c.slice },
    patch: { phase: 'done' },
  }))
  return {
    actions: [...adds, ...drops, ...each.flatMap(r => r.actions)],
    notes: [
      ...fresh.map(s => `plan drift ${initiative} ${taskId}: queued new slice ${s.n} from ${plan.path}`),
      ...held.map(
        s =>
          `plan drift ${initiative} ${taskId}: did not queue new slice ${s.n} from ${plan.path}: ${ran.why}`,
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
 * removed slice that is live keeps its note. A failing plan only earns a note. A missing plan changes nothing, and
 * a task whose claims are all done is not read.
 */
export function resyncQueuedSlices(ledger: Ledger, readPlan: PlanReader, now: Date = new Date()): Resync {
  const tasks = new Map<string, Claim[]>()
  for (const c of ledger.claims.filter(c => c.slice !== undefined)) {
    const key = `${c.initiative}/${c.taskId}`
    tasks.set(key, [...(tasks.get(key) ?? []), c])
  }
  const each = [...tasks.values()]
    .filter(claims => claims.some(c => c.phase !== 'done'))
    .map(claims => resyncTask(ledger, claims, readPlan(...planOf(claims[0] as Claim)), now))
  return { actions: each.flatMap(r => r.actions), notes: each.flatMap(r => r.notes) }
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
