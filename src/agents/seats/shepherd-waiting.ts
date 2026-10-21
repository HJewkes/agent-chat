import { z } from 'zod'
import type { RunResult } from '../../exec.js'

/**
 * CC-1551: the gates `titan-factory shepherd waiting --json` lists. The shape is Shepherd's contract, read
 * leniently at the process boundary: unknown keys pass and a missing optional field reads as null. Which
 * step is the owner's and which the seat's stays Shepherd's split. TP-3653 may add the registering seat to
 * a gate; attribution should read it then instead of joining on the PR.
 */

export interface WaitingGate {
  gateId: string
  stepId: string
  repo: string
  pr: number
  head: string | null
  task: string | null
  since: string
  ageHours: number
  headIsCurrent: boolean | null
  held: boolean
}

export interface ShepherdWaiting {
  owner: WaitingGate[]
  seat: WaitingGate[]
}

const Gate = z.object({
  gateId: z.string(),
  stepId: z.string(),
  repo: z.string(),
  pr: z.number().int(),
  head: z.string().nullable().optional(),
  task: z.string().nullable().optional(),
  since: z.string(),
  ageHours: z.number(),
  headIsCurrent: z.boolean().nullable().optional(),
  held: z.unknown().optional(),
})

const Waiting = z.object({ owner: z.array(Gate), seat: z.array(Gate) })

const gateOf = (g: z.infer<typeof Gate>): WaitingGate => ({
  gateId: g.gateId,
  stepId: g.stepId,
  repo: g.repo,
  pr: g.pr,
  head: g.head ?? null,
  task: g.task ?? null,
  since: g.since,
  ageHours: g.ageHours,
  headIsCurrent: g.headIsCurrent ?? null,
  held: g.held !== null && g.held !== undefined && g.held !== false,
})

/** Throws when stdout is not the waiting shape. */
export function parseWaiting(stdout: string): ShepherdWaiting {
  const parsed = Waiting.parse(JSON.parse(stdout))
  return { owner: parsed.owner.map(gateOf), seat: parsed.seat.map(gateOf) }
}

/** Shepherd exits 1 while an owner gate is over a day old and still prints the list, so 1 is an answer. */
const ANSWERED = new Set([0, 1])

export function readWaiting(result: Pick<RunResult, 'status' | 'stdout'>): ShepherdWaiting {
  if (result.status === null || !ANSWERED.has(result.status))
    throw new Error(`shepherd waiting exited ${result.status ?? 'on a signal'}`)
  return parseWaiting(result.stdout)
}
