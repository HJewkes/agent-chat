import type { LifecycleDivergence } from '../../api-contract.js'
import type { AgentLifecycle } from '../../protocol.js'
import { BRANCH_PREFIX } from '../isolation/worktree.js'
import { backfillRequestKey } from './backfill.js'

/**
 * CC-118's divergence classifier: the in-memory supervisor, the event log's
 * fold, `runtime.json` and git on one side, the shadow ledger on the other.
 * Pure: the caller gathers the input, so every class is testable without a
 * broker, a database or a repository.
 *
 * Divergences are classified, not counted. A class names a known cause; drift
 * no cause explains is unclassified, and one unclassified divergence fails the
 * check. The classes must stay narrow, because a class wide enough to swallow
 * real drift turns the verifier into a counter.
 */

export const DIVERGENCE_CLASSES = [
  'live_only_pre_shadow',
  'live_only',
  'ledger_only_since_restart',
  'ledger_only_detached',
  'ledger_only_backfilled',
  'teleport_half_written',
  'slot_reattached_no_row',
  'slot_pre_shadow',
  'slot_without_row',
  'row_without_slot',
  'allocation_absent_from_git',
  'git_branch_unowned',
  'retired_row_active',
  'exited_row_active',
  'terminal_disagreement',
  'unclassified',
] as const

export type DivergenceClass = (typeof DIVERGENCE_CLASSES)[number]

const UNCLASSIFIED: ReadonlySet<DivergenceClass> = new Set([
  'live_only',
  'slot_without_row',
  'terminal_disagreement',
  'unclassified',
])

/** Derived from the backfill's own key, so the two cannot drift apart. */
export const BACKFILL_KEY_PREFIX = backfillRequestKey('')

/** One non-terminal execution row, reduced to what the checks compare. */
export interface LedgerRow {
  executionId: string
  agentId?: string
  requestKey: string
  preparedAt: number
}

/** One identity from the event log's fold, plus the two row facts the fold does not keep. */
export interface FoldEntry {
  agentId: string
  name: string
  state: AgentLifecycle
  spawnedAt: number
  teleportFrom?: string
  lastAttachedAt?: number
  /** An `agent_handoff` row names this identity as the predecessor. */
  handedOff: boolean
}

export interface RuntimeRef {
  agentId: string
  branch: string
  gitRoot: string
}

/** Every branch checked out in `gitRoot`; null when git could not list it, which leaves its allocations unchecked. */
export interface GitListing {
  gitRoot: string
  branches: string[] | null
}

/** The broker's memory. Absent offline, which skips the held and slot checks. */
export interface BrokerSide {
  liveIds: string[]
  slotIds: string[]
  bootAt: number
  /** When the ledger began seeing spawns; an agent spawned earlier cannot have a row. */
  shadowSince: number
}

export interface VerifyInput {
  broker?: BrokerSide
  fold: FoldEntry[]
  ledgerActive: LedgerRow[]
  /** The newest terminal phase per agent id. */
  ledgerTerminalByAgent: Map<string, string>
  runtimeRefs: RuntimeRef[]
  gitListings: GitListing[]
}

interface Index {
  input: VerifyInput
  fold: Map<string, FoldEntry>
  active: Map<string, LedgerRow>
}

export function classify(input: VerifyInput): LifecycleDivergence[] {
  const index: Index = {
    input,
    fold: new Map(input.fold.map(agent => [agent.agentId, agent])),
    active: new Map(input.ledgerActive.flatMap(row => (row.agentId ? [[row.agentId, row] as const] : []))),
  }
  return [...checkHeld(index), ...checkSlots(index), ...checkAllocations(input), ...checkTerminal(index)]
}

function divergence(
  check: LifecycleDivergence['check'],
  cls: DivergenceClass,
  id: string,
  name: string | undefined,
  detail: string,
): LifecycleDivergence {
  return { check, class: cls, unclassified: UNCLASSIFIED.has(cls), id, ...(name ? { name } : {}), detail }
}

const isTerminalState = (state: AgentLifecycle | undefined): boolean =>
  state === 'exited' || state === 'retired'

/** A row the ledger never knew: spawned before the shadow began, and no terminal row either. */
function preShadow(index: Index, agentId: string, broker: BrokerSide): boolean {
  const agent = index.fold.get(agentId)
  return (
    agent !== undefined &&
    agent.spawnedAt < broker.shadowSince &&
    !index.input.ledgerTerminalByAgent.has(agentId)
  )
}

function checkHeld(index: Index): LifecycleDivergence[] {
  const broker = index.input.broker
  if (broker === undefined) return []
  const live = new Set(broker.liveIds)
  const liveSide = broker.liveIds
    // A live id with a terminal row is the terminal check's to report, never a held class.
    .filter(id => !index.active.has(id) && !index.input.ledgerTerminalByAgent.has(id))
    .map(id => liveWithoutRow(index, id, broker))
  const ledgerSide = index.input.ledgerActive
    .filter(row => row.agentId === undefined || !live.has(row.agentId))
    .filter(row => !isTerminalState(index.fold.get(row.agentId ?? '')?.state))
    .map(row => ledgerWithoutLive(index, row, broker))
  return [...liveSide, ...ledgerSide]
}

