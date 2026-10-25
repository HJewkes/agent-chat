import { brokerKeyFor, readMachineAliases } from '../broker/launcher-key.js'
import { resolveMachines } from '../config.js'

/**
 * CC-1646 B: recorded aliases whose host holds a usable broker key. A key
 * file that is missing, loose or a symlink leaves the alias unlisted, so only
 * what the owner provisioned with `host key-new` counts.
 */
export function keyedMachines(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(readMachineAliases()).filter(([, host]) => brokerKeyFor(host) !== null),
  )
}

/** Teleport destination aliases: key-registered machines under the `machines` config, which wins on a clash. */
export function knownMachineAliases(): Record<string, string> {
  return { ...keyedMachines(), ...resolveMachines() }
}
