import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MISSING_TERMS_REFUSES, passwdHome, termsFileFor } from '../leak-guard/hooks-dir.js'
import {
  apiSources,
  findingsIn,
  ghKind,
  isMerge,
  loadTerms,
  longValue,
  prSources,
  readText,
  REASONS,
  shortValue,
  type TermsLoad,
} from '../leak-guard/pretool.js'

/**
 * gh-write's own leak scan (CC-501 S1). It runs the PreToolUse guard's rules on the argument list
 * gh will get, so a post is scanned even when the hook failed open. Each body file and stdin is read
 * once, and gh gets 0600 copies of exactly the text that was scanned, never the original path.
 * Nothing in the environment or the arguments turns it off.
 */

const DOCS = 'See docs/leak-guard.md.'

export const SCAN_REASONS = {
  unreadableSource: `leak-guard: gh-write could not read a body or input file as a regular file, so it neither checked nor posted it. ${DOCS}`,
  stdinTwice: `leak-guard: gh-write reads stdin once, so only one body or input may be -. ${DOCS}`,
  unknownCommand: `leak-guard: gh-write could not tell which text this gh command posts, so it did not run it. Spell gh's own group and verb out, with no empty word, alias or extension. ${DOCS}`,
  otherText: `leak-guard: this gh command carries a text flag (body, title, field, input, notes, comment or message) that gh-write does not scan for it. Post the text with pr or issue create, edit, comment, review or merge, or with gh api. ${DOCS}`,
  flagFirst: `leak-guard: gh-write needs gh's group and verb first; only -R/--repo may come before them. Put every other flag after the verb. ${DOCS}`,
  unscannedCreate: `leak-guard: --fill, --template and --recover make gh read text gh-write cannot scan. Pass --title and --body or --body-file instead. ${DOCS}`,
} as const

/** The guard's own deny for a finding: locations and rule ids, never the matched text. */
export const findingReason = (found: readonly string[]): string =>
  `leak-guard: this text would publish private data (${found.join('; ')}). Remove the flagged text and retry; the guard never prints what matched. ${DOCS}`

export interface ScanDeps {
  terms(): TermsLoad
  readFile(file: string): string | undefined
  readStdin(): Promise<string | undefined>
}

/** The text read from each file source, keyed by the argument gh would have read it from. */
export type Scan = { reason: string } | { files: ReadonlyMap<string, string> }

export interface Prepared {
  args: string[]
  cleanup(): void
}

/** Like the pre-push hook: the passwd home, so no variable can point the scan at another list. */
export const defaultTermsFile = (): string => termsFileFor(passwdHome())

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export const scanDeps = (termsFile: string): ScanDeps => ({
  terms: () => loadTerms(termsFile),
  readFile: readText,
  readStdin,
})

const NO_TEXT: Scan = { files: new Map() }

const REPO_FLAGS = new Set(['-R', '--repo'])

/** The words after any leading `-R <repo>`, or undefined when another flag comes first. */
function afterRepo(words: readonly string[]): readonly string[] | undefined {
  let i = 0
  for (let word = words[0]; word?.startsWith('-'); word = words[i]) {
    if (REPO_FLAGS.has(word)) i += 2
    else if (word.startsWith('--repo=') || /^-R./.test(word)) i += 1
    else return undefined
  }
  return words.slice(i)
}

/** gh 2.87's own groups and their cobra aliases; a config alias (`co`) or an extension is refused. */
const GH_GROUPS = new Set(
  (
    'agent-task alias api attestation auth browse cache codespace cs completion config copilot ' +
    'extension extensions ext gist gpg-key issue label licenses org pr preview project release repo ' +
    'ruleset rs run search secret ssh-key status variable workflow'
  ).split(' '),
)

const GROUP_VERBS: Readonly<Record<string, ReadonlySet<string>>> = {
  pr: new Set(
    (
      'checkout co checks close comment create new diff edit list ls lock merge ready reopen revert ' +
      'review status unlock update-branch view'
    ).split(' '),
  ),
  issue: new Set(
    (
      'close comment create new delete develop edit list ls lock pin reopen status transfer unlock ' +
      'unpin view'
    ).split(' '),
  ),
}

type Command = { words: readonly string[] } | { reason: string }

