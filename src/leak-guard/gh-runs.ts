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
  release repo rs ruleset run search secret skill skills ssh-key status telemetry variable
  version workflow`.split(/\s+/),
)

const subcommands = (groups: string, words: string): [string, ReadonlySet<string>][] => {
  const set = new Set(words.split(/\s+/))
  return groups.split(' ').map(group => [group, set])
}

/**
 * Each gh command's own subcommands and their aliases (gh 2.102, `gh __complete <group>` and each
 * subcommand's ALIASES), which gh runs before a `group word` config alias of the same name.
 */
const GH_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ...subcommands('agent-task', 'create list view'),
  ...subcommands('alias', 'delete import list ls set'),
  ...subcommands('attestation', 'download trusted-root verify'),
  ...subcommands('auth', 'git-credential login logout refresh setup-git status switch token'),
  ...subcommands('cache', 'delete list ls'),
  ...subcommands('codespace', 'code cp create delete edit jupyter list ls logs ports rebuild ssh stop view'),
  ...subcommands('config', 'clear-cache get list ls set'),
  ...subcommands('discussion', 'comment create edit list ls view'),
  ...subcommands('extension', 'browse create exec install list ls remove uninstall search upgrade'),
  ...subcommands('gist', 'clone create new delete edit list ls rename view'),
  ...subcommands('gpg-key ssh-key', 'add delete list ls'),
  ...subcommands(
    'issue',
    `close comment create new delete develop edit list ls lock pin reopen status transfer unlock
    unpin view`,
  ),
  ...subcommands('label', 'clone create delete edit list ls'),
  ...subcommands('org', 'list ls'),
  ...subcommands(
    'pr',
    `checkout co checks close comment create new diff edit list ls lock merge ready reopen revert
    review status unlock update-branch view`,
  ),
  ...subcommands('preview', 'prompter'),
  ...subcommands(
    'project',
    `close copy create delete edit field-create field-delete field-list item-add item-archive
    item-create item-delete item-edit item-list link list ls mark-template unlink view`,
  ),
  ...subcommands(
    'release',
    'create new delete delete-asset download edit list ls upload verify verify-asset view',
  ),
  ...subcommands(
    'repo',
    `archive autolink clone create new delete deploy-key edit fork gitignore license list ls
    read-dir read-file rename set-default sync unarchive view`,
  ),
  ...subcommands('ruleset', 'check list ls view'),
  ...subcommands('run', 'cancel delete download list ls rerun view watch'),
  ...subcommands('search', 'code commits issues prs repos'),
  ...subcommands('secret', 'delete remove list ls set'),
  ...subcommands('skill', 'install add list ls preview show publish search update'),
  ...subcommands('variable', 'delete remove get list ls set'),
  ...subcommands('workflow', 'disable enable list ls run view'),
])

/** gh's command aliases, by the name gh resolves them to (gh 2.102 ALIASES). */
const COMMAND_ALIASES: Readonly<Record<string, string>> = {
  a11y: 'accessibility',
  agent: 'agent-task',
  agents: 'agent-task',
  at: 'attestation',
  cs: 'codespace',
  ext: 'extension',
  extensions: 'extension',
  rs: 'ruleset',
  skills: 'skill',
}

/** gh commands that never run a `<command> <word>` config alias (probed on gh 2.102). */
const NO_ALIAS_CHILD = new Set(
  'accessibility api browse completion credits licenses status version'.split(' '),
)

/**
 * The second-level commands that run a `<command> <sub> <word>` config alias, with their own
 * subcommands. `codespace ports` has subcommands too but runs, and takes no alias (probed).
 */
const NESTED_GROUPS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['repo autolink', new Set('create new delete list ls view'.split(' '))],
  ['repo deploy-key', new Set('add delete list ls'.split(' '))],
  ['repo gitignore', new Set('list ls view'.split(' '))],
  ['repo license', new Set('list ls view'.split(' '))],
])

/**
 * Where an alias may hang: the canonical path of the gh command it hangs under ('' for the top
 * level), the word that names it (undefined when the guard cannot resolve that word), and how
 * many command words reach it.
 */
export interface AliasSlot {
  parent: string
  word: string | undefined
  used: number
}

/**
 * The alias slot that command words reach, as gh 2.102 finds it: command aliases resolve to
 * their command, real subcommands are walked, and the first word that is not one names the alias.
 * Undefined when the words end on a gh command or reach one that takes no alias.
 */
export function ghAliasSlot(words: readonly (string | undefined)[]): AliasSlot | undefined {
  const [first, second, third] = words
  if (words.length === 0) return undefined
  if (first === undefined || !GH_BUILTINS.has(first)) return { parent: '', word: first, used: 1 }
  const top = COMMAND_ALIASES[first] ?? first
  if (NO_ALIAS_CHILD.has(top) || words.length < 2) return undefined
  if (second === undefined || !GH_SUBCOMMANDS.get(top)?.has(second))
    return { parent: top, word: second, used: 2 }
  const nested = NESTED_GROUPS.get(`${top} ${second}`)
  if (nested === undefined || words.length < 3 || (third !== undefined && nested.has(third))) return undefined
  return { parent: `${top} ${second}`, word: third, used: 3 }
}

const slotKey = (parent: string, word: string): string => (parent === '' ? word : `${parent} ${word}`)

/** A config key as gh registers it: split, walked to its slot, and kept only when one word is left. */
function canonicalKey(key: string): AliasSlot | undefined {
  const words = splitAlias(key)
  const slot = words === undefined ? undefined : ghAliasSlot(words)
  return slot?.word !== undefined && slot.used === words?.length ? slot : undefined
}

/** Every config alias gh may run at a slot; two keys can name one slot (`cs x`, `codespace x`). */
export function ghAliasesAt(aliases: ReadonlyMap<string, GhAlias>, parent: string, word: string): GhAlias[] {
  return [...aliases].flatMap(([key, alias]) => {
    const slot = canonicalKey(key)
    return slot?.word !== undefined && slotKey(slot.parent, slot.word) === slotKey(parent, word)
      ? [alias]
      : []
  })
}

/** Whether the config holds any alias under a command, for a word the guard cannot resolve. */
export const ghAliasesUnder = (aliases: ReadonlyMap<string, GhAlias>, parent: string): boolean =>
  [...aliases.keys()].some(key => canonicalKey(key)?.parent === parent)

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

// Any whitespace, separator, control or format character but an ASCII space or tab.
const EXOTIC_CHAR = /(?![ \t])[\s\p{Z}\p{Cc}\p{Cf}]/u

/**
 * A name the guard does not read as gh does. A shlex word with whitespace in it (`'pr x'`,
 * `pr\ x`) makes gh 2.102 run the alias in place of commands such as `gh pr view` and `gh api`.
 * Whitespace other than an ASCII space or tab, or a control or format character, may split
 * differently under gh's shlex than under the guard's, so it counts too, and so does `#`: gh's
 * shlex reads it as a comment, so key `zz #c` runs as alias `zz`.
 */
