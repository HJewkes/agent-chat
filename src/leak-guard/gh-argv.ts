import { ghCommandWords, HIDDEN } from './gh-runs.js'

/**
 * gh's argv as gh reads it, for the parts the implementer allowlist needs (CC-1120 e): cobra's
 * group and verb search, and pflag's parse of `gh api`'s own flags. A word the guard cannot resolve
 * is undefined. Anything this file cannot place is reported, never guessed: the caller denies it.
 */

export type Argv = readonly (string | undefined)[]
export type Unparsed = 'unresolved' | 'unknown-flag'

/** The flags gh's root command takes before a group or verb, besides `--repo=…`. */
const ROOT_VALUE = new Set(['-R', '--repo'])
const ROOT_BOOL = new Set(['-h', '--help', '--version'])

/** `gh api`'s flag table (gh 2.102 `gh api --help`), by spelling. */
const API_VALUE = new Set(
  `-X --method -H --header -f --raw-field -F --field --input -q --jq -t --template --hostname
  --cache -p --preview`.split(/\s+/),
)
const API_BOOL = new Set('-i --include --paginate --slurp --silent --verbose -h --help'.split(' '))

/** A resolved group and verb; `rest` keeps unresolved words, which can no longer change the command. */
export interface GhCommand {
  group: string | undefined
  verb: string | undefined
  rest: Argv
}

/** Every word before `end` but the group is a root flag gh knows, with its value when it takes one. */
function rootFlags(args: Argv, end: number, group: number): 'ok' | Unparsed {
  for (let i = 0; i < end; i++) {
    const word = args[i]
    if (i === group) continue
    if (word === undefined) return 'unresolved'
    if (ROOT_VALUE.has(word)) {
      i++
      if (args[i] === undefined) return i < args.length ? 'unresolved' : 'unknown-flag'
    } else if (!ROOT_BOOL.has(word) && !word.startsWith('--repo=')) return 'unknown-flag'
  }
  return 'ok'
}

const known = (args: Argv): string[] | 'unresolved' =>
  args.every(arg => arg !== undefined) ? (args as string[]) : 'unresolved'

/**
 * The group and verb gh runs, found the way cobra finds them. `api` takes no verb: its rest is every
 * other word, root flags included, for parseGhApi. A word the guard cannot resolve where gh may read
 * a command word is 'unresolved'; a flag before the group or verb that gh's root does not take is
 * 'unknown-flag'.
 */
export function ghCommand(args: Argv): GhCommand | Unparsed {
  const at = ghCommandWords(args, 2)
  if (at.includes(HIDDEN)) return 'unresolved'
  const [group, verb] = at
  if (group !== undefined && args[group] === 'api')
    return { group: 'api', verb: undefined, rest: args.filter((_, i) => i !== group) }
  const end = verb ?? group ?? args.length
  const flags = rootFlags(args, end, group ?? -1)
  if (flags !== 'ok') return flags
  const word = (i: number | undefined): string | undefined => (i === undefined ? undefined : args[i])
  return { group: word(group), verb: word(verb), rest: args.slice(end + 1) }
}

export interface GhApiCall {
  flags: [string, string][]
  positionals: string[]
}

/** One `-abc` word as pflag reads it: switches until a value letter, which takes the rest or the next word. */
function shortCluster(
  word: string,
  next: string | undefined,
): { flags: [string, string][]; used: number } | Unparsed {
  const flags: [string, string][] = []
  for (let k = 1; k < word.length; k++) {
    const name = `-${word[k] as string}`
    const attached = word.slice(k + 1)
    if (API_VALUE.has(name)) {
      if (attached !== '') return { flags: [...flags, [name, attached.replace(/^=/, '')]], used: 1 }
      return next === undefined ? 'unknown-flag' : { flags: [...flags, [name, next]], used: 2 }
    }
    if (!API_BOOL.has(name)) return 'unknown-flag'
    if (attached.startsWith('=')) return { flags: [...flags, [name, attached.slice(1)]], used: 1 }
    flags.push([name, ''])
  }
  return { flags, used: 1 }
}

/** One `--name` or `--name=value` word, with the next word when it is a value flag's. */
function longFlag(
  word: string,
  next: string | undefined,
): { flags: [string, string][]; used: number } | Unparsed {
  const eq = word.indexOf('=')
  const name = eq < 0 ? word : word.slice(0, eq)
  if (!API_VALUE.has(name) && !API_BOOL.has(name)) return 'unknown-flag'
  if (eq >= 0) return { flags: [[name, word.slice(eq + 1)]], used: 1 }
  if (API_BOOL.has(name)) return { flags: [[name, '']], used: 1 }
  return next === undefined ? 'unknown-flag' : { flags: [[name, next]], used: 2 }
}

/**
 * A `gh api` call's flags and positionals, parsed once the way pflag parses them: a value flag takes
 * the next word even when it starts with `-`, `--` ends flags, and any flag off gh api's table is
 * 'unknown-flag'. Any word the guard cannot resolve is 'unresolved'.
 */
export function parseGhApi(args: Argv): GhApiCall | Unparsed {
  const words = known(args)
  if (words === 'unresolved') return words
  const call: GhApiCall = { flags: [], positionals: [] }
  for (let i = 0; i < words.length;) {
    const word = words[i] as string
    if (word === '--') {
      call.positionals.push(...words.slice(i + 1))
      break
    }
    if (!word.startsWith('-') || word === '-') {
      call.positionals.push(word)
      i++
      continue
    }
    const parsed = word.startsWith('--') ? longFlag(word, words[i + 1]) : shortCluster(word, words[i + 1])
    if (typeof parsed === 'string') return parsed
    call.flags.push(...parsed.flags)
    i += parsed.used
  }
  return call
}

const READ_METHODS = new Set(['GET', 'HEAD'])
const METHOD_WORD = /^(?:-[A-Za-z]*X=?|--method=)(.+)$/
const FIELD_WORD = /^-(?!-)[^=]*[fF]|^--(?:raw-)?field(?:=|$)|^--input(?:=|$)/
const HEADER_WORD = /method|override/i

/** One word that looks like a write on its own; a method flag's detached value is parseGhApi's to read. */
function writeShaped(word: string): boolean {
  const method = METHOD_WORD.exec(word)?.[1]
  if (method !== undefined) return !READ_METHODS.has(method.toUpperCase())
  if (word === '--method') return false
  return FIELD_WORD.test(word) || HEADER_WORD.test(word)
}

/**
 * Whether any word, flag values included, looks like a write: a method spelling whose value is not
 * GET or HEAD, a field or input spelling, or a word naming a method or override header. It is
 * deliberately over-broad, so a parser disagreement can only cost a false deny.
 */
export const mayWrite = (words: readonly string[]): boolean =>
  words.some(word => writeShaped(word) || writeShaped(word.slice(word.indexOf('=') + 1)))
