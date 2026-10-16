import fs from 'node:fs'

export type NodePathFs = {
  exists: (p: string) => boolean
  realpath: (p: string) => string
}

const realFs: NodePathFs = { exists: fs.existsSync, realpath: fs.realpathSync }

const CELLAR_NODE = /^(.*)\/Cellar\/node(@\d+)?\/[^/]+\/bin\/node$/

/**
 * A Homebrew Cellar node path names one version and vanishes on `brew upgrade` (CC-838), so an installed
 * job is pointed at the version-stable opt link, then the prefix bin link, when either runs the same binary.
 */
export function stableNodePath(execPath: string, ops: NodePathFs = realFs): string {
  const match = CELLAR_NODE.exec(execPath)
  if (match === null) return execPath
  const [, prefix, version = ''] = match
  const candidates = [`${prefix}/opt/node${version}/bin/node`, `${prefix}/bin/node`]
  const target = ops.realpath(execPath)
  const sameBinary = (candidate: string): boolean =>
    ops.exists(candidate) && ops.realpath(candidate) === target
  return candidates.find(sameBinary) ?? execPath
}

/** The node path every installed job (launchd plist, systemd unit) bakes in; one helper so no install verb misses it. */
export const jobNodePath = (): string => stableNodePath(process.execPath)