export const spacedAliasName = (name: string): boolean =>
  name.includes('#') || EXOTIC_CHAR.test(name) || splitAlias(name)?.some(word => /[ \t]/.test(word)) === true

/** gh keeps the first of two equal keys, so the guard reads the first too. */
function aliasesIn(map: YAMLMap): GhAliases {
  const aliases = new Map<string, GhAlias>()
  for (const pair of map.items) {
    const key = scalarKey(pair)
    const value = pair.value as Node | null
    if (key === undefined || !isScalar(value) || value.value === null || spacedAliasName(key))
      return UNREADABLE
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
export type GhAliasSet =
  { kind: 'body'; alias: GhAlias } | { kind: 'unread' } | { kind: 'hidden' } | { kind: 'spaced' }

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
  const [name, expansion] = positionals
  if (flags.get('help') === true || name === undefined || expansion === undefined) return undefined
  if (positionals.length !== 2) return undefined
  if (spacedAliasName(name)) return { kind: 'spaced' }
  if (expansion === '-') return { kind: 'unread' }
  const alias = toAlias(expansion)
  return { kind: 'body', alias: { ...alias, shell: flags.get('shell') === true || alias.shell } }
}

/** gh's canonical name for a top-level command word (`ext` is `extension`). */
export const ghCommand = (word: string | undefined): string | undefined =>
  word === undefined ? undefined : (COMMAND_ALIASES[word] ?? word)

/** Words a config alias may shadow that gh still runs itself when no alias does. */
const SHADOWABLE_BUILTINS = new Set(['help', '__complete', '__completeNoDesc'])

/**
 * Whether gh runs the word at an alias slot as an extension once no config alias names it: a
 * top-level word that is not a gh command runs `gh-<word>` from `gh extension list`.
 */
export const ghExtensionSlot = (slot: AliasSlot): boolean =>
  slot.parent === '' && (slot.word === undefined || !SHADOWABLE_BUILTINS.has(slot.word))

/**
 * The gh commands that hand the words after their first positional to `git clone`, by group:
 * `gh repo clone|fork <repo> [<dir>] [-- <gitflags>]` and `gh gist clone <gist> [<dir>] [-- <gitflags>]`
 * (gh 2.102 usage lines).
 */
export const GH_CLONES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['repo', new Set(['clone', 'fork'])],
  ['gist', new Set(['clone'])],
])

