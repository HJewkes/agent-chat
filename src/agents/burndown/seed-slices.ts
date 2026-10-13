import fs from 'node:fs'
import path from 'node:path'
import type { Action } from './advance.js'
import { planPathFor } from './brief.js'
import type { Step } from './execute.js'
import type { Claim, Ledger } from './ledger.js'
import type { DispatchRecord } from '../seats/dispatch-record.js'
import { readSlices, type PlannedSlice } from './report.js'
import { slicesSettled } from './slices-complete.js'

/**
 * CC-927 (item 179 S3): a seat-written `sources/<ID>-plan.md` is the brief. A brief-ready task
 * whose plan holds a `burndown-slices` block that passes the planner's lint is queued as slice
 * claims of the shape a planner's report leaves, and no planner is spawned. A plan that fails
 * the lint blocks the task rather than being planned over. Pure but for `diskPlanReader`.
 */

/** A task's plan file: its path, and its text when the file exists. */
export interface PlanFile {
  path: string
  text: string | undefined
}

export type PlanReader = (initiative: string, taskId: string) => PlanFile

export const diskPlanReader =
  (root: string): PlanReader =>
  (initiative, taskId) => {
    const file = planPathFor(path.join(root, initiative), taskId)
    try {
      return { path: file, text: fs.readFileSync(file, 'utf8') }
    } catch {
      return { path: file, text: undefined }
    }
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
/** `merged`: every slice of the task is done, so there is nothing to seed and nothing to refuse (CC-1049). */
export type Seeding =
  { claims: Claim[]; plan: string; warnings: string[] } | { blocked: string } | { merged: true }

/** The slice agents already run for a task, by name (CC-1121 b). */
export type SliceRuns = (taskId: string) => string[]

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
 * plan file and the planner runs as before. A task whose slices already ran, or had one released, is not seeded twice.
 */
export function seedSlices(
  parent: Parent,
  plan: PlanFile,
  ledger: Ledger,
  now: Date,
  ranOffLedger?: SliceRuns,
): Seeding | undefined {
  if (plan.text === undefined) return undefined
  if (slicesSettled(ledger, parent.taskId)) return { merged: true }
  const seeded =
    ledger.claims.some(c => c.taskId === parent.taskId && c.slice !== undefined && c.phase !== 'done') ||
    ledger.slicesReleased?.[parent.taskId] !== undefined
  if (seeded)
    return {
      blocked: `${plan.path}: slices of ${parent.taskId} were already queued; close the task or replan it`,
    }
  const ran = ranOffLedger?.(parent.taskId) ?? []
  if (ran.length > 0)
    return {
      blocked: `${plan.path}: slice agents of ${parent.taskId} already ran outside the ledger (${ran.join(', ')}); seed by hand or close the task`,
    }
  const read = readSlices(plan.text)
  return read.slices === undefined
    ? { blocked: `${plan.path}: ${read.problems.join('; ')}` }
    : { claims: sliceClaims(parent, read.slices, now), plan: plan.path, warnings: read.warnings }
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

function resyncTask(ledger: Ledger, claims: readonly Claim[], plan: PlanFile): Resync {
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
  const planned = [...new Set(read.slices.map(s => s.n))].sort()
  const held = [
    ...new Set([...claims.map(c => c.slice as string), ...(ledger.slicesReleased?.[taskId] ?? [])]),
  ].sort()
  if (planned.join(',') !== held.join(','))
    return {
      actions: [],
      notes: [
        `plan drift ${initiative} ${taskId}: plan slices {${planned.join(',')}} vs ledger {${held.join(',')}}; run agent-chat burndown release ${taskId} to reseed`,
      ],
    }
  const each = claims
    .filter(isWaiting)
    .map(c => resyncClaim(c, read.slices.find(s => s.n === c.slice) as PlannedSlice, plan.path))
  return { actions: each.flatMap(r => r.actions), notes: each.flatMap(r => r.notes) }
}

/**
 * CC-977: re-reads the plan of every task holding slice claims. A queued slice with no agent or PR takes the plan's
 * `owns`, `dependsOn`, `repo` and `contracts`; a changed slice set or a failing plan only earns a note, since adding
 * or dropping claims could re-dispatch work already running or merged. A missing plan changes nothing, and a task
 * with no waiting slice is not read.
 */
export function resyncQueuedSlices(ledger: Ledger, readPlan: PlanReader): Resync {
  const tasks = new Map<string, Claim[]>()
  for (const c of ledger.claims.filter(c => c.slice !== undefined)) {
    const key = `${c.initiative}/${c.taskId}`
    tasks.set(key, [...(tasks.get(key) ?? []), c])
  }
  const each = [...tasks.values()]
    .filter(claims => claims.some(isWaiting))
    .map(claims =>
      resyncTask(ledger, claims, readPlan((claims[0] as Claim).initiative, (claims[0] as Claim).taskId)),
    )
  return { actions: each.flatMap(r => r.actions), notes: each.flatMap(r => r.notes) }
}

/** The resync's ledger step, written before any seeding or dispatch in the same tick. */
export const resyncSteps = (resync: Resync): Step[] =>
  resync.actions.length === 0 ? [] : [{ kind: 'ledger', actions: [...resync.actions] }]