/**
 * The command as gh-write classifies it, with `-R` pairs before the group and verb removed. gh
 * accepts any flag there (`pr --body x comment 1`) and drops empty words (`pr '' comment`), which
 * the guard's classifier would read as another command. So every word up to the verb must be a
 * known group, a known verb or an `-R` pair.
 */
function commandOf(args: readonly string[]): Command {
  const rest = afterRepo(args)
  if (rest === undefined) return { reason: SCAN_REASONS.flagFirst }
  const [group = '', ...tail] = rest
  if (!GH_GROUPS.has(group)) return { reason: SCAN_REASONS.unknownCommand }
  const verbs = GROUP_VERBS[group]
  if (verbs === undefined)
    return tail[0]?.trim() === '' ? { reason: SCAN_REASONS.unknownCommand } : { words: rest }
  const verbOn = afterRepo(tail)
  if (verbOn === undefined) return { reason: SCAN_REASONS.flagFirst }
  return verbs.has(verbOn[0] ?? '') ? { words: [group, ...verbOn] } : { reason: SCAN_REASONS.unknownCommand }
}

const TEXT_LONG =
  /^--(?:body|body-file|field|raw-field|input|title|subject|notes|notes-file|comment|message)(?:=|$)/
const TEXT_SHORT = /^-[A-Za-z]*[bFftcm]/

/** Any spelling of a flag that may carry text, on a command whose text gh-write does not read. */
const carriesText = (args: readonly string[]): boolean =>
  args.some(word => TEXT_LONG.test(word) || TEXT_SHORT.test(word))

const CREATE_VERBS = new Set(['create', 'new'])
const UNSCANNED_LONG = /^--(?:fill|recover|template)(?:[-=]|$)/
/** `-f` is `--fill` on pr create and `-T` is `--template`, alone or in a cluster. */
const UNSCANNED_SHORT = /^-[A-Za-z]*[fT]/

const readsUnscanned = (command: readonly string[]): boolean =>
  CREATE_VERBS.has(command[1] ?? '') &&
  command.some(word => UNSCANNED_LONG.test(word) || UNSCANNED_SHORT.test(word))

export async function scanGhArgs(args: readonly string[], deps: ScanDeps): Promise<Scan> {
  const classified = commandOf(args)
  if ('reason' in classified) return classified
  const command = classified.words
  const kind = ghKind(command)
  if (kind === 'other') return carriesText(args) ? { reason: SCAN_REASONS.otherText } : NO_TEXT
  if (kind === 'unknown') return { reason: SCAN_REASONS.unknownCommand }
  if (kind === 'pr' && readsUnscanned(command)) return { reason: SCAN_REASONS.unscannedCreate }
  const sources = kind === 'api' ? apiSources(command) : prSources(command)
  if (sources.inline.length + sources.files.length === 0) return NO_TEXT
  const read = await readSources(
    sources.files.map(({ file }) => file),
    deps,
  )
  if ('reason' in read) return read
  const texts = [
    ...sources.inline,
    ...sources.files.map(({ label, file }) => ({ label, text: read.files.get(file) ?? '' })),
  ]
  const reason = verdict(command, deps.terms(), texts)
  return reason === undefined ? read : { reason }
}

const MERGE_VALUE_FLAGS = new Set(['-X', '--method', '--input', '-H', '--header', '-q', '--jq'])

/**
 * Stricter than the guard's `isMerge`: one endpoint word and no flag beyond a method, headers, a jq
 * filter and `--input`, so a cluster or a field cannot pass a second endpoint or text off as a merge.
 */
function plainMerge(command: readonly string[]): boolean {
  const positionals: string[] = []
  for (let i = 1; i < command.length; i++) {
    const word = command[i] as string
    if (MERGE_VALUE_FLAGS.has(word)) i++
    else if (word.startsWith('-')) return false
    else positionals.push(word)
  }
  return positionals.length === 1 && isMerge(command)
}

async function readSources(files: readonly string[], deps: ScanDeps): Promise<Scan> {
  if (files.filter(file => file === '-').length > 1) return { reason: SCAN_REASONS.stdinTwice }
  const read = new Map<string, string>()
  for (const file of new Set(files)) {
    const text = file === '-' ? await deps.readStdin() : deps.readFile(file)
    if (text === undefined) return { reason: SCAN_REASONS.unreadableSource }
    read.set(file, text)
  }
  return { files: read }
}

