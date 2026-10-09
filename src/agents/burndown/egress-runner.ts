import { spawnSync } from 'node:child_process'
import {
  defaultScanInputs,
  probeScanner,
  termsFileFor,
  type ScannerFacts,
} from '../../leak-guard/hooks-dir.js'

/**
 * The tick's handle on `titan-egress-scan`, the scanner and private term list the pre-push hook
 * uses (CC-265). It runs with an environment of PATH, HOME and the term list alone, and requires
 * the list, so a missing one is an outcome rather than a scan with generic rules only.
 */

/** A finding's location (`1:5`, or `<sha> <file>:<line>`) and rule id; the scanner never returns text. */
export interface EgressFinding {
  location: string
  rule: string
}

export type ScannerState = 'ok' | 'no-scanner' | 'no-terms' | 'error'

export type EgressOutcome =
  { state: 'ok'; findings: EgressFinding[] } | { state: Exclude<ScannerState, 'ok'>; detail?: string }

export interface EgressRunner {
  text(input: string): EgressOutcome
  /** Every commit in `base..head`, read in the checkout at `cwd`. */
  range(cwd: string, base: string, head: string): EgressOutcome
}

export interface EgressInputs {
  /** Absolute PATH entries the scanner and node are looked up on. */
  path: string
  /** The owner's passwd home; the term list's path derives from it. */
  home: string
  termsFile?: string
  probe?: (searchPath: string) => ScannerFacts | undefined
}

const TIMEOUT_MS = 60_000
const MISSING_TERMS = 'private term list'
const SUMMARY = ['egress-scan:', 'allowed:', 'binary files skipped:', 'private term list:']
const FINDING = /^(.+) ([a-z][a-z0-9-]*)(?: #\d+)?$/

/** Finding rows of a report; an exit-1 report with none is unreadable, never clean. */
function parseFindings(stdout: string): EgressFinding[] {
  return stdout
    .split('\n')
    .filter(line => line.trim() !== '' && !SUMMARY.some(prefix => line.startsWith(prefix)))
    .flatMap(line => {
      const m = FINDING.exec(line)
      return m === null ? [] : [{ location: m[1] ?? '', rule: m[2] ?? '' }]
    })
}

function outcomeOf(run: ReturnType<typeof spawnSync>): EgressOutcome {
  const stdout = String(run.stdout ?? '')
  const stderr = String(run.stderr ?? '')
  const detail = stderr.split('\n').find(line => line.trim() !== '')
  if (run.error !== undefined || run.signal !== null) return { state: 'error', detail: 'timed out or killed' }
  if (run.status === 0) return { state: 'ok', findings: [] }
  if (run.status === 1) {
    const findings = parseFindings(stdout)
    return findings.length > 0 ? { state: 'ok', findings } : { state: 'error', detail: 'unreadable report' }
  }
  if (stderr.includes(MISSING_TERMS))
    return { state: 'no-terms', ...(detail === undefined ? {} : { detail }) }
  return { state: 'error', detail: detail ?? `exit ${run.status ?? 'none'}` }
}

/** Probes the scanner once, so a tick that finds none reports `no-scanner` on every call. */
export function egressRunner(inputs: EgressInputs = defaultEgressInputs()): EgressRunner {
  const facts = (inputs.probe ?? probeScanner)(inputs.path)
  const env = {
    PATH: inputs.path,
    HOME: inputs.home,
    TITAN_EGRESS_TERMS: inputs.termsFile ?? termsFileFor(inputs.home),
    TITAN_EGRESS_REQUIRE_TERMS: '1',
  }
  const scan = (args: string[], cwd?: string, input?: string): EgressOutcome => {
    if (facts === undefined) return { state: 'no-scanner' }
    const run = spawnSync(facts.node, [facts.scanner, ...args], {
      env,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
      ...(cwd === undefined ? {} : { cwd }),
      ...(input === undefined ? {} : { input }),
    })
    return outcomeOf(run)
  }
  return {
    text: input => scan(['text'], undefined, input),
    range: (cwd, base, head) => scan(['range', base, head], cwd),
  }
}

const defaultEgressInputs = (): EgressInputs => {
  const { home, path } = defaultScanInputs()
  return { home, path }
}
