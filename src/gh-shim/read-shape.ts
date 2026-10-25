import { GH_GROUPS } from '../gh-write/gh-groups.js'
import { classifyApiRead } from '../leak-guard/gh-api-read.js'
import { READ_SUBCOMMANDS } from './rate-limit.js'

/**
 * CC-1644: the gh commands the shim runs without a gh-write ticket. Every word is read at an exact
 * position of the argv gh gets, after the shell has expanded it, so a hidden head (`f gh …`,
 * `"$@"`, `$b …`) arrives here as plain words. Anything not listed is a write until proven a read.
 */

export const AUTH_READS: ReadonlySet<string> = new Set(['status', 'token', 'git-credential'])
export const DOWNLOAD_GROUPS: ReadonlySet<string> = new Set(['run', 'release'])
const HELP_WORDS = new Set(['--help', '-h'])

/** The strict leak-guard classifier: allowlisted flags, one REST endpoint, no graphql, URL or method. */
function isApiRead(argv: readonly string[]): boolean {
  return classifyApiRead(argv, argv, []) === 'read'
}

/** `gh help …`, `gh -h`, `gh pr -h`, `gh pr view -h`: the help word comes last, with no room for a value flag before it. */
const isHelp = (argv: readonly string[]): boolean =>
  argv[0] === 'help' || (argv.length <= 3 && HELP_WORDS.has(argv[argv.length - 1] ?? ''))

export function isKnownRead(argv: readonly string[]): boolean {
  const [group = '', verb = ''] = argv
  if (argv.length === 0 || isHelp(argv)) return true
  if (argv.length === 1 && (group === 'version' || group === '--version')) return true
  if (group === 'search') return true
  if (group === 'auth' && AUTH_READS.has(verb)) return true
  if (DOWNLOAD_GROUPS.has(group) && verb === 'download') return true
  if (group === 'api') return isApiRead(argv)
  return GH_GROUPS.has(group) && READ_SUBCOMMANDS.has(verb)
}
