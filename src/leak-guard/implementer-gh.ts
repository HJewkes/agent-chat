import { ghCommand, mayWrite, parseGhApi, type Argv, type GhApiCall } from './gh-argv.js'

/**
 * The gh calls an implementer session may make (CC-1120 e). It is an allowlist over gh-argv's
 * parse, so a call that does not parse to a known-safe shape is denied: 'deny' for a command off
 * the list, 'unread' for one the guard cannot resolve. Where the guard sees a gh call at all is the
 * claim in docs/leak-guard.md.
 */

export type ImplementerVerdict = 'deny' | 'unread' | undefined

// Profiles carry no role field the hook can read, so the implementer profiles are named here (CC-1564).
const IMPLEMENTER_PROFILES: ReadonlySet<string> = new Set(['bd-implementer', 'bd-implementer-lite'])

export const isImplementerProfile = (profile: string | undefined): boolean =>
  IMPLEMENTER_PROFILES.has(profile ?? '')

const ANY_VERB = '*'
const verbs = (list: string): ReadonlySet<string> => new Set(list.split(' '))

/** The groups and verbs an implementer runs, from observed implementer usage plus read-only verbs. */
const ALLOWED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['pr', verbs('create view checks list diff status comment edit ready checkout')],
  ['issue', verbs('view list create comment edit')],
  ['run', verbs('view list watch rerun download')],
  ['workflow', verbs('view list')],
  ['repo', verbs('view clone')],
  ['search', verbs(ANY_VERB)],
  ['help', verbs(ANY_VERB)],
  ['auth', verbs('status')],
])

const SEG = '(?:(?!\\.\\.?/)[A-Za-z0-9_.-]+)'
/** The writes an implementer makes: open, edit or comment on a pull or an issue. None merges or moves a ref. */
const WRITE_ENDPOINT = new RegExp(
  `^/?repos/(?:\\{owner\\}|${SEG})/(?:\\{repo\\}|${SEG})/(?:pulls|pulls/\\d+|issues|issues/\\d+|issues/\\d+/comments)$`,
)

const READ_METHODS = new Set(['GET', 'HEAD'])
const METHOD_FLAGS = new Set(['-X', '--method'])
const FIELD_FLAGS = new Set(['-f', '-F', '--field', '--raw-field', '--input'])

/** A read on both layers: every method GET or HEAD and no field flag, and no write-shaped word at all. */
function reads(call: GhApiCall, words: readonly string[]): boolean {
  const parsedRead = call.flags.every(([name, value]) =>
    METHOD_FLAGS.has(name) ? READ_METHODS.has(value.toUpperCase()) : !FIELD_FLAGS.has(name),
  )
  return parsedRead && !mayWrite(words)
}

function apiVerdict(rest: Argv): ImplementerVerdict {
  const call = parseGhApi(rest)
  if (typeof call === 'string' || call.positionals.length !== 1) return 'unread'
  const endpoint = call.positionals[0] as string
  if (/graphql/i.test(endpoint)) return 'unread'
  if (reads(call, rest as string[])) return undefined
  return WRITE_ENDPOINT.test(endpoint) ? undefined : 'deny'
}

/** Whether a resolved group and verb is on the allowlist; no group at all is `gh`, `gh --version` or help. */
function allowed(group: string | undefined, verb: string | undefined): boolean {
  if (group === undefined) return true
  const list = ALLOWED.get(group)
  if (list === undefined) return false
  return list.has(ANY_VERB) || (verb !== undefined && list.has(verb))
}

/**
 * Whether a builtin call may rebind a command name, so a later `g` runs gh under a word the guard reads as
 * another program: an alias definition, a `hash` entry (zsh `hash g=/path`, bash `hash -p /path g`), or zsh's
 * `enable`/`disable`. Listing or clearing (`alias`, `alias g`, `hash`, `hash -r`) rebinds nothing.
 */
export function rebindsName(name: string, args: readonly (string | undefined)[]): boolean {
  if (name === 'enable' || name === 'disable') return true
  if (name === 'alias') return args.some(arg => arg === undefined || arg.includes('='))
  if (name === 'hash') return args.some(arg => arg === undefined || !arg.startsWith('-') || arg.includes('p'))
  return false
}

/** The verdict on one gh call's words after `gh` (or after `agent-chat gh-write --`); undefined allows it. */
export function implementerGh(args: Argv): ImplementerVerdict {
  const command = ghCommand(args)
  if (typeof command === 'string') return 'unread'
  if (command.group === 'api') return apiVerdict(command.rest)
  return allowed(command.group, command.verb) ? undefined : 'deny'
}
