import type { AgentEventRow } from '../../broker/event-store.js'
import { REMOTE_UNPROBED } from '../../agents/detached-reap.js'
import { foldAgent } from '../../agents/identity.js'
import type { AgentIdentity } from '../../protocol.js'

/** Roster rows built through the real fold, in the shapes the broker wrote during a Mac-wide drop. */

export const MAC_HOST = 'host-mac.local'
export const SETTLE_MS = 30_000

const row = (kind: AgentEventRow['kind'], ts: number, id: string, extra: Partial<AgentEventRow> = {}) => ({
  kind,
  ts,
  actor: 'agent',
  target: null,
  msgId: kind === 'agent_spawned' ? id : null,
  ref: kind === 'agent_spawned' ? null : id,
  body: null,
  meta: {},
  ...extra,
})

export interface AgentShape {
  name: string
  host?: string
  detachedAt: number
  /** The reaper's exit row, `SETTLE_MS` after the detach. */
  exit?: 'remote-inferred' | 'local-inferred' | 'real'
}

const exitRow = (shape: AgentShape, id: string): AgentEventRow => {
  const ts = shape.detachedAt + SETTLE_MS
  if (shape.exit === 'real') return row('agent_exited', ts, id, { meta: { code: '0' }, body: 'done' })
  const reason =
    shape.exit === 'remote-inferred'
      ? `on host ${shape.host ?? '?'}, ${REMOTE_UNPROBED}`
      : 'no running Claude Code process holds session s-1'
  return row('agent_exited', ts, id, {
    meta: { inferred: 'true' },
    body: `exit inferred while detached: ${reason}`,
  })
}

export function agentRows(shape: AgentShape): AgentIdentity {
  const id = `id-${shape.name}`
  const spawnedAt = shape.detachedAt - 3_600_000
  const rows: AgentEventRow[] = [
    row('agent_spawned', spawnedAt, id, {
      target: shape.name,
      meta: { name: shape.name, session_id: 's-1', ...(shape.host ? { host: shape.host } : {}) },
    }),
    row('agent_attached', spawnedAt + 1000, id),
    row('agent_detached', shape.detachedAt, id, { body: 'connection closed' }),
    ...(shape.exit === undefined ? [] : [exitRow(shape, id)]),
  ]
  const agent = foldAgent(rows)
  if (agent === undefined) throw new Error(`fold gave no identity for ${shape.name}`)
  return agent
}

/** A row live under `name`, as a teleport successor or a resume leaves it. */
export function liveRow(name: string, at: number): AgentIdentity {
  const id = `id-${name}-next`
  const agent = foldAgent([
    row('agent_spawned', at, id, { target: name, meta: { name } }),
    row('agent_attached', at + 1000, id),
  ])
  if (agent === undefined) throw new Error(`fold gave no identity for ${name}`)
  return agent
}

export const at = (hhmmss: string): number => Date.parse(`2026-01-10T${hhmmss}Z`)
