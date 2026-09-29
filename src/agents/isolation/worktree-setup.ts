import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { gitChildEnv } from '../../git.js'

/** Committed in the repository, so a worktree reads the declaration of the branch it holds. */
export const SETUP_FILE = path.join('.agent-chat', 'worktree.json')

/** Five minutes: a cold `npm ci` takes well under that, so only a hang reaches it. */
export const DEFAULT_SETUP_TIMEOUT_MS = 300_000
const MAX_SETUP_TIMEOUT_MS = 1_800_000
const TERM_GRACE_MS = 2_000
const OUTPUT_TAIL_CHARS = 4_000

export interface SetupStep {
  command: string[]
  timeoutMs: number
}

export interface SetupResult {
  /** Null when the process never started or was killed by a signal. */
  exitCode: number | null
  timedOut: boolean
  output: string
}

export type SetupRunner = (command: readonly string[], cwd: string, timeoutMs: number) => Promise<SetupResult>

const isCommand = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(part => typeof part === 'string' && part !== '')

const isTimeout = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_SETUP_TIMEOUT_MS

/** The declared step, null when none is declared, or the reason the declaration is unusable. */
export function readSetupStep(worktree: string): SetupStep | null | string {
  const file = path.join(worktree, SETUP_FILE)
  if (!existsSync(file)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return `${SETUP_FILE} is not valid JSON (${(err as Error).message})`
  }
  const setup = (parsed as { setup?: { command?: unknown; timeoutMs?: unknown } } | null)?.setup
  if (setup === undefined) return null
  if (!isCommand(setup.command)) return `${SETUP_FILE} setup.command must be a non-empty array of strings`
  if (setup.timeoutMs !== undefined && !isTimeout(setup.timeoutMs))
    return `${SETUP_FILE} setup.timeoutMs must be a positive integer of at most ${MAX_SETUP_TIMEOUT_MS}`
  return { command: setup.command, timeoutMs: setup.timeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS }
}

const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal)
  } catch {
    // The group is already gone.
  }
}

/** Its own process group, so a timeout also kills what the step spawned (npm runs scripts in children). */
export const runSetupCommand: SetupRunner = (command, cwd, timeoutMs) =>
  new Promise(resolve => {
    const [file, ...args] = command
    const child = spawn(file ?? '', args, {
      cwd,
      env: gitChildEnv(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let timedOut = false
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL_CHARS)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const term = setTimeout(() => {
      timedOut = true
      if (child.pid !== undefined) signalGroup(child.pid, 'SIGTERM')
    }, timeoutMs)
    const kill = setTimeout(
      () => child.pid !== undefined && signalGroup(child.pid, 'SIGKILL'),
      timeoutMs + TERM_GRACE_MS,
    )
    const settle = (exitCode: number | null, extra = ''): void => {
      clearTimeout(term)
      clearTimeout(kill)
      resolve({ exitCode, timedOut, output: output + extra })
    }
    child.on('error', err => settle(null, err.message))
    child.on('close', code => settle(code))
  })

const lastLine = (output: string): string => {
  const line = output.trim().split('\n').at(-1)?.trim() ?? ''
  return line.length > 200 ? `${line.slice(0, 200)}...` : line
}

function describeFailure(step: SetupStep, result: SetupResult): string {
  const name = step.command.join(' ')
  const how = result.timedOut
    ? `timed out after ${step.timeoutMs}ms and was killed`
    : `exited with ${result.exitCode === null ? 'no exit code' : `code ${result.exitCode}`}`
  const tail = lastLine(result.output)
  return `worktree setup step \`${name}\` ${how}${tail === '' ? '' : ` (${tail})`}; the worktree may be missing its dependencies`
}

/**
 * CC-313: run the repository's declared setup step in a fresh worktree, before the agent launches.
 *
 * Never throws: a failed step is a warning and the spawn proceeds, since whatever
 * depended on it (the egress pre-push hook) fails closed on its own.
 */
export async function runWorktreeSetup(
  worktree: string,
  run: SetupRunner = runSetupCommand,
): Promise<string[]> {
  const step = readSetupStep(worktree)
  if (step === null) return []
  if (typeof step === 'string') return [`worktree setup skipped: ${step}`]
  const result = await run(step.command, worktree, step.timeoutMs).catch((err: unknown): SetupResult => ({
    exitCode: null,
    timedOut: false,
    output: String(err),
  }))
  return result.exitCode === 0 && !result.timedOut ? [] : [describeFailure(step, result)]
}