/** The guard's order: an unreadable list always refuses, a missing one unless the call is a plain merge. */
function verdict(
  command: readonly string[],
  terms: TermsLoad,
  texts: readonly { label: string; text: string }[],
): string | undefined {
  if (terms.kind === 'unreadable') return REASONS.unreadableTerms
  if (terms.kind === 'missing' && MISSING_TERMS_REFUSES && !plainMerge(command)) return REASONS.missingTerms
  const found = findingsIn(texts, terms.kind === 'ok' ? terms.rules : [])
  return found.length === 0 ? undefined : findingReason(found)
}

/**
 * Scans the arguments and swaps every file source for a copy of the scanned text. The swapped
 * arguments are scanned again with only those copies readable, so a spelling the swap missed
 * refuses instead of letting gh read a path that was not scanned.
 */
export async function prepareGhWrite(
  args: readonly string[],
  deps: ScanDeps,
): Promise<Prepared | { reason: string }> {
  const scan = await scanGhArgs(args, deps)
  if ('reason' in scan) return scan
  const { prepared, copies } = handOver(args, scan.files)
  const recheck = await scanGhArgs(prepared.args, {
    terms: deps.terms,
    readFile: file => copies.get(file),
    readStdin: () => Promise.resolve(undefined),
  })
  if (!('reason' in recheck)) return prepared
  prepared.cleanup()
  return recheck
}

function handOver(
  args: readonly string[],
  files: ReadonlyMap<string, string>,
): { prepared: Prepared; copies: ReadonlyMap<string, string> } {
  if (files.size === 0) return { prepared: { args: [...args], cleanup: () => undefined }, copies: new Map() }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-write-'))
  const cleanup = removeOnSignal(dir)
  try {
    const copyOf = new Map<string, string>()
    const copies = new Map<string, string>()
    for (const [file, text] of files) {
      const copy = path.join(dir, `source-${copyOf.size}`)
      fs.writeFileSync(copy, text, { mode: 0o600, flag: 'wx' })
      copyOf.set(file, copy)
      copies.set(copy, text)
    }
    return { prepared: { args: swapSources(args, copyOf), cleanup }, copies }
  } catch (err) {
    cleanup()
    throw err
  }
}

const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const

/**
 * The cleanup for a copy directory, also run when a signal ends the process, so a killed
 * gh-write leaves no copy behind. The signal is raised again once the handler is gone.
 */
function removeOnSignal(dir: string): () => void {
  const onSignal = (signal: NodeJS.Signals): void => {
    cleanup()
    process.kill(process.pid, signal)
  }
  const cleanup = (): void => {
    for (const signal of SIGNALS) process.off(signal, onSignal)
    fs.rmSync(dir, { recursive: true, force: true })
  }
  for (const signal of SIGNALS) process.once(signal, onSignal)
  return cleanup
}

type Swap = (value: string) => string

function swapSources(args: readonly string[], copyOf: ReadonlyMap<string, string>): string[] {
  const swapFile: Swap = file => copyOf.get(file) ?? file
  const swapField: Swap = field => {
    const at = field.indexOf('=') + 1
    const value = field.slice(at)
    return value.startsWith('@') ? `${field.slice(0, at)}@${swapFile(value.slice(1))}` : field
  }
  const out = [...args]
  const command = commandOf(args)
  if ('words' in command && ghKind(command.words) === 'api') {
    swapFlag(out, args, ['-F', '--field'], swapField)
    swapFlag(out, args, ['--input'], swapFile)
  } else swapFlag(out, args, ['--body-file', '-F'], swapFile)
  return out
}

/** Swaps each value of a flag in every spelling `flagValues` reads: `--f v`, `--f=v`, `-f v`, `-fv`, `-xf v`. */
function swapFlag(out: string[], args: readonly string[], names: readonly string[], swap: Swap): void {
  args.forEach((arg, i) => {
    for (const name of names) {
      const value = name.startsWith('--') ? longValue(arg, name) : shortValue(arg, name)
      if (value === undefined) continue
      if (value !== '') out[i] = arg.slice(0, arg.length - value.length) + swap(value)
      else if (i + 1 < args.length) out[i + 1] = swap(args[i + 1] as string)
    }
  })
}
