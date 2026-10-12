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

/** Builds a spec from words such as `x:[no-]file=`, `[no-]global` or `get`. */
export function optionSpec(text: string): OptionSpec {
  return text
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

/** The options a call sets, by full name (`no-` for a negated one), and its other words in order. */
export interface ParsedArgs {
  options: string[]
  positionals: (string | undefined)[]
}

/** Whether word `i` is an option, read from what was written when the guard cannot resolve it. */
export const isOption = (args: SubArgs, i: number): boolean =>
  (args.resolved[i] ?? args.written[i] ?? '').startsWith('-')

// A long option's name as written, before any `=value`; only literal names are read.
const LITERAL_LONG = /^--([a-z0-9-]*)(=|$)/

/** Reads one `--name[=value]` word; returns how many words it took, or undefined when it cannot. */
function readLong(text: string, spec: OptionSpec, out: string[]): number | undefined {
  const match = LITERAL_LONG.exec(text)
  const found = match && longOption(match[1] as string, spec)
  if (!match || !found) return undefined
  out.push(found.negated ? `no-${found.option.name}` : found.option.name)
  return found.option.value && !found.negated && match[2] === '' ? 2 : 1
}

/** Reads one `-abc` cluster; a short option that takes a value takes the rest of the word or the next one. */
function readShort(text: string, spec: OptionSpec, out: string[]): number | undefined {
  for (let j = 1; j < text.length; j++) {
    const option = spec.find(o => o.short === text[j])
    if (option === undefined) return undefined
    out.push(option.name)
    if (option.value) return j === text.length - 1 ? 2 : 1
  }
  return 1
}

/**
 * A call's options and positionals, or undefined when one option is unknown, ambiguous or unreadable.
 * `--` ends the options unless `dashDashEnds` is false: legacy `git config` reads options after it.
 */
export function parseOptions(args: SubArgs, spec: OptionSpec, dashDashEnds = true): ParsedArgs | undefined {
  const parsed: ParsedArgs = { options: [], positionals: [] }
  let ended = false
  for (let i = 0; i < args.resolved.length;) {
    const word = args.resolved[i]
    if (ended || !isOption(args, i)) {
      parsed.positionals.push(word)
      i++
      continue
    }
    const text = word ?? args.written[i] ?? ''
    if (text === '--') {
      ended = dashDashEnds
      i++
      continue
    }
    const taken = text.startsWith('--')
      ? readLong(text, spec, parsed.options)
      : readShort(text, spec, parsed.options)
    if (taken === undefined) return undefined
    i += taken
  }
  return parsed
}
