import { GIT_BUILTINS, GIT_VALUE_OPTS } from './git-alias.js'
import { CLONE_CONFIG, optionSpans } from './git-scripts.js'
import { LIVE, NAME, unmark } from './shell-words.js'

/**
 * A `-c` or `--config-env` the guard cannot read before a command that runs hooks (TP-630). A word
 * the shell expands in a way the guard cannot tell may hold `include.path` or `core.hooksPath`.
 */

/** Builtins that run a client hook, or that run others which do. The rest, such as `log`, run none. */
const HOOK_RUNNING = new Set(
  `am bisect checkout cherry-pick clone commit fetch gc hook maintenance merge pull push rebase
  receive-pack revert stash switch worktree`.split(/\s+/),
)
// A glob or brace word may expand to several words, one of them an option; a bare `$VAR` is one word.
const GLOBBED = new RegExp(`${LIVE}[*?[{(]`)
// What one word may expand to without becoming several: a plain scalar, a tilde, or a substitution inside quotes.
const SCALAR = new RegExp(
  `${LIVE}(?:\\$\\{${NAME}\\}|\\$${NAME}(?![A-Za-z0-9_]|${LIVE}?[:\\[])|\\$\\(|\`|~(?=/|$))`,
  'g',
)
const CONFIG_ENV_OPT = '--config-env='

/**
 * One `-c`, `--config` or `--config-env` value: its resolved word, its marked source, where LIVE
 * precedes what the shell expands, and the index of the word that holds it, if one does.
 */
export interface ConfigWord {
  resolved: string | undefined
  marked: string
  fromEnv: boolean
  index?: number
}

/** The part of a value that names the key: before the first `=` for `-c`, before the last for `--config-env`. */
export function keyOf(marked: string, fromEnv: boolean): string {
  const eq = fromEnv ? marked.lastIndexOf('=') : marked.indexOf('=')
  return eq < 0 ? marked : marked.slice(0, eq)
}

/** A `-c` key that is not literal, or a `--config-env` key or variable name that is not. */
export function unreadable({ resolved, marked, fromEnv }: ConfigWord): boolean {
  if (resolved !== undefined) return false
  if (!marked.includes('=') || keyOf(marked, fromEnv).includes(LIVE)) return true
  return fromEnv && marked.slice(marked.lastIndexOf('=') + 1).includes(LIVE)
}

/**
 * Whether the shell may turn the word into several, one of them an option. Only a literal, or a
 * double-quoted word whose expansions are plain scalars, is one word; anything else, such as `$@`,
 * `${a[@]}`, `${=v}`, a brace list, a glob or an unquoted expansion, may split.
 */
export const expandsToWords = (marked: string, splits: readonly string[]): boolean =>
  splits.includes(marked) || marked.replace(SCALAR, '').includes(LIVE)

/** A word that may expand to options, whatever else it holds. */
const UNKNOWN: ConfigWord = { resolved: undefined, marked: LIVE, fromEnv: false }

/** The value glued to an option at `i` after `cut` characters. */
const glued = (
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  i: number,
  cut: number,
  fromEnv: boolean,
): { word: ConfigWord; width: number } => ({
  word: { resolved: resolved[i]?.slice(cut), marked: (marked[i] as string).slice(cut), fromEnv, index: i },
  width: 1,
})

/** The `-c` or `--config-env` word at `i` in git's own options, attached to its option or in the word after it. */
function configWord(
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  i: number,
): { word: ConfigWord; width: number } | undefined {
  const raw = unmark(marked[i] as string)
  if (raw === '-c' || raw === '--config-env')
    return {
      word: {
        resolved: resolved[i + 1],
        marked: marked[i + 1] ?? '',
        fromEnv: raw === '--config-env',
        index: i + 1,
      },
      width: 2,
    }
  if (raw.startsWith(CONFIG_ENV_OPT)) return glued(resolved, marked, i, CONFIG_ENV_OPT.length, true)
  return /^-c./.test(raw) ? glued(resolved, marked, i, 2, false) : undefined
}

/**
 * The config words in git's options before the subcommand, and the index of the subcommand. Every
 * word up to the subcommand, and the value of an option that takes one, must be one word, or it is UNKNOWN.
 */
