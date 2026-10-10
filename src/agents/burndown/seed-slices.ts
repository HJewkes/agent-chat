import fs from 'node:fs'
import path from 'node:path'
import { planPathFor } from './brief.js'
import type { Step } from './execute.js'
import type { Claim, Ledger } from './ledger.js'
import { readSlices, type PlannedSlice } from './report.js'

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
    ...((s.contracts ?? []).length === 0 ? {} : { contracts: s.contracts }),
    ...(parent.seat === undefined ? {} : { seat: parent.seat }),
    ...(parent.namePrefix === undefined ? {} : { namePrefix: parent.namePrefix }),
  }))
}

/** The tick adds the seeded claims before its dispatches; a tick that seeded nothing writes nothing. */
export const seedSteps = (seeds: readonly Claim[] = []): Step[] =>
  seeds.length === 0 ? [] : [{ kind: 'ledger', actions: [{ kind: 'add', claims: [...seeds] }] }]

export type Seeding = { claims: Claim[]; plan: string } | { blocked: string }

/**
 * The task's slices from its plan file, why the plan blocks it, or undefined when there is no
 * plan file and the planner runs as before. A task whose slices already ran is not seeded twice.
 */
export function seedSlices(parent: Parent, plan: PlanFile, ledger: Ledger, now: Date): Seeding | undefined {
  if (plan.text === undefined) return undefined
  if (ledger.claims.some(c => c.taskId === parent.taskId && c.slice !== undefined))
    return {
      blocked: `${plan.path}: slices of ${parent.taskId} were already queued; close the task or replan it`,
    }
  const read = readSlices(plan.text)
  return read.slices === undefined
    ? { blocked: `${plan.path}: ${read.problems.join('; ')}` }
    : { claims: sliceClaims(parent, read.slices, now), plan: plan.path }
}
