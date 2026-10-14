/**
 * Reads a `NODE_OPTIONS` value as node does, to tell whether it may load code into every node
 * process that inherits it, a repository's husky or lint-staged hook included (TP-2856).
 */

/**
 * Options that only size memory, shape warnings or traces, or pick a module mode. An allowlist
 * rather than a list of bad flags: node adds options every release, and the ones that load code
 * (`--require`, `--import`, `--loader`, `--openssl-config`, `--inspect`, ...) must fail closed.
 * Every name is in `process.allowedNodeEnvironmentFlags` on the repo's pinned node.
 */
export const NODE_OPTIONS_INERT: ReadonlySet<string> = new Set([
  '--max-old-space-size',
  '--max-semi-space-size',
  '--max-heap-size',
  '--max-old-space-size-percentage',
  '--stack-trace-limit',
  '--v8-pool-size',
  '--expose-gc',
  '--enable-source-maps',
  '--no-enable-source-maps',
  '--warnings',
  '--no-warnings',
  '--deprecation',
  '--no-deprecation',
  '--disable-warning',
  '--pending-deprecation',
  '--throw-deprecation',
  '--trace-deprecation',
  '--trace-warnings',
  '--trace-uncaught',
  '--trace-exit',
  '--unhandled-rejections',
  '--experimental-vm-modules',
  '--experimental-strip-types',
  '--experimental-detect-module',
  '--no-experimental-detect-module',
  '--experimental-require-module',
  '--no-experimental-require-module',
  '--dns-result-order',
  '--use-openssl-ca',
  '--use-system-ca',
  '--use-bundled-ca',
])

/** Node parses double quotes and backslashes itself; the others leave an expansion unread. */
const UNREADABLE = /["'\\$`]/

const OPTION = /^--([A-Za-z0-9_-]+)(?:=[A-Za-z0-9._:,-]*)?$/

/** True unless every space-separated token of the literal value is an inert `--name[=value]`. */
export function nodeOptionsLoadsCode(value: string): boolean {
  if (UNREADABLE.test(value)) return true
  return value
    .split(/\s+/)
    .filter(token => token !== '')
    .some(token => !inertToken(token))
}

function inertToken(token: string): boolean {
  const name = OPTION.exec(token)?.[1]
  // node folds `_` to `-` in option names, so `--max_old_space_size` is the same option.
  return name !== undefined && NODE_OPTIONS_INERT.has(`--${name.replaceAll('_', '-')}`)
}