function scanOptions(
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  splits: readonly string[],
): { words: ConfigWord[]; at: number } {
  const words: ConfigWord[] = []
  const splittable = (at: number): boolean =>
    at < marked.length && expandsToWords(marked[at] as string, splits)
  let i = 0
  for (; i < marked.length; i++) {
    const raw = unmark(marked[i] as string)
    // A bare `$VAR` here is the subcommand, which the callers read; a glob or brace word may be options.
    if (!raw.startsWith('-')) {
      if (!GLOBBED.test(marked[i] as string)) break
      words.push(UNKNOWN)
      continue
    }
    if (splittable(i)) words.push(UNKNOWN)
    const config = configWord(resolved, marked, i)
    const takesValue = config?.width === 2 || GIT_VALUE_OPTS.has(raw)
    if (takesValue && splittable(i + 1)) words.push(UNKNOWN)
    if (config) words.push(config.word)
    if (takesValue) i++
  }
  return { words, at: i }
}

/** The marked text from the `offset`th visible character on, keeping the LIVE before a character the shell expands. */
function markedFrom(marked: string, offset: number): string {
  let seen = 0
  for (let k = 0; k < marked.length; k++) {
    const start = k
    if (marked[k] === LIVE) k++
    if (seen === offset) return marked.slice(start)
    seen++
  }
  return ''
}

/** An option word whose name part, before any `=`, the shell expands, such as `-q$X` or `--con"$Y"`. */
function optionNameLive(marked: string): boolean {
  if (!unmark(marked).startsWith('-')) return false
  const live = marked.indexOf(LIVE)
  const eq = marked.indexOf('=')
  return live >= 0 && (eq < 0 || live < eq)
}

/**
 * The config words `git clone` applies to the new repository before it fetches or checks out, so
 * a program they set runs in the same call (TP-636). They are read by git's parse-options rules,
 * the same reader as TP-634's script options: a short cluster such as `-qc <v>` or `-qc<v>`, and any
 * prefix of `--config`, as `--conf <v>` or `--conf=<v>`. A word that may hide one but cannot be read
 * exactly, because the shell may split it or expands its option name, is UNKNOWN.
 */
function cloneConfigWords(
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  splits: readonly string[],
  at: number,
): ConfigWord[] {
  if (resolved[at] !== 'clone') return []
  const plain = marked.map(unmark)
  const spans = optionSpans(plain, at, CLONE_CONFIG)
  const words: ConfigWord[] = spans.map(({ from, offset }) => ({
    resolved: resolved[from]?.slice(offset),
    marked: markedFrom(marked[from] as string, offset),
    fromEnv: false,
    index: from,
  }))
  const read = new Set(spans.map(span => span.from))
  for (let i = at + 1; i < marked.length && plain[i] !== '--'; i++) {
    const word = marked[i] as string
    if (!read.has(i) && (expandsToWords(word, splits) || optionNameLive(word))) words.push(UNKNOWN)
  }
  return words
}

/** Every config word this git invocation receives: git's own options, then those its subcommand applies. */
function invocationConfig(
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  splits: readonly string[],
): { words: ConfigWord[]; at: number } {
  const { words, at } = scanOptions(resolved, marked, splits)
  return { words: [...words, ...cloneConfigWords(resolved, marked, splits, at)], at }
}

/** Every `-c`, `--config` and `--config-env` word this git invocation receives. */
export const configWords = (
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  splits: readonly string[],
): ConfigWord[] => invocationConfig(resolved, marked, splits).words

/** Whether git's options hold a config word the guard cannot read, whatever the subcommand. */
export const hasUnreadableOption = (
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  splits: readonly string[],
): boolean => scanOptions(resolved, marked, splits).words.some(unreadable)

/** Whether git's options hold a config word the guard cannot read and the subcommand may run a hook. */
export function hasUnreadableConfig(
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  splits: readonly string[],
): boolean {
  const { words, at } = invocationConfig(resolved, marked, splits)
  // The words the shell splits may hide `-c` before the visible subcommand, so that one is not trusted.
  if (words.includes(UNKNOWN)) return true
  if (!words.some(unreadable)) return false
  const sub = resolved[at]
  return sub === undefined || HOOK_RUNNING.has(sub) || !GIT_BUILTINS.has(sub)
}

