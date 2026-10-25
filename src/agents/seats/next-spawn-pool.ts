import type { PoolPickMode } from './pool-pick.js'
import { routePool, type PoolPickRead, type PoolPickRequest } from './pool-route.js'
import type { SeatSpawnRead, SeatSpawnRequest } from './spawn-gate-read.js'
import { seatSpawnGate } from './spawn-gate.js'

/**
 * CC-905: the pool a seat's next unpinned spawn bills, by the broker's own steps (`billedAccount`): the pool pick
 * walked past the seat budget gate, then the billed account's gate. `seats status` reads its stop from this, so it
 * shows BUDGET-PAUSE only when the broker would refuse the spawn.
 */

export interface SpawnProbe {
  /** A name carrying the seat's prefix, so the seat lookup owns it. */
  name: string
  spawner: string
  /** The home pool's config_dir, which an unrouted spawn bills. */
  homeDir: string
  cwd: string
  model: string
  now: Date
}

export interface NextSpawnDeps {
  mode: PoolPickMode
  pick: (spawn: PoolPickRequest) => PoolPickRead
  gate: (spawn: SeatSpawnRequest) => SeatSpawnRead
}

/** `redirect` names the pool the pick moved the spawn to; absent, it bills the home pool. */
export type NextSpawnPool =
  { open: true; redirect?: string; reason: string } | { open: false; reason: string }

type Verdict = { allow: boolean; reason: string }

/** Undefined when no seat owns the probe. Throws when the seats directory cannot be read. */
export function nextSpawnPool(probe: SpawnProbe, deps: NextSpawnDeps): NextSpawnPool | undefined {
  const verdicts = new Map<string, Verdict>()
  const verdict = (configDir: string): Verdict => {
    const known = verdicts.get(configDir)
    if (known !== undefined) return known
    const read = deps.gate({ name: probe.name, spawner: probe.spawner, configDir, now: probe.now })
    const found =
      read.kind === 'gate'
        ? seatSpawnGate({ ...read.input, model: probe.model })
        : { allow: true, reason: read.kind === 'skip' ? read.reason : 'no seat owns the spawn' }
    verdicts.set(configDir, found)
    return found
  }
  const gate = (configDir: string): string | undefined => {
    const { allow, reason } = verdict(configDir)
    return allow ? undefined : reason
  }
  const read = deps.mode === 'off' ? undefined : deps.pick({ ...probe, pinned: false })
  if (read?.kind === 'none') return undefined
  const route = read === undefined ? undefined : routePool(read, deps.mode, gate)
  const redirect = route?.redirect
  const billed = verdict(redirect?.configDir ?? probe.homeDir)
  if (billed.allow)
    return {
      open: true,
      reason: billed.reason,
      ...(redirect === undefined ? {} : { redirect: redirect.name }),
    }
  const reason =
    route?.refusal === undefined ? billed.reason : `${route.refusal}; home is closed: ${billed.reason}`
  return { open: false, reason }
}
