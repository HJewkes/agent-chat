import type { AgentEventRow } from '../broker/event-store.js'
import { HUMAN_ROOT, type Parent } from '../broker/integrity-ledger.js'
import type { Mismatch } from '../leak-guard/integrity/record.js'

/**
 * TP-4345 S3: the ledger parent of an agent whose recorded ancestors may have ended before this
 * broker started. A parent edge matters to the ledger only because a quarantine spreads down it,
 * and an ancestor that is not running can never be latched in this broker, so the walk roots past
 * it at the nearest running ancestor, otherwise at the human. The one thing a skipped ancestor can
 * still carry is a quarantine an earlier broker recorded, which the agent inherits.
 */

type SpawnMeta = Readonly<Record<string, string>>

/** Hard bound on the walk; the visited set ends a loop long before it. */
export const LINEAGE_BOUND = 512

/** A successor's parent is its predecessor, so it never steps outside that agent's quarantine; '' is a human's spawn. */
export const ledgerParentOf = (meta: SpawnMeta | undefined): Parent =>
  meta?.teleport_from || meta?.parent || HUMAN_ROOT

export interface LineageReads {
  /** The `agent_spawned` meta of `agentId`, if the log has one. */
  spawnMeta(agentId: string): SpawnMeta | undefined
  /** The ledger enrolled it in this broker, so its own verdict, latches included, speaks for it. */
  knows(agentId: string): boolean
  running(agentId: string): boolean
  /** A quarantine an earlier broker recorded that no human resume has cleared. */
  onRecord(agentId: string): Mismatch | undefined
}

export interface SurvivorRoot {
  readonly parent: Parent
  /** The nearest skipped ancestor's recorded quarantine, which the agent latches on. */
  readonly inherited?: { readonly via: string; readonly mismatch: Mismatch }
  /** Set when the walk could not resolve, so `parent` is the recorded one and stays unknown. */
  readonly unresolved?: string
}

/** Walks `teleport_from`, then `parent`, from `meta` (the spawn row of `agentId`) to its root. */
export function survivorRoot(agentId: string, meta: SpawnMeta | undefined, reads: LineageReads): SurvivorRoot {
  const recorded = ledgerParentOf(meta)
  const visited = new Set([agentId])
  let inherited: SurvivorRoot['inherited']
  const root = (parent: Parent, unresolved?: string): SurvivorRoot => ({
    parent,
    ...(inherited === undefined ? {} : { inherited }),
    ...(unresolved === undefined ? {} : { unresolved }),
  })
  for (let next = recorded; next !== HUMAN_ROOT; ) {
    if (visited.has(next)) return root(recorded, `lineage unresolved: loops at ${next}`)
    if (visited.size > LINEAGE_BOUND) return root(recorded, `lineage unresolved: over ${LINEAGE_BOUND} ancestors`)
    if (reads.knows(next) || reads.running(next)) return root(next)
    visited.add(next)
    const mismatch = inherited === undefined ? reads.onRecord(next) : undefined
    if (mismatch !== undefined) inherited = { via: next, mismatch }
    const row = reads.spawnMeta(next)
    if (row === undefined) return root(next)
    next = ledgerParentOf(row)
  }
  return root(HUMAN_ROOT)
}

/**
 * Spawn rows by agent id. A spawn row never changes and the first one wins, so a hit is kept; a
 * miss re-reads the log once, which costs one copy of it per walk rather than one per step.
 */
export function spawnRowIndex(rows: () => readonly AgentEventRow[]): (agentId: string) => AgentEventRow | undefined {
  const index = new Map<string, AgentEventRow>()
  const refresh = () => {
    for (const row of rows())
      if (row.kind === 'agent_spawned' && row.msgId !== null && !index.has(row.msgId)) index.set(row.msgId, row)
  }
  return agentId => {
    if (!index.has(agentId)) refresh()
    return index.get(agentId)
  }
}
