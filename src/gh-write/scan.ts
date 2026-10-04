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
  unknownCommand: `leak-guard: gh-write could not tell which text this gh command posts, so it did not run it. ${DOCS}`,
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

export async function scanGhArgs(args: readonly string[], deps: ScanDeps): Promise<Scan> {
  const kind = ghKind(args)
  if (kind === 'other') return NO_TEXT
  if (kind === 'unknown') return { reason: SCAN_REASONS.unknownCommand }
  const sources = kind === 'api' ? apiSources(args) : prSources(args)
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
  const reason = verdict(args, deps.terms(), texts)
  return reason === undefined ? read : { reason }
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

/** The guard's order: an unreadable list always refuses, a missing one unless the call is a merge. */
function verdict(
  args: readonly string[],
  terms: TermsLoad,
  texts: readonly { label: string; text: string }[],
): string | undefined {
  if (terms.kind === 'unreadable') return REASONS.unreadableTerms
  if (terms.kind === 'missing' && MISSING_TERMS_REFUSES && !isMerge(args)) return REASONS.missingTerms
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
  const cleanup = (): void => fs.rmSync(dir, { recursive: true, force: true })
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

type Swap = (value: string) => string

function swapSources(args: readonly string[], copyOf: ReadonlyMap<string, string>): string[] {
  const swapFile: Swap = file => copyOf.get(file) ?? file
  const swapField: Swap = field => {
    const at = field.indexOf('=') + 1
    const value = field.slice(at)
    return value.startsWith('@') ? `${field.slice(0, at)}@${swapFile(value.slice(1))}` : field
  }
  const out = [...args]
  if (ghKind(args) === 'api') {
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
