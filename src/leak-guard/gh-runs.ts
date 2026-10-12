import path from 'node:path'
import { isMap, isScalar, parseDocument, type Node, type Pair, type YAMLMap } from 'yaml'
import { fillPositionals, splitAlias } from './git-alias.js'

/**
 * gh aliases run what they expand to (TP-2371): a shell alias through `sh -c`, a plain one as
 * another gh command. The guard checks a body when `gh alias set` writes it, and again when
 * `gh <alias>` runs it, read from gh's `config.yml`. The read runs inside the PreToolUse hook, so
 * it never throws: a missing file reads as no alias, and a file the guard cannot parse the way gh
 * does reads as unreadable, which denies.
 */

/**
 * The words gh runs as its own commands before any alias or extension: `gh help` on gh 2.102,
 * plus the hidden commands, help topics and command aliases it also accepts. A config alias
 * shadows `co`, `help`, `__complete` and `__completeNoDesc` (probed on 2.102), so they are left out.
 */
export const GH_BUILTINS = new Set(
  `a11y accessibility actions agent agent-task agents alias api at attestation auth browse cache
  codespace completion config copilot credits cs discussion environment exit-codes ext extension
  extensions formatting gist gpg-key issue label licenses mintty org pr preview project reference
  release repo rs ruleset run search secret skill skills ssh-key status variable version
  workflow`.split(/\s+/),
)

export interface GhAlias {
  /** The expansion runs through `sh -c` (it was set with `--shell` or starts with `!`). */
  shell: boolean
  /** The expansion without its leading `!`. */
  body: string
}

export type GhAliases = { kind: 'ok'; aliases: ReadonlyMap<string, GhAlias> } | { kind: 'unreadable' }

export type ReadGhAliases = () => GhAliases

type Env = Readonly<Record<string, string | undefined>>

const NONE: GhAliases = { kind: 'ok', aliases: new Map() }
const UNREADABLE: GhAliases = { kind: 'unreadable' }

/** Where gh keeps `config.yml`: `GH_CONFIG_DIR`, else `$XDG_CONFIG_HOME/gh`, else `~/.config/gh`. */
export function ghConfigDir(env: Env): string | undefined {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'gh')
  return env.HOME ? path.join(env.HOME, '.config', 'gh') : undefined
}

const toAlias = (value: string): GhAlias =>
  value.startsWith('!') ? { shell: true, body: value.slice(1) } : { shell: false, body: value }

const scalarKey = (pair: Pair): string | undefined =>
  isScalar(pair.key) && pair.key.value !== null ? String(pair.key.value) : undefined

/** gh keeps the first of two equal keys, so the guard reads the first too. */
function aliasesIn(map: YAMLMap): GhAliases {
  const aliases = new Map<string, GhAlias>()
  for (const pair of map.items) {
    const key = scalarKey(pair)
    const value = pair.value as Node | null
    if (key === undefined || !isScalar(value) || value.value === null) return UNREADABLE
    if (!aliases.has(key)) aliases.set(key, toAlias(String(value.value)))
  }
  return { kind: 'ok', aliases }
}

export function parseGhAliases(text: string): GhAliases {
  try {
    const doc = parseDocument(text, { uniqueKeys: false })
    if (doc.errors.length > 0) return UNREADABLE
    if (doc.contents === null) return NONE
    if (!isMap(doc.contents)) return UNREADABLE
    const node = doc.contents.items.find(pair => scalarKey(pair) === 'aliases')?.value as Node | null
    if (node === undefined || node === null || (isScalar(node) && node.value === null)) return NONE
    return isMap(node) ? aliasesIn(node) : UNREADABLE
  } catch {
    return UNREADABLE
  }
}

/** Reads gh's aliases once, from the config the hook's own environment points gh at. */
export function ghAliasReader(env: Env, read: (file: string) => string | undefined): ReadGhAliases {
  let aliases: GhAliases | undefined
  return () => {
    if (aliases === undefined) {
      const dir = ghConfigDir(env)
      const text = dir === undefined ? undefined : read(path.join(dir, 'config.yml'))
      aliases = text === undefined ? NONE : parseGhAliases(text)
    }
    return aliases
  }
}

/** The command line a shell alias runs: gh calls `sh -c <body> -- <args>` and appends nothing. */
export const ghShellAlias = (body: string, rest: readonly string[]): string => fillPositionals(body, rest)

