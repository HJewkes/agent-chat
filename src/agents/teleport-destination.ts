/**
 * CC-951: which machine a teleport's successor lands on, and who launches it there.
 *
 * `broker`: this broker's own host launches it. `caller`: the predecessor's own host, reached
 * through its MCP process (CC-881). `launcher`: a host launcher connected for another machine.
 * Pure: the caller supplies the hosts, the connected launchers and the configured aliases.
 */

import path from 'node:path'
import { SENSITIVE_DIRS } from './spawn-cwd.js'

export type DestinationSite = 'broker' | 'caller' | 'launcher'

/** A host launcher connected to the broker, presence-only. */
export interface ConnectedLauncher {
  host: string
  platform: NodeJS.Platform
}

export interface DestinationInput {
  /** An alias from config `machines` or a hostname; absent means the predecessor's own host. */
  to?: string | undefined
  /** The host the predecessor runs on. */
  callerHost: string
  brokerHost: string
  launchers: readonly ConnectedLauncher[]
  /** Config `machines`: alias → hostname. */
  aliases: Readonly<Record<string, string>>
}

export interface Destination {
  site: DestinationSite
  host: string
  /** Known only for a launcher; the broker and caller sites know their own. */
  platform?: NodeJS.Platform
}

export type DestinationResult = { ok: true; destination: Destination } | { ok: false; reason: string }

/** Hostnames are case-insensitive, and so are the aliases a human types for them. */
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

function aliasTarget(to: string, aliases: Readonly<Record<string, string>>): string | undefined {
  const alias = Object.keys(aliases).find(name => same(name, to))
  return alias === undefined ? undefined : aliases[alias]
}

function knownMachines(input: DestinationInput): string {
  const named = Object.entries(input.aliases).map(([alias, host]) => `${alias} (${host})`)
  const hosts = [input.brokerHost, input.callerHost, ...input.launchers.map(l => l.host)]
  return [...new Set([...named, ...hosts])].join(', ')
}

export function resolveDestination(input: DestinationInput): DestinationResult {
  const { to, callerHost, brokerHost, launchers } = input
  const host = to === undefined ? callerHost : (aliasTarget(to, input.aliases) ?? to)
  if (same(host, callerHost))
    return {
      ok: true,
      destination: { site: same(callerHost, brokerHost) ? 'broker' : 'caller', host: callerHost },
    }
  if (same(host, brokerHost)) return { ok: true, destination: { site: 'broker', host: brokerHost } }
  const launcher = launchers.find(l => same(l.host, host))
  if (launcher !== undefined)
    return { ok: true, destination: { site: 'launcher', host: launcher.host, platform: launcher.platform } }
  const known = Object.values(input.aliases).some(target => same(target, host))
  const why = known ? `no launcher connected on ${host}` : `unknown machine "${to}"`
  return { ok: false, reason: `${why}; known machines: ${knownMachines(input)}` }
}

/**
 * CC-951: why a path handed to a launcher on another machine is refused, checked here before the
 * probe and again before the launch. The broker cannot read that machine's disk, so the check is
 * lexical: absolute, already normal (no `..`), clear of credential directories, and strictly
 * under the home directory, which this deployment shares across its machines. Whether it exists
 * there is the launcher's probe to say.
 */
export function remotePathBlocker(label: string, dir: string, home: string): string | undefined {
  if (!path.isAbsolute(dir) || path.normalize(dir) !== dir || dir.split(path.sep).includes('..'))
    return `its ${label} ${dir} is not an absolute, normalised path`
  const sensitive = SENSITIVE_DIRS.find(name => dir.split(path.sep).includes(name))
  if (sensitive !== undefined) return `its ${label} ${dir} is inside a protected directory ("${sensitive}")`
  if (!dir.startsWith(home + path.sep)) return `its ${label} ${dir} is not under the home directory ${home}`
  return undefined
}
