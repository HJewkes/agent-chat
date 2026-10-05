import type { SpawnSyncReturns } from 'node:child_process'

/**
 * Throws when spawnSync's child never ran or was killed (ETXTBSY, ENOENT, ETIMEDOUT, ENOBUFS),
 * naming the cause instead of leaving undefined output to fail a later assertion (CC-462).
 */
export function expectSpawned<T extends SpawnSyncReturns<string>>(result: T, command: string): T {
  if (result.error === undefined) return result
  const stderr = result.stderr ? result.stderr : '<none>'
  throw new Error(
    `${command} did not complete: ${result.error.message} ` +
      `(status ${result.status}, signal ${result.signal})\nstderr: ${stderr}`,
  )
}