/**
 * The gh words a plain alias runs, as gh builds them: each `$N` is replaced in the text before it
 * is split, an argument left over once no `$` remains is appended, and a `$N` left unfilled makes
 * gh refuse to run (undefined).
 */
export function ghPlainAlias(expansion: string, rest: readonly string[]): string[] | undefined {
  const extra: string[] = []
  let filled = expansion
  rest.forEach((arg, i) => {
    if (filled.includes('$')) filled = filled.replaceAll(`$${i + 1}`, arg)
    else extra.push(arg)
  })
  if (/\$\d/.test(filled)) return undefined
  const words = splitAlias(filled)
  return words === undefined ? undefined : [...words, ...extra]
}

/** The only boolean flags gh's root command knows; cobra lets any other flag take the next word. */
const ROOT_BOOLS = new Set(['--help', '--version'])

/** HIDDEN marks a word the guard cannot resolve where gh may read a command word. */
export const HIDDEN = -1

/**
 * The positions of the first `max` command words, found the way cobra's `stripFlags` finds them:
 * `--` ends the search, a `--flag` or `-f` without `=` that is not a known boolean swallows the
 * next word, and any other `-` word is skipped. gh hands an alias every word but these.
 */
export function ghCommandWords(args: readonly (string | undefined)[], max: number): number[] {
  const at: number[] = []
  for (let i = 0; i < args.length && at.length < max; i++) {
    const word = args[i]
    if (word === undefined) return [...at, HIDDEN]
    if (word === '--') break
    const swallows = !word.includes('=') && !ROOT_BOOLS.has(word)
    if (word.startsWith('--') || (word.startsWith('-') && word.length === 2)) {
      if (swallows) i++
    } else if (word !== '' && !word.startsWith('-')) at.push(i)
  }
  return at
}

/**
 * What a `gh alias` call defines: a body to check, `unread` for an import or a `-` expansion read
 * from stdin, `hidden` for a word or flag the guard cannot read, undefined when it defines nothing.
 */
export type GhAliasSet = { kind: 'body'; alias: GhAlias } | { kind: 'unread' } | { kind: 'hidden' }

const TRUE = new Set(['1', 't', 'T', 'true', 'TRUE', 'True'])
const FALSE = new Set(['0', 'f', 'F', 'false', 'FALSE', 'False'])
const SET_FLAGS: Record<string, string> = {
  s: 'shell',
  h: 'help',
  shell: 'shell',
  help: 'help',
  clobber: 'clobber',
}

type Flags = Map<string, boolean>

/** One flag word read the way pflag reads `alias set`'s booleans: `--name[=v]`, or `-abc` and `-a=v`. */
function readFlag(word: string, flags: Flags): boolean {
  const long = word.startsWith('--')
  const body = word.slice(long ? 2 : 1)
  const eq = body.indexOf('=')
  const names = long || eq === 1 ? [eq < 0 ? body : body.slice(0, eq)] : [...body]
  const value = eq < 0 ? 'true' : body.slice(eq + 1)
  if (!TRUE.has(value) && !FALSE.has(value)) return false
  for (const name of names) {
    const flag = SET_FLAGS[name]
    if (flag === undefined || long !== name.length > 1) return false
    flags.set(flag, TRUE.has(value))
  }
  return true
}

/** `rest` is every word of `gh alias set` but its two command words; flags may come anywhere before `--`. */
export function ghAliasSet(rest: readonly (string | undefined)[]): GhAliasSet | undefined {
  const flags: Flags = new Map()
  const positionals: string[] = []
  let parsing = true
  for (const word of rest) {
    if (word === undefined) return { kind: 'hidden' }
    if (parsing && word === '--') parsing = false
    else if (parsing && word.length > 1 && word.startsWith('-')) {
      if (!readFlag(word, flags)) return { kind: 'hidden' }
    } else positionals.push(word)
  }
  const [, expansion] = positionals
  if (flags.get('help') === true || positionals.length !== 2 || expansion === undefined) return undefined
  if (expansion === '-') return { kind: 'unread' }
  const alias = toAlias(expansion)
  return { kind: 'body', alias: { ...alias, shell: flags.get('shell') === true || alias.shell } }
}
