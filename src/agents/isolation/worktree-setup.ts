import { execFile, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { gitChildEnv } from '../../git.js'

const execFileAsync = promisify(execFile)

/** A path inside a commit: the declaration is read from git, never from a working tree. */
export const SETUP_FILE = '.agent-chat/worktree.json'
/** Kept in the worktree's git dir, so it is neither tracked nor counted as dirt, and goes with the worktree. */
export const SETUP_LOG = 'agent-chat-setup.log'

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

export interface SetupTarget {
  gitRoot: string
  worktree: string
  /** The commit the branch base resolved to; the only place a declaration is read from. */
  baseSha: string
  /** False when that commit is a local HEAD rather than origin's default branch as fetched. */
  fetched: boolean
}

const SETUP_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'PNPM_HOME',
  'NODE_EXTRA_CA_CERTS',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
])
const SETUP_ENV_PREFIXES = ['LC_', 'npm_config_', 'NPM_CONFIG_', 'COREPACK_']

/** CC-324: a resumed tree holds the branch's package.json, whose lifecycle scripts must not run on the broker. */
const IGNORE_SCRIPTS_KEYS = ['npm_config_ignore_scripts', 'NPM_CONFIG_IGNORE_SCRIPTS'] as const

/** An allowlist of what an install needs: the step runs on the broker, outside any permission profile. */
export function setupEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' }
  for (const [key, value] of Object.entries(env)) {
    if (SETUP_ENV_KEYS.has(key) || SETUP_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) out[key] = value
  }
  for (const key of IGNORE_SCRIPTS_KEYS) out[key] = 'true'
  return out
}

const isCommand = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(part => typeof part === 'string' && part !== '')

const isTimeout = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_SETUP_TIMEOUT_MS

/** Keys it does not know are ignored, so a newer declaration still runs on an older broker. */
export function parseSetupStep(text: string): SetupStep | null | string {
  if (text.trim() === '') return `${SETUP_FILE} is empty`
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return `${SETUP_FILE} is not valid JSON (${(err as Error).message})`
  }
  const setup = (parsed as { setup?: unknown } | null)?.setup
  if (setup === undefined) return null
  if (typeof setup !== 'object' || setup === null) return `${SETUP_FILE} setup must be an object`
  const { command, timeoutMs } = setup as { command?: unknown; timeoutMs?: unknown }
  if (!isCommand(command)) return `${SETUP_FILE} setup.command must be a non-empty array of strings`
  if (timeoutMs !== undefined && !isTimeout(timeoutMs))
    return `${SETUP_FILE} setup.timeoutMs must be a positive integer of at most ${MAX_SETUP_TIMEOUT_MS}`
  return { command, timeoutMs: timeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS }
}

async function gitOutput(args: readonly string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [...args], { cwd, encoding: 'utf8', env: gitChildEnv() })
    return stdout
  } catch {
    return null
  }
}

/** The declaration as committed at `sha`, or null when that commit has none. */
const declarationAt = (gitRoot: string, sha: string): Promise<string | null> =>
  gitOutput(['cat-file', 'blob', `${sha}:${SETUP_FILE}`], gitRoot)

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
      env: setupEnv(),
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

/** The step's output can carry registry tokens, so it goes to an owner-only file and not into the spawn reply. */
async function writeSetupLog(worktree: string, output: string): Promise<string | null> {
  const gitDir = await gitOutput(['rev-parse', '--absolute-git-dir'], worktree)
  if (gitDir === null) return null
  const file = path.join(gitDir.trim(), SETUP_LOG)
  try {
    writeFileSync(file, output, { mode: 0o600 })
    return file
  } catch {
    return null
  }
}

function describeFailure(step: SetupStep, result: SetupResult, log: string | null): string {
  const name = step.command.join(' ')
  const how = result.timedOut
    ? `timed out after ${step.timeoutMs}ms and was killed`
    : `exited with ${result.exitCode === null ? 'no exit code' : `code ${result.exitCode}`}`
  const where = log === null ? '' : `; its output is in ${log}`
  return `worktree setup step \`${name}\` ${how}${where}; the worktree may be missing its dependencies`
}

/**
 * CC-313: run the repository's declared setup step in a fresh worktree, before the agent launches.
 *
 * The step runs on the broker, so its declaration comes only from origin's default
 * branch as fetched: a branch that edits the file changes nothing until it lands.
 *
 * Never throws: a failed step is a warning and the spawn proceeds, since whatever
 * depended on it (the egress pre-push hook) fails closed on its own.
 */
export async function runWorktreeSetup(
  target: SetupTarget,
  run: SetupRunner = runSetupCommand,
): Promise<string[]> {
  const declared = await declarationAt(target.gitRoot, target.baseSha)
  if (declared === null) return []
  if (!target.fetched)
    return [`worktree setup skipped: ${SETUP_FILE} is trusted only from origin's fetched default branch`]
  const step = parseSetupStep(declared)
  if (step === null) return []
  if (typeof step === 'string') return [`worktree setup skipped: ${step}`]
  const result = await run(step.command, target.worktree, step.timeoutMs).catch(
    (err: unknown): SetupResult => ({
      exitCode: null,
      timedOut: false,
      output: String(err),
    }),
  )
  if (result.exitCode === 0 && !result.timedOut) return []
  return [describeFailure(step, result, await writeSetupLog(target.worktree, result.output))]
}
