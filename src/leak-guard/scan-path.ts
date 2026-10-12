import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCANNER_PACKAGE = '@titan-design/egress-scan'

/** Resolves a bare specifier to a file URL, the way `import` would from this module. */
export type Resolve = (specifier: string) => string

const sameFile = (a: string, b: string): boolean => {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b)
  } catch {
    return false
  }
}

/** The `node_modules/.bin` beside the installed scanner package, if its `titan-egress-scan` is that package's. */
function scannerBinDir(resolve: Resolve): string | undefined {
  const entry = fileURLToPath(resolve(SCANNER_PACKAGE))
  const packageDir = path.dirname(path.dirname(entry))
  const nodeModules = path.dirname(path.dirname(packageDir))
  if (path.basename(nodeModules) !== 'node_modules') return undefined
  const binDir = path.join(nodeModules, '.bin')
  return sameFile(path.join(binDir, 'titan-egress-scan'), path.join(packageDir, 'dist', 'bin.js'))
    ? binDir
    : undefined
}

/**
 * agent-chat's own scanner dir and the node running the broker, so a broker whose PATH lacks the
 * scanner still scans (CC-461). A scanner that cannot be resolved, or whose bin link points
 * elsewhere, is left out and the hook falls back to the broker's PATH alone.
 */
export function ownToolDirs(resolve: Resolve = specifier => import.meta.resolve(specifier)): string[] {
  const nodeDir = path.dirname(process.execPath)
  try {
    const binDir = scannerBinDir(resolve)
    return binDir === undefined ? [nodeDir] : [binDir, nodeDir]
  } catch {
    return [nodeDir]
  }
}

/** Appends each absolute dir not already on the PATH, so a scanner the owner installed still wins. */
export function withOwnTools(brokerPath: string, dirs: readonly string[]): string {
  const entries = brokerPath.split(':').filter(dir => dir !== '')
  const added = dirs.filter(dir => path.isAbsolute(dir) && !entries.includes(dir))
  return [...entries, ...new Set(added)].join(':')
}
