import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { GH_GROUPS } from '../gh-write/gh-groups.js'
import { posixShell } from '../leak-guard/posix-shell.js'
import { READ_SUBCOMMANDS } from './rate-limit.js'
import { AUTH_READS, DOWNLOAD_GROUPS } from './read-shape.js'
import { GH_WRITE_TICKET_ENV } from './ticket.js'

/** Set by the shim script so the shim can skip its own directory when it looks for the real gh. */
export const GH_SHIM_DIR_ENV = 'AGENT_CHAT_GH_SHIM_DIR'

/** `1` sends every command the write gate lets through straight to the real gh, for when the shim itself is the suspect. */
export const GH_SHIM_OFF_ENV = 'AGENT_CHAT_GH_SHIM_OFF'

/** CC-1644: where the shim finds gh-write's launch keys; a literal on the exec line, so env cannot move it. */
export const GH_KEY_ROOT_ENV = 'AGENT_CHAT_GH_KEY_ROOT'

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

/**
 * CC-664: entries are compared by physical path, so a symlink to the shim dir or a trailing-slash
 * spelling of it is dropped too; an exact-string match left those, and `exec gh` re-ran this script forever.
 */
const dropOwnDirFromPath = (dir: string): string[] => [
  'unset CDPATH',
  `self=$(cd -P -- ${quote(dir)} 2>/dev/null && pwd -P) || self=${quote(dir)}`,
  'kept=',
  'set -f',
  'IFS=:',
  'for entry in $PATH; do',
  '  real=$(cd -P -- "$entry" 2>/dev/null && pwd -P) || real=$entry',
  '  [ "$real" = "$self" ] || kept=${kept:+$kept:}$entry',
  'done',
  'unset IFS',
  'set +f',
  'PATH=$kept',
]

const patterns = (words: Iterable<string>): string => [...words].map(quote).join('|')

/**
 * CC-1644: the fallback's read list, a subset of `isKnownRead`. It cannot check a ticket or
 * classify `gh api`, so with the build gone every write and every api call is refused.
 */
const knownReadFunction = (): string[] => [
  'known_read() {',
  '  [ "$#" -eq 0 ] && return 0',
  '  case "$1" in',
  '    search|help) return 0 ;;',
  `    version|--version) [ "$#" -eq 1 ] && return 0 ;;`,
  `    auth) case "$2" in ${patterns(AUTH_READS)}) return 0 ;; esac ;;`,
  `    ${patterns(DOWNLOAD_GROUPS)}) [ "$2" = download ] && return 0 ;;`,
  '  esac',
  '  case "$1" in',
  `    ${patterns([...GH_GROUPS].filter(group => group !== 'api'))})`,
  `      case "$2" in ${patterns(READ_SUBCOMMANDS)}) return 0 ;; esac ;;`,
  '  esac',
  '  return 1',
  '}',
  'if ! known_read "$@"; then',
  `  echo 'gh-shim: refused (write): the shim build is gone, so only known reads run. Post a write with: agent-chat gh-write -- <args>.' >&2`,
  '  exit 1',
  'fi',
  `unset ${GH_WRITE_TICKET_ENV}`,
]

/** Falls back to the real gh for a known read when the node or the build it was written against has gone. */
export const ghShimScript = (
  dir: string,
  node: string,
  main: string,
  keyRoot: string,
  shell = posixShell(),
): string =>
  [
    `#!${shell}`,
    '# Written by agent-chat at each spawn (CC-395); answers read-only gh commands from REST.',
    `if [ -x ${quote(node)} ] && [ -f ${quote(main)} ]; then`,
    `  ${GH_SHIM_DIR_ENV}=${quote(dir)} ${GH_KEY_ROOT_ENV}=${quote(keyRoot)} exec ${quote(node)} ${quote(main)} "$@"`,
    'fi',
    ...knownReadFunction(),
    ...dropOwnDirFromPath(dir),
    'export PATH',
    'exec gh "$@"',
    '',
  ].join('\n')

/** One directory per build, so a spawn from a worktree's dist never repoints the script other agents run. */
export const shimDirFor = (root: string, main: string): string =>
  path.join(root, createHash('sha256').update(main).digest('hex').slice(0, 12))

/** Rewritten through a rename on every launch, so a concurrent spawn never execs a half-written file. */
export function writeGhShim(root: string, node: string, main: string, keyRoot: string): string {
  const dir = shimDirFor(root, main)
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, 'gh')
  const temp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temp, ghShimScript(dir, node, main, keyRoot), { mode: 0o755 })
  fs.renameSync(temp, target)
  return dir
}

export function withShimOnPath(env: Record<string, string>, dir: string): Record<string, string> {
  const rest = (env.PATH ?? '').split(path.delimiter).filter(entry => entry !== '' && entry !== dir)
  return { ...env, PATH: [dir, ...rest].join(path.delimiter) }
}