// zsh matches a group against names, so an alternative, the text glued before it or text glued after it may be an option.
const QUOTING_CHARS = /['"\\]/g
const OPTION_GROUP = /^-|[(|)]-|[(|)]\[[^\]]*-/
// A bracket class that holds `-`, as in `[-]-no-verify`, or an option-shaped word with a class in it, may spell an option.
const OPTION_CLASS = /^-*\[[^\]]*-|^-.*\[/

// A brace group the shell expands: a comma list, or a sequence `{x..y}` or `{x..y..step}` (CC-1427).
// bash's sequence is over integers or letters; zsh's is over integers or any single characters.
const INTEGER_SEQUENCE = /\{-?\d+\.\.-?\d+(?:\.\.-?\d+)?\}/
const CHAR_SEQUENCE = /\{([^{}])\.\.([^{}])(?:\.\.-?\d+)?\}/
const CHAR_SEQUENCES = new RegExp(CHAR_SEQUENCE.source, 'g')
const BRACE_LIST = /\{[^{}]*,[^{}]*\}/
// An alternative, or a negative integer sequence, that starts with `-`.
const OPTION_ALTERNATIVE = /[{,]-/
// git's `-<n>`, as in `git log -{1..3}`, is a count, never an option that skips a hook or runs a program.
const COUNT = /^-[\d{}.,]+$/

/** Whether a zsh character sequence in `text`, such as `{+../}`, yields `-`. */
const sequenceYieldsDash = (text: string): boolean =>
  [...text.matchAll(CHAR_SEQUENCES)].some(([, from = '', to = '']) =>
    from <= to ? from <= '-' && '-' <= to : to <= '-' && '-' <= from,
  )

// Nesting deeper than this is read as both empty and leading with `-`.
const MAX_GROUP_DEPTH = 64

/** The index of the `}` that closes the `{` at `open`, or -1. */
function closeOf(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return i
  }
  return -1
}

/** A comma group's alternatives, split at its top-level commas; one alternative when it has none. */
function topAlternatives(body: string): string[] {
  const alts: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') depth++
    else if (body[i] === '}') depth--
    else if (body[i] === ',' && depth === 0) {
      alts.push(body.slice(from, i))
      from = i + 1
    }
  }
  alts.push(body.slice(from))
  return alts
}

/** The leading comma group of `text`: its alternatives and the text after it. */
function leadingGroup(text: string): { alts: string[]; rest: string } | undefined {
  const close = text.startsWith('{') ? closeOf(text, 0) : -1
  const alts = close < 0 ? [] : topAlternatives(text.slice(1, close))
  return alts.length < 2 ? undefined : { alts, rest: text.slice(close + 1) }
}

/** Whether `text` may expand to an empty word: it is empty, or comma groups that each may be. */
function mayBeEmpty(text: string, depth: number): boolean {
  if (text === '' || depth > MAX_GROUP_DEPTH) return true
  const group = leadingGroup(text)
  return (
    group !== undefined && group.alts.some(alt => mayBeEmpty(alt, depth + 1)) && mayBeEmpty(group.rest, depth)
  )
}

/** Whether a word of `text`'s expansion may start with `-`, as `{,}--no-verify` and `{a,{,}}--no-verify` do. */
function mayLeadWithDash(text: string, depth = 0): boolean {
  if (text.startsWith('-') || depth > MAX_GROUP_DEPTH) return true
  const group = leadingGroup(text)
  if (group === undefined) return false
  const empty = group.alts.some(alt => mayBeEmpty(alt, depth + 1))
  return (
    group.alts.some(alt => mayLeadWithDash(alt, depth + 1)) ||
    (empty && mayLeadWithDash(group.rest, depth + 1))
  )
}

/** A brace expansion whose words may include an option, such as `--no-verif{y..y}` or `{main,--no-verify}`. */
function braceSpellsOption(text: string): boolean {
  if (![INTEGER_SEQUENCE, CHAR_SEQUENCE, BRACE_LIST].some(group => group.test(text))) return false
  if (text.startsWith('-')) return !COUNT.test(text)
  return OPTION_ALTERNATIVE.test(text) || sequenceYieldsDash(text) || mayLeadWithDash(text)
}

const spellsOption = (word: string): boolean => {
  const text = unmark(word).replace(QUOTING_CHARS, '')
  return (
    (word.includes(`${LIVE}(`) && OPTION_GROUP.test(text)) ||
    (word.includes(`${LIVE}[`) && OPTION_CLASS.test(text))
  )
}

const braceOption = (word: string): boolean =>
  word.includes(`${LIVE}{`) && braceSpellsOption(unmark(word).replace(QUOTING_CHARS, ''))

/**
 * Whether an argument after the subcommand may expand to an option through a glob group or bracket
 * class (CC-728), or, for `push`, whose options alone the guard denies, a brace expansion (CC-1427).
 */
export function hasOptionAlternation(
  marked: readonly string[],
  splits: readonly string[],
  resolved: readonly (string | undefined)[],
): boolean {
  const { at } = scanOptions(resolved, marked, splits)
  const sub = resolved[at]
  if (sub === undefined) return false
  const args = marked.slice(at + 1)
  return args.some(spellsOption) || (sub === 'push' && args.some(braceOption))
}

/** Whether git's options hold a word the shell may split into several, which quoting would fix. */
export const hasSplittableOption = (
  resolved: readonly (string | undefined)[],
  marked: readonly string[],
  splits: readonly string[],
): boolean => scanOptions(resolved, marked, splits).words.includes(UNKNOWN)
