/**
 * Reads a git builtin's options the way git's parse-options does (TP-2371): a long option may be
 * written as any unique prefix of its name or of its `--no-` form, with its value attached by `=`
 * or in the next word, and short options cluster (`-zf file`). A spelling the guard cannot match to
 * exactly one option, or cannot read, makes the whole call unreadable rather than being guessed at.
 */

/** One option, in git's `-h` notation: `[no-]name` has a `--no-` form, `name=` takes a value, `x:name` adds a short `-x`. */
interface Option {
  name: string
  value: boolean
  short: string | undefined
  negatable: boolean
}

export type OptionSpec = readonly Option[]

/** Builds a spec from words such as `x:[no-]file=`, `[no-]global` or `get`; every builtin also takes `-h` and `--help`. */
export function optionSpec(text: string): OptionSpec {
  return `${text} h:help`
    .split(/\s+/)
    .filter(Boolean)
    .map(word => {
      const short = /^(.):/.exec(word)?.[1]
      const long = short === undefined ? word : word.slice(2)
      const negatable = long.startsWith('[no-]')
      const bare = negatable ? long.slice('[no-]'.length) : long
      const value = bare.endsWith('=')
      return { name: value ? bare.slice(0, -1) : bare, value, short, negatable }
    })
}

interface Spelling {
  text: string
  option: Option
  negated: boolean
}

const spellings = (spec: OptionSpec): Spelling[] =>
  spec.flatMap(option => [
    { text: option.name, option, negated: false },
    ...(option.negatable ? [{ text: `no-${option.name}`, option, negated: true }] : []),
  ])

/** The option `--typed` names: an exact spelling, else the one spelling it is a prefix of; undefined for none or several. */
function longOption(typed: string, spec: OptionSpec): Spelling | undefined {
  const all = spellings(spec)
  const exact = all.find(s => s.text === typed)
  if (exact !== undefined) return exact
  const matches = all.filter(s => s.text.startsWith(typed))
  return typed !== '' && matches.length === 1 ? matches[0] : undefined
}

/** A command's words after its verb or subcommand: as the shell passes them, and as written. */
export interface SubArgs {
  resolved: readonly (string | undefined)[]
  written: readonly string[]
}

/**
 * An option's final state, the last spelling winning as in git: true or false for a flag (`--no-x`
 * after `--x` leaves it false), its value for one that takes a value, undefined for a value the
 * guard cannot read, false after its `--no-` form.
 */
export type OptionValue = boolean | string | undefined

/** The final state of each option a call names, its other words in order, and how many came before an ending `--`. */
export interface ParsedArgs {
  options: Map<string, OptionValue>
  positionals: (string | undefined)[]
  beforeDashDash: number
}

/** Whether an option ends set: given, not cancelled by a later `--no-` form. */
export const isSet = (parsed: ParsedArgs, name: string): boolean => {
  const value = parsed.options.get(name)
  return parsed.options.has(name) && value !== false
}

/** Whether word `i` is an option, read from what was written when the guard cannot resolve it. */
export const isOption = (args: SubArgs, i: number): boolean =>
  (args.resolved[i] ?? args.written[i] ?? '').startsWith('-')

// A long option's name as written, before any `=value`; only literal names are read.
const LITERAL_LONG = /^--([a-z0-9-]*)(=|$)/

/** One option word where the parser stands: its text, whether the shell's value is known, and the next word. */
interface At {
  text: string
  readable: boolean
  next: string | undefined
}

/** Reads one `--name[=value]` word into `out`; returns how many words it took, or undefined when it cannot. */
function readLong(at: At, spec: OptionSpec, out: Map<string, OptionValue>): number | undefined {
  const match = LITERAL_LONG.exec(at.text)
  const found = match && longOption(match[1] as string, spec)
  if (!match || !found) return undefined
  const { option, negated } = found
  const attached = match[2] === '='
  if (negated || !option.value) {
    out.set(option.name, !negated)
    return 1
  }
  out.set(option.name, attached ? (at.readable ? at.text.slice(match[0].length) : undefined) : at.next)
  return attached ? 1 : 2
}

/** Reads one `-abc` cluster into `out`; a short option that takes a value takes the rest of the word or the next one. */
function readShort(at: At, spec: OptionSpec, out: Map<string, OptionValue>): number | undefined {
  const { text } = at
  for (let j = 1; j < text.length; j++) {
    const option = spec.find(o => o.short === text[j])
    if (option === undefined) return undefined
    if (!option.value) {
      out.set(option.name, true)
      continue
    }
    const rest = j < text.length - 1
    out.set(option.name, rest ? (at.readable ? text.slice(j + 1) : undefined) : at.next)
    return rest ? 1 : 2
  }
  return 1
}

/**
 * Where a command stops reading options. Most git commands read them anywhere and stop at `--`.
 * Legacy `git config`, with no subcommand, stops at its first positional word, so a later `--get`
 * is a value pattern, not a mode, and it reads options past a leading `--`.
 */
export interface OptionsEnd {
  atDashDash: boolean
  atPositional: boolean
}

const ANYWHERE: OptionsEnd = { atDashDash: true, atPositional: false }

/** A call's options and positionals, or undefined when one option is unknown, ambiguous or unreadable. */
export function parseOptions(
  args: SubArgs,
  spec: OptionSpec,
  end: OptionsEnd = ANYWHERE,
): ParsedArgs | undefined {
  const parsed: ParsedArgs = { options: new Map(), positionals: [], beforeDashDash: Infinity }
  let ended = false
  for (let i = 0; i < args.resolved.length;) {
    const word = args.resolved[i]
    if (ended || !isOption(args, i)) {
      parsed.positionals.push(word)
      ended ||= end.atPositional
      i++
      continue
    }
    const text = word ?? args.written[i] ?? ''
    if (text === '--') {
      ended = end.atDashDash
      if (ended) parsed.beforeDashDash = parsed.positionals.length
      i++
      continue
    }
    const at = { text, readable: word !== undefined, next: args.resolved[i + 1] }
    const taken = text.startsWith('--')
      ? readLong(at, spec, parsed.options)
      : readShort(at, spec, parsed.options)
    if (taken === undefined) return undefined
    i += taken
  }
  parsed.beforeDashDash = Math.min(parsed.beforeDashDash, parsed.positionals.length)
  return parsed
}
