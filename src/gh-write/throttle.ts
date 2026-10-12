import fs from 'node:fs'
import { withLock } from '../gh-budget/lock.js'
import { backoffDelay, classifyFailure, parseRetryAfter } from './policy.js'

export interface GhResult {
  code: number
  stdout: Buffer
  stderr: Buffer
}

export interface ThrottleDeps {
  now(): number
  sleep(ms: number): Promise<void>
  runGh(args: string[]): Promise<GhResult>
  /** Core REST quota left, or undefined when it could not be read. */
  coreRemaining(): Promise<number | undefined>
  /** When the shared GitHub cooldown for this write's lane ends, epoch ms; absent or past means none (CC-1162). */
  cooldownEnd?(args: string[]): Promise<number>
  notice(line: string): void
  lockDir: string
  stampPath: string
  gapMs: number
}

/**
 * Runs one gh write under the machine-wide lock, spaced from the previous one,
 * retrying the secondary rate limit. Returns the final attempt's result as gh gave it.
 */
export async function ghWrite(args: string[], deps: ThrottleDeps): Promise<GhResult> {
  for (let attempt = 0; ;) {
    const outcome = await withLock(deps, () => attemptWhenDue(args, attempt, deps))
    if (outcome.kind === 'wait') {
      if (outcome.cooldown)
        deps.notice(`gh-write: GitHub rate-limit cooldown; waiting ${Math.round(outcome.ms / 1000)}s`)
      await deps.sleep(outcome.ms)
      continue
    }
    if (outcome.retryInMs === undefined) return outcome.result
    attempt++
    deps.notice(
      `gh-write: GitHub secondary rate limit; retrying in ${Math.round(outcome.retryInMs / 1000)}s (retry ${attempt})`,
    )
  }
}

type Outcome =
  | { kind: 'wait'; ms: number; cooldown: boolean }
  | { kind: 'ran'; result: GhResult; retryInMs: number | undefined }

/**
 * Nothing sleeps under the lock: a writer that is not yet due releases it and waits outside.
 * A write is due once both the spacing stamp and the shared cooldown have passed.
 */
async function attemptWhenDue(args: string[], attempt: number, deps: ThrottleDeps): Promise<Outcome> {
  const cooldownEnd = (await deps.cooldownEnd?.(args)) ?? 0
  const notBefore = readNotBefore(deps.stampPath)
  const wait = Math.max(notBefore, cooldownEnd) - deps.now()
  if (wait > 0) return { kind: 'wait', ms: wait, cooldown: cooldownEnd > notBefore }
  const result = await deps.runGh(args)
  const retryInMs = await retryDelay(result, attempt, deps)
  writeNotBefore(deps.stampPath, deps.now() + Math.max(deps.gapMs, retryInMs ?? 0))
  return { kind: 'ran', result, retryInMs }
}

async function retryDelay(
  result: GhResult,
  attempt: number,
  deps: ThrottleDeps,
): Promise<number | undefined> {
  if (result.code === 0) return undefined
  const output = `${result.stdout.toString()}\n${result.stderr.toString()}`
  const kind = classifyFailure(output)
  if (kind === 'other') return undefined
  if (kind === 'ambiguous' && (await deps.coreRemaining()) === 0) return undefined
  return backoffDelay(attempt, parseRetryAfter(output))
}

function readNotBefore(stampPath: string): number {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(stampPath, 'utf8'))
    const value = (parsed as { notBefore?: unknown }).notBefore
    return typeof value === 'number' ? value : 0
  } catch {
    return 0
  }
}

function writeNotBefore(stampPath: string, notBefore: number): void {
  fs.writeFileSync(stampPath, JSON.stringify({ notBefore }))
}
