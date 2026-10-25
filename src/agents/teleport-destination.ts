/**
 * CC-951: which machine a teleport's successor lands on, and who launches it there.
 *
 * `broker`: this broker's own host launches it. `caller`: the predecessor's own host, reached
 * through its MCP process (CC-881). `launcher`: a host launcher connected for another machine,
 * chosen only when that machine is configured and its launcher's hello proved its host key (CC-1331).
 * Pure: the caller supplies the hosts, the connected launchers and the configured aliases.
 */

import path from 'node:path'
import { SENSITIVE_DIRS } from './spawn-cwd.js'

export type DestinationSite = 'broker' | 'caller' | 'launcher'

/** A host launcher connected to the broker, presence-only. */
export interface ConnectedLauncher {
  host: string
  platform: NodeJS.Platform
  /** CC-1331: the broker checked the hello's proof of this host's launcher key over the connection's nonce. */
  proved: boolean
}

export interface DestinationInput {
  /** An alias from config `machines` or a hostname; absent means the predecessor's own host. */
  to?: string | undefined
  /** The host the predecessor runs on. */
  callerHost: string
  brokerHost: string
  launchers: readonly ConnectedLauncher[]
  /** Configured machines (config `machines` over key-registered ones): alias → hostname. */
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

const configured = (host: string, aliases: Readonly<Record<string, string>>): boolean =>
  Object.values(aliases).some(target => same(target, host))

/** Why a connected launcher may not take the successor, or undefined when it may. */
function launcherRefusal(
  launcher: ConnectedLauncher,
  aliases: Readonly<Record<string, string>>,
): string | undefined {
  if (!configured(launcher.host, aliases))
    return `${launcher.host} is not one of the configured machines; add it to config machines or run host key-new`
  if (!launcher.proved)
    return `the launcher on ${launcher.host} has not proved its host key; provision its launcher key and restart it`
  return undefined
}

function knownMachines(input: DestinationInput): string {
  const named = Object.entries(input.aliases).map(([alias, host]) => `${alias} (${host})`)
  const routable = input.launchers.filter(l => launcherRefusal(l, input.aliases) === undefined)
  const hosts = [input.brokerHost, input.callerHost, ...routable.map(l => l.host)]
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
  const refusal = launcher === undefined ? undefined : launcherRefusal(launcher, input.aliases)
  if (launcher !== undefined && refusal === undefined)
    return { ok: true, destination: { site: 'launcher', host: launcher.host, platform: launcher.platform } }
  const known = configured(host, input.aliases)
  const why = refusal ?? (known ? `no launcher connected on ${host}` : `unknown machine "${to}"`)
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
