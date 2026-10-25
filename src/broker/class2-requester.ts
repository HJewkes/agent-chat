import type { Caller } from './declared-callers.js'
import type { EntryView } from './registry.js'

/** Who a Class 2 frame (spawn, resume, surface, park, retire_finished, retire) asks as. */
export type Class2Requester = Pick<EntryView, 'name' | 'agentId' | 'binding'>

export type Class2Asker = Class2Requester | { refusal: string } | undefined

export const isRefusal = (asker: Class2Asker): asker is { refusal: string } =>
  asker !== undefined && 'refusal' in asker

/**
 * CC-1138 slice E. A registered connection asks as its entry and a known declared agent as
 * itself; undefined is the human. The `launch` binding a seat root needs (CC-1615) goes to a
 * declared id only when it passes the same `claimable` test a launch registration does: the
 * hello carries the broker-minted id that registration would present, so it gains nothing more.
 */
export function class2RequesterOf(
  entry: EntryView | undefined,
  caller: Caller,
  claimable: (agentId: string, name: string) => boolean,
): Class2Asker {
  if (entry !== undefined) return entry
  if (caller.kind !== 'declared') return undefined
  if (!('name' in caller))
    return {
      refusal:
        `this connection declared agent id ${caller.agentId} (AGENT_CHAT_AGENT_ID), which names no live ` +
        'agent, so it is not the human either; run the verb from a plain shell',
    }
  const { agentId, name } = caller
  return { name, agentId, ...(claimable(agentId, name) ? { binding: 'launch' as const } : {}) }
}