function liveWithoutRow(index: Index, agentId: string, broker: BrokerSide): LifecycleDivergence {
  const agent = index.fold.get(agentId)
  const predecessor = agent?.teleportFrom === undefined ? undefined : index.fold.get(agent.teleportFrom)
  if (predecessor?.handedOff && index.input.ledgerTerminalByAgent.has(predecessor.agentId))
    return divergence(
      'held',
      'teleport_half_written',
      agentId,
      agent?.name,
      `successor of ${predecessor.name} has no row`,
    )
  if (preShadow(index, agentId, broker))
    return divergence(
      'held',
      'live_only_pre_shadow',
      agentId,
      agent?.name,
      'spawned before the shadow ledger began',
    )
  return divergence(
    'held',
    'live_only',
    agentId,
    agent?.name,
    'held by the supervisor with no active ledger row',
  )
}

function ledgerWithoutLive(index: Index, row: LedgerRow, broker: BrokerSide): LifecycleDivergence {
  const agent = index.fold.get(row.agentId ?? '')
  const say = (cls: DivergenceClass, detail: string) =>
    divergence('held', cls, row.executionId, agent?.name, `${detail} (${row.requestKey})`)
  if (row.requestKey.startsWith(BACKFILL_KEY_PREFIX)) return say('ledger_only_backfilled', 'backfilled row')
  if (agent === undefined) return say('unclassified', 'active row for an agent the event log does not know')
  if (row.preparedAt >= broker.bootAt)
    return say('unclassified', 'row opened since boot for an agent the supervisor does not hold')
  if ((agent.lastAttachedAt ?? 0) >= broker.bootAt)
    return say('ledger_only_since_restart', 'row from before the restart; the agent reattached since')
  return say('ledger_only_detached', 'row from before the restart; no presence since')
}

function checkSlots(index: Index): LifecycleDivergence[] {
  const broker = index.input.broker
  if (broker === undefined) return []
  const live = new Set(broker.liveIds)
  const slots = new Set(broker.slotIds)
  const name = (id: string) => index.fold.get(id)?.name
  const slotSide = broker.slotIds
    .filter(id => !index.active.has(id))
    .map(id => {
      if (!live.has(id))
        return divergence('slots', 'slot_reattached_no_row', id, name(id), 'slot adopted on reattach')
      if (preShadow(index, id, broker))
        return divergence(
          'slots',
          'slot_pre_shadow',
          id,
          name(id),
          'slot held since before the shadow ledger',
        )
      return divergence('slots', 'slot_without_row', id, name(id), 'slot held with no active ledger row')
    })
  // Rows for agents the supervisor does not hold are described by the held check.
  const rowSide = broker.liveIds
    .filter(id => index.active.has(id) && !slots.has(id))
    .map(id => divergence('slots', 'row_without_slot', id, name(id), 'live with an active row but no slot'))
  return [...slotSide, ...rowSide]
}

function checkAllocations(input: VerifyInput): LifecycleDivergence[] {
  const listed = new Map(input.gitListings.map(listing => [listing.gitRoot, listing.branches]))
  const owned = new Set(input.runtimeRefs.map(ref => ref.branch))
  const absent = input.runtimeRefs
    .filter(ref => {
      const branches = listed.get(ref.gitRoot)
      return branches != null && !branches.includes(ref.branch)
    })
    .map(ref =>
      divergence(
        'allocations',
        'allocation_absent_from_git',
        ref.branch,
        undefined,
        `${ref.agentId} in ${ref.gitRoot}`,
      ),
    )
  const unowned = input.gitListings.flatMap(({ gitRoot, branches }) =>
    (branches ?? [])
      .filter(branch => branch.startsWith(BRANCH_PREFIX) && !owned.has(branch))
      .map(branch =>
        divergence('allocations', 'git_branch_unowned', branch, undefined, `no runtime.json in ${gitRoot}`),
      ),
  )
  return [...absent, ...unowned]
}

function checkTerminal(index: Index): LifecycleDivergence[] {
  const live = new Set(index.input.broker?.liveIds ?? [])
  const ids = new Set([...index.fold.keys(), ...live])
  const out: LifecycleDivergence[] = []
  for (const id of ids) {
    const state = live.has(id) ? 'live' : index.fold.get(id)?.state
    const name = index.fold.get(id)?.name
    const terminalPhase = index.input.ledgerTerminalByAgent.get(id)
    if (index.active.has(id) && state === 'retired')
      out.push(
        divergence('terminal', 'retired_row_active', id, name, 'retired in the log, active in the ledger'),
      )
    else if (index.active.has(id) && state === 'exited')
      out.push(
        divergence('terminal', 'exited_row_active', id, name, 'exited in the log, active in the ledger'),
      )
    else if (!index.active.has(id) && terminalPhase !== undefined && !isTerminalState(state))
      out.push(
        divergence(
          'terminal',
          'terminal_disagreement',
          id,
          name,
          `${state ?? 'unknown'} but the ledger says ${terminalPhase}`,
        ),
      )
  }
  return out
}

/** Count per class, and how many no known cause explains. */
export function tally(items: readonly LifecycleDivergence[]): {
  divergences: Record<string, number>
  unclassified: number
} {
  const divergences: Record<string, number> = {}
  for (const item of items) divergences[item.class] = (divergences[item.class] ?? 0) + 1
  return { divergences, unclassified: items.filter(item => item.unclassified).length }
}
