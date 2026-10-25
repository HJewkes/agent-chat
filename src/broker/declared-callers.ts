import type { AgentIdentity } from '../protocol.js'

/** A `hello` id longer than any id the broker mints is not one of its ids. */
export const MAX_DECLARED_ID = 128

/**
 * What a connection's `hello` resolved to (CC-1138). `unknown` is an id with no live
 * identity behind it: missing, or retired, which fails closed once the gate is on.
 */
export type Declared = { agentId: string; name: string } | { agentId: string; unknown: true }

/** Who a frame on this connection comes from, as the caller gate will judge it. */
export type Caller = { kind: 'session' } | { kind: 'human' } | ({ kind: 'declared' } & Declared)

/** The id a `hello` carries, or undefined for one that declares nothing. */
export function declaredIdOf(agentId: unknown): string | undefined {
  if (typeof agentId !== 'string') return undefined
  const id = agentId.trim()
  return id === '' || id.length > MAX_DECLARED_ID ? undefined : id
}

/** Resolved at each read, so an agent retired after its `hello` reads as unknown. */
export function resolveDeclared(
  agentId: string,
  identityOf: (id: string) => AgentIdentity | undefined,
): Declared {
  const identity = identityOf(agentId)
  if (identity === undefined || identity.state === 'retired') return { agentId, unknown: true }
  return { agentId, name: identity.name }
}

/**
 * The agent id each connection declared in its `hello`, dropped with the connection.
 * The first declaration stands: a connection cannot trade its id for another one.
 */
export class DeclaredCallers<C> {
  private readonly ids = new Map<C, string>()

  /** True when `agentId` became this connection's declaration. */
  declare(conn: C, agentId: string): boolean {
    if (this.ids.has(conn)) return false
    this.ids.set(conn, agentId)
    return true
  }

  idOf(conn: C): string | undefined {
    return this.ids.get(conn)
  }

  drop(conn: C): void {
    this.ids.delete(conn)
  }
}