/** `gh repo clone|fork` flags that take the next word as their value; `gh gist clone` has none. */
const CLONE_VALUE_FLAGS = new Set(['-u', '--upstream-remote-name', '--remote-name', '--org', '--fork-name'])

/** What a `GH_CLONES` command hands `git clone`, and whether a word after its `--` is one the guard cannot resolve. */
export interface GhClone {
  git: number[]
  hidden: boolean
}

/**
 * The words a `GH_CLONES` command hands `git clone`, as positions in `rest` (every word after
 * `repo clone` or `gist clone`): each positional after the repository, and every word after `--`, in order. cobra
 * strips the first literal `--` wherever it sits. A word the guard cannot resolve may be `--`
 * itself, so every word after it counts too, and once the words may be past a real `--` (after
 * an unresolved word past the repository, or one positional after an unresolved repository) a
 * later unresolved word is hidden.
 */
export function ghCloneArgs(rest: readonly (string | undefined)[]): GhClone {
  const git: number[] = []
  let repo = false
  let dash = false
  let stripped = false
  let hidden = false
  let mayDash: 'no' | 'next' | 'yes' = 'no'
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]
    if (!stripped && word === '--') stripped = dash = true
    else if (dash || word === undefined || !word.startsWith('-')) {
      if (repo) git.push(i)
      hidden ||= word === undefined && (stripped || mayDash === 'yes')
      if (word === undefined) mayDash = repo ? 'yes' : 'next'
      else if (mayDash === 'next') mayDash = 'yes'
      repo = true
      dash ||= word === undefined
    } else if (CLONE_VALUE_FLAGS.has(word)) i++
  }
  return { git, hidden }
}

/**
 * The `gh auth` subcommands that may write `credential.helper = !'<gh path>' auth git-credential`
 * into git config: `setup-git` always, `login` and `refresh` when they set up git for https. gh
 * 2.102 takes the path from `GH_PATH` and only wraps it in single quotes, so a value holding `'`
 * persists any shell snippet (probed), and any other value names any program.
 */
const WRITES_CREDENTIAL_HELPER = new Set(['setup-git', 'login', 'refresh'])

/** The variable gh writes into git's credential helper (`gh help environment`). */
export const GH_PATH = 'GH_PATH'

/** Whether a gh command may persist `GH_PATH` as git's credential helper; an unresolved `auth` subcommand may. */
export const ghWritesCredentialHelper = (verb: string | undefined, sub: string | undefined, unsure: boolean): boolean =>
  verb === 'auth' && (unsure || (sub !== undefined && WRITES_CREDENTIAL_HELPER.has(sub)))

/** `gh help <word>` runs extension `<word>` with the other words when it is no gh command (probed on gh 2.102). */
export const ghHelpRunsExtension = (topic: string | undefined): boolean =>
  topic === undefined || !GH_BUILTINS.has(topic)
