import type { Autonomy } from '../active-work.js'
import { pickAccount, type AccountReading, type AccountRule, type GateContext } from './budget-gate.js'
import {
  byRank,
  pickTask,
  profileFor,
  SONNET_PROFILES,
  type Initiative,
  type Refusal,
  type Task,
} from './eligibility.js'
import { heldClaims, type Ledger } from './ledger.js'
import { worktreePathFor } from './trust-gate.js'

/**
 * One dry-run tick: at most one dispatch per opted-in initiative, and a
 * reason for everything it did not dispatch. Nothing here spawns or writes.
 */

export interface Dispatch {
  initiative: string
  task: string
  profile: string
  account: string
  cwd: string
  reason: string
}

export interface PlanInputs {
  initiatives: Initiative[]
  tasks: ReadonlyMap<string, Task[]>
  ledger: Ledger
  rules: Record<string, AccountRule>
  readings: ReadonlyMap<string, AccountReading>
  gate: GateContext
  /** Why `cwd` cannot be spawned into on `account`, or undefined when it can. */
  trust: (cwd: string, account: string) => string | undefined
}

export interface Plan {
  dispatch: Dispatch[]
  refusals: Refusal[]
  /** Focused initiatives with no `autonomy: mode: burndown`, which the tick never reads further. */
  notOptedIn: string[]
}

/** The agent name, and so the worktree directory, a tick spawn for `taskId` would use. */
export const agentNameFor = (taskId: string): string => `bd-${taskId.toLowerCase()}`

type OptedIn = Initiative & { autonomy: Autonomy }

export function plan(inputs: PlanInputs): Plan {
  const focused = inputs.initiatives.filter(i => i.state === 'focused').sort(byRank)
  const optedIn = focused.filter((i): i is OptedIn => i.autonomy !== undefined)
  const result: Plan = {
    dispatch: [],
    refusals: [],
    notOptedIn: focused.filter(i => i.autonomy === undefined).map(i => i.slug),
  }
  for (const initiative of optedIn) {
    const outcome = planInitiative(initiative, inputs)
    result.refusals.push(...outcome.refusals)
    if (outcome.dispatch !== undefined) result.dispatch.push(outcome.dispatch)
  }
  return result
}

function planInitiative(
  initiative: OptedIn,
  inputs: PlanInputs,
): { dispatch?: Dispatch; refusals: Refusal[] } {
  const held = heldClaims(inputs.ledger)
  const lanesHeld = held.filter(c => c.initiative === initiative.slug).length
  if (lanesHeld >= initiative.autonomy.lanes) {
    const reason = `${lanesHeld} of ${initiative.autonomy.lanes} lanes held`
    return { refusals: [{ initiative: initiative.slug, kind: 'lanes-full', reason }] }
  }
  const claimed = new Set(held.map(c => c.taskId))
  const { task, refusals } = pickTask(initiative, inputs.tasks.get(initiative.slug) ?? [], claimed)
  if (task === undefined) return { refusals }
  const placed = placeTask(initiative, task, inputs)
  if ('kind' in placed)
    return { refusals: [...refusals, { initiative: initiative.slug, task: task.id, ...placed }] }
  return { dispatch: placed, refusals }
}

/** The account, profile and worktree for an eligible task, or why there is none. */
function placeTask(
  initiative: OptedIn,
  task: Task,
  inputs: PlanInputs,
): Dispatch | Pick<Refusal, 'kind' | 'reason'> {
  const named = initiative.autonomy.accounts.length > 0 ? initiative.autonomy.accounts : [initiative.profile]
  const allowed = named.filter((a): a is string => a !== undefined)
  if (allowed.length === 0) return { kind: 'no-account', reason: 'no autonomy.accounts and no profile' }

  const { chosen, closed } = pickAccount(allowed, inputs.rules, inputs.readings, inputs.gate)
  if (chosen === undefined)
    return { kind: 'budget', reason: closed.map(c => `${c.account}: ${c.reason}`).join('; ') }
  const profile = profileFor(task)
  if (chosen.sonnetOnly && !SONNET_PROFILES.has(profile))
    return {
      kind: 'budget',
      reason: `${chosen.account} is above 85% seven_day, sonnet only; task needs ${profile}`,
    }

  const repo = initiative.autonomy.repo
  if (repo === undefined) return { kind: 'trust', reason: 'no autonomy.repo, so no worktree path to check' }
  const cwd = worktreePathFor(repo, agentNameFor(task.id))
  const untrusted = inputs.trust(cwd, chosen.account)
  if (untrusted !== undefined) return { kind: 'trust', reason: untrusted }

  const reason = `priority ${task.priority ?? '-'}, estimate ${task.estimate}; ${chosen.account} ${chosen.reason}`
  return { initiative: initiative.slug, task: task.id, profile, account: chosen.account, cwd, reason }
}
