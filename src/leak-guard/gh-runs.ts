import path from 'node:path'
import { parse } from 'yaml'
import { fillPositionals, splitAlias } from './git-alias.js'

/**
 * gh aliases run what they expand to (TP-2371): a shell alias through `sh -c`, a plain one as
 * another gh command. The guard checks a body when `gh alias set` writes it, and again when
 * `gh <alias>` runs it, read from gh's `config.yml`. The read runs inside the PreToolUse hook, so
 * it never throws: a missing or malformed file reads as no alias.
 */

/**
 * The words gh runs as its own commands before any alias or extension: `gh help` on gh 2.102,
 * plus the hidden commands, help topics and command aliases it also accepts.
 */
export const GH_BUILTINS = new Set(
  `a11y accessibility actions agent agent-task agents alias api at attestation auth browse cache
  co codespace completion config copilot credits cs discussion environment exit-codes ext extension
  extensions formatting gist gpg-key help issue label licenses mintty org pr preview project
  reference release repo rs ruleset run search secret skill skills ssh-key status variable version
  workflow __complete __completeNoDesc`.split(/\s+/),
)

export interface GhAlias {
  /** The expansion runs through `sh -c` (it was set with `--shell` or starts with `!`). */
  shell: boolean
  /** The expansion without its leading `!`. */
  body: string
}

export type ReadGhAlias = (name: string) => GhAlias | undefined

type Env = Readonly<Record<string, string | undefined>>

/** Where gh keeps `config.yml`: `GH_CONFIG_DIR`, else `$XDG_CONFIG_HOME/gh`, else `~/.config/gh`. */
export function ghConfigDir(env: Env): string | undefined {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'gh')
  return env.HOME ? path.join(env.HOME, '.config', 'gh') : undefined
}

const toAlias = (value: string): GhAlias =>
  value.startsWith('!') ? { shell: true, body: value.slice(1) } : { shell: false, body: value }

function readAliases(env: Env, read: (file: string) => string | undefined): Record<string, unknown> {
  const dir = ghConfigDir(env)
  const text = dir === undefined ? undefined : read(path.join(dir, 'config.yml'))
  if (text === undefined) return {}
  try {
    const aliases = (parse(text) as { aliases?: unknown } | null)?.aliases
    return typeof aliases === 'object' && aliases !== null ? (aliases as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Reads gh's aliases once, from the config the hook's own environment points gh at. */
export function ghAliasReader(env: Env, read: (file: string) => string | undefined): ReadGhAlias {
  let aliases: Record<string, unknown> | undefined
  return name => {
    aliases ??= readAliases(env, read)
    const value = Object.hasOwn(aliases, name) ? aliases[name] : undefined
    return typeof value === 'string' ? toAlias(value) : undefined
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

/**
 * What a `gh alias` call defines: a body to check, `unread` for an import or a `-` expansion read
 * from stdin, `hidden` for a word the guard cannot resolve, undefined when it defines nothing.
 */
export type GhAliasSet = { kind: 'body'; alias: GhAlias } | { kind: 'unread' } | { kind: 'hidden' }

export function ghAliasSet(args: readonly (string | undefined)[]): GhAliasSet | undefined {
  if (args[0] !== 'alias') return undefined
  if (args[1] === 'import') return { kind: 'unread' }
  if (args[1] !== 'set') return args[1] === undefined && args.length > 1 ? { kind: 'hidden' } : undefined
  let shell = false
  let flags = true
  const positionals: string[] = []
  for (const arg of args.slice(2)) {
    if (arg === undefined) return { kind: 'hidden' }
    if (flags && arg === '--') flags = false
    else if (flags && (arg === '-s' || arg === '--shell')) shell = true
    else if (flags && arg.startsWith('--shell=')) shell = arg !== '--shell=false'
    else if (flags && /^--?h(?:elp)?$/.test(arg)) return undefined
    else if (flags && arg.length > 1 && arg.startsWith('-') && !arg.startsWith('--clobber')) return undefined
    else if (!(flags && arg.startsWith('--clobber'))) positionals.push(arg)
  }
  const [, expansion] = positionals
  if (positionals.length !== 2 || expansion === undefined) return undefined
  if (expansion === '-') return { kind: 'unread' }
  const alias = toAlias(expansion)
  return { kind: 'body', alias: { ...alias, shell: shell || alias.shell } }
}
