import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { appendCall, type GhCallLine } from '../../gh-calls/log.js'
import { budgetPaths, recordHit, type Cooldowns, type Hit } from '../../gh-budget/state.js'
import { shimCallLine, type CallOutcome } from '../../gh-shim/call-log.js'
import { callShape } from '../../gh-shim/call-shape.js'
import { currentCooldowns, hitOf } from '../../gh-shim/rate-limit.js'
import { childEnv } from '../../exec.js'
import { shepherdTarget } from '../../shepherd-client.js'
import type { MergedPr } from './merged-pr.js'

/**
 * CC-1678: one PR's state for the broker's merged-PR retire. Async, since `burndown/exec.ts`'s runner
 * would block every session, and on the same budget: a cooling GraphQL lane refuses the read before
 * it reaches GitHub, each call gets a gh-calls line, and a rate-limited call starts a cooldown.
 */

const READ_TIMEOUT_MS = 15_000
const CALLER = 'retire-merged'

export interface PrState {
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  head: MergedPr
}

/** Rejects when the state cannot be told, which the sweep treats as a kept agent. */
export type PrStateReader = (pr: string) => Promise<PrState>

export interface PrStateDeps {
  cooldowns(): Promise<Cooldowns>
  gh(args: string[]): Promise<CallOutcome>
  log(line: GhCallLine): void
  hit(hit: Hit): Promise<void>
}

export function parsePrState(stdout: string, number: number): PrState {
  const { state, headRefOid } = JSON.parse(stdout) as { state?: unknown; headRefOid?: unknown }
  if ((state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED') || typeof headRefOid !== 'string')
    throw new Error('gh pr view answered without a known state and headRefOid')
  return { state, head: { number, headSha: headRefOid } }
}

export const prStateReader =
  (deps: PrStateDeps): PrStateReader =>
  async pr => {
    const target = shepherdTarget(pr)
    if (target === undefined) throw new Error(`${pr} is not a PR reference`)
    const args = ['pr', 'view', String(target.pr), '--repo', target.repo, '--json', 'state,headRefOid']
    const shape = callShape(args)
    if (shape === undefined) throw new Error('gh pr view has no call shape')
    if ((await deps.cooldowns())[shape.api] !== undefined) throw new Error(`gh ${shape.api} lane is cooling`)
    const outcome = await deps.gh(args)
    const line = shimCallLine(CALLER, shape, outcome)
    deps.log(line)
    const hit = hitOf(line)
    if (hit !== undefined) await deps.hit(hit)
    if (outcome.exitCode !== 0) throw new Error(`gh pr view ${pr} exited ${outcome.exitCode}`)
    return parsePrState(outcome.stdout, target.pr)
  }

async function runGh(args: string[]): Promise<CallOutcome> {
  const started = Date.now()
  const opts = { cwd: homedir(), env: childEnv(), encoding: 'utf8' as const, timeout: READ_TIMEOUT_MS }
  try {
    const { stdout, stderr } = await promisify(execFile)('gh', args, opts)
    return { exitCode: 0, stdout, stderr, ms: Date.now() - started }
  } catch (err) {
    const { code, stdout, stderr } = err as { code?: unknown; stdout?: string; stderr?: string }
    const exitCode = typeof code === 'number' ? code : -1
    return { exitCode, stdout: stdout ?? '', stderr: stderr ?? '', ms: Date.now() - started }
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** The broker's production reader; tests pass fake deps. */
export const readPrState: PrStateReader = prStateReader({
  cooldowns: () => currentCooldowns(process.env, Date.now()),
  gh: runGh,
  log: line => void appendCall(line),
  hit: hit => recordHit(budgetPaths(), hit, { now: Date.now, sleep }),
})
