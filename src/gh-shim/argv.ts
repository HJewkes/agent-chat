/**
 * Which `gh` invocations the shim answers itself; `undefined` means pass through to the real gh.
 *
 * Every parser here is a whitelist: an unknown flag, a second positional or a missing value
 * hands the whole command to the real gh, so the shim never guesses at a shape it was not built for.
 */

export type PrState = 'open' | 'closed' | 'merged' | 'all'

interface Output {
  repo?: string
  jq?: string
}

export type ShimRequest =
  | (Output & { kind: 'pr-view'; selector?: string; fields: string[] })
  | (Output & {
      kind: 'pr-list'
      fields: string[]
      state: PrState
      head?: string
      base?: string
      limit: number
    })
  | (Output & { kind: 'pr-checks'; selector?: string; fields?: string[] })
  | (Output & { kind: 'run-view'; runId: string; fields: string[] })
  | { kind: 'run-watch'; repo?: string; runId: string; exitStatus: boolean; intervalSec: number }

interface FlagSpec {
  values: Record<string, string>
  booleans?: Record<string, string>
}

interface ParsedFlags {
  values: Record<string, string>
  booleans: Set<string>
  positionals: string[]
}

const OUTPUT_FLAGS: Record<string, string> = {
  '--repo': 'repo',
  '-R': 'repo',
  '--json': 'json',
  '--jq': 'jq',
  '-q': 'jq',
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf('=')
  return arg.startsWith('--') && eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined]
}

/** Returns undefined on anything the spec does not name, which means pass through. */
export function parseFlags(args: readonly string[], spec: FlagSpec): ParsedFlags | undefined {
  const parsed: ParsedFlags = { values: {}, booleans: new Set(), positionals: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!arg.startsWith('-') || arg === '-') {
      parsed.positionals.push(arg)
      continue
    }
    const [flag, inline] = splitFlag(arg)
    const boolean = spec.booleans?.[flag]
    if (boolean !== undefined && inline === undefined) {
      parsed.booleans.add(boolean)
      continue
    }
    const name = spec.values[flag]
    const value = inline ?? args[++i]
    if (name === undefined || value === undefined || name in parsed.values) return undefined
    parsed.values[name] = value
  }
  return parsed
}

const fieldList = (json: string | undefined): string[] | undefined =>
  json
    ?.split(',')
    .map(field => field.trim())
    .filter(field => field !== '')

const output = (flags: ParsedFlags): Output => ({
  ...(flags.values.repo === undefined ? {} : { repo: flags.values.repo }),
  ...(flags.values.jq === undefined ? {} : { jq: flags.values.jq }),
})

function prView(args: readonly string[]): ShimRequest | undefined {
  const flags = parseFlags(args, { values: OUTPUT_FLAGS })
  const fields = fieldList(flags?.values.json)
  if (!flags || !fields?.length || flags.positionals.length > 1) return undefined
  const [selector] = flags.positionals
  return { kind: 'pr-view', ...output(flags), fields, ...(selector === undefined ? {} : { selector }) }
}

const PR_STATES = new Set<string>(['open', 'closed', 'merged', 'all'])

function prList(args: readonly string[]): ShimRequest | undefined {
  const values = { ...OUTPUT_FLAGS, '--state': 'state', '-s': 'state', '--head': 'head', '-H': 'head' }
  const flags = parseFlags(args, {
    values: { ...values, '--base': 'base', '-B': 'base', '--limit': 'limit', '-L': 'limit' },
  })
  const fields = fieldList(flags?.values.json)
  const state = flags?.values.state ?? 'open'
  const limit = Number(flags?.values.limit ?? '30')
  if (!flags || !fields?.length || flags.positionals.length > 0 || !PR_STATES.has(state)) return undefined
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return undefined
  const { head, base } = flags.values
  return {
    kind: 'pr-list',
    ...output(flags),
    fields,
    state: state as PrState,
    limit,
    ...(head === undefined ? {} : { head }),
    ...(base === undefined ? {} : { base }),
  }
}

function prChecks(args: readonly string[]): ShimRequest | undefined {
  const flags = parseFlags(args, { values: OUTPUT_FLAGS })
  if (!flags || flags.positionals.length > 1) return undefined
  if (flags.values.jq !== undefined && flags.values.json === undefined) return undefined
  const fields = fieldList(flags.values.json)
  const [selector] = flags.positionals
  return {
    kind: 'pr-checks',
    ...output(flags),
    ...(fields === undefined ? {} : { fields }),
    ...(selector === undefined ? {} : { selector }),
  }
}

function runView(args: readonly string[]): ShimRequest | undefined {
  const flags = parseFlags(args, { values: OUTPUT_FLAGS })
  const fields = fieldList(flags?.values.json)
  const [runId] = flags?.positionals ?? []
  if (!flags || !fields?.length || flags.positionals.length !== 1 || !/^\d+$/.test(runId ?? ''))
    return undefined
  return { kind: 'run-view', ...output(flags), runId: runId as string, fields }
}

function runWatch(args: readonly string[]): ShimRequest | undefined {
  const flags = parseFlags(args, {
    values: { '--repo': 'repo', '-R': 'repo', '--interval': 'interval', '-i': 'interval' },
    booleans: { '--exit-status': 'exit-status', '--compact': 'compact' },
  })
  const [runId] = flags?.positionals ?? []
  const intervalSec = Number(flags?.values.interval ?? '3')
  if (!flags || flags.positionals.length !== 1 || !/^\d+$/.test(runId ?? '')) return undefined
  if (!Number.isInteger(intervalSec) || intervalSec < 1) return undefined
  return {
    kind: 'run-watch',
    ...(flags.values.repo === undefined ? {} : { repo: flags.values.repo }),
    runId: runId as string,
    exitStatus: flags.booleans.has('exit-status'),
    intervalSec,
  }
}

const PARSERS: Record<string, (args: readonly string[]) => ShimRequest | undefined> = {
  'pr view': prView,
  'pr list': prList,
  'pr checks': prChecks,
  'run view': runView,
  'run watch': runWatch,
}

export function parseRequest(argv: readonly string[]): ShimRequest | undefined {
  const [group, verb, ...rest] = argv
  const parser = PARSERS[`${group} ${verb}`]
  return parser?.(rest)
}
