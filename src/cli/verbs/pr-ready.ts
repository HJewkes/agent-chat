import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface RunResult {
  code: number
  output: string
}

/** Runs one command with no shell. Injected so tests record every call and need no network. */
export type Run = (cmd: string, args: string[], cwd: string) => Promise<RunResult>

export interface PrReadyOptions {
  title?: string
  bodyFile?: string
  /** Commander sets this false for `--no-rebase`. */
  rebase?: boolean
}

export interface PrReadyDeps {
  run: Run
  cwd: string
  out: (line: string) => void
  err: (line: string) => void
}

interface StepOutcome {
  ok: boolean
  reason?: string
}

interface Command {
  cmd: string
  args: string[]
  hint?: string
}

export const CHECK_SCRIPTS = ['format:check', 'lint', 'typecheck', 'type-check']
const REMOTE_PREFIX = 'refs/remotes/origin/'

class StepError extends Error {}

const lastLine = (text: string): string =>
  text
    .trim()
    .split('\n')
    .filter(line => line.trim() !== '')
    .at(-1) ?? 'no output'

const commandText = (c: Command): string => [c.cmd, ...c.args].join(' ')

export async function cleanTreeStep(run: Run, cwd: string): Promise<StepOutcome> {
  const status = await run('git', ['status', '--porcelain'], cwd)
  if (status.code !== 0) return { ok: false, reason: `git status failed: ${lastLine(status.output)}` }
  const files = status.output
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => line.slice(3))
  if (files.length === 0) return { ok: true }
  return { ok: false, reason: `uncommitted changes in ${files.join(', ')}` }
}

/** The full ref, because a local branch named `origin/main` shadows the short name. */
export async function defaultBaseRef(run: Run, cwd: string): Promise<string> {
  const head = await run('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd)
  const ref = head.output.trim()
  if (head.code !== 0 || !ref.startsWith(REMOTE_PREFIX)) {
    throw new StepError('no origin/HEAD; run git remote set-head origin --auto')
  }
  return ref
}

export async function rebaseStep(run: Run, cwd: string, base: string): Promise<StepOutcome> {
  const branch = base.slice(REMOTE_PREFIX.length)
  const fetch = await run('git', ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:${base}`], cwd)
  if (fetch.code !== 0) return { ok: false, reason: `git fetch failed: ${lastLine(fetch.output)}` }
  const rebase = await run('git', ['rebase', base], cwd)
  if (rebase.code === 0) return { ok: true }
  const unmerged = await run('git', ['diff', '--name-only', '--diff-filter=U'], cwd)
  const files = unmerged.output.split('\n').filter(Boolean)
  await run('git', ['rebase', '--abort'], cwd)
  if (files.length === 0) return { ok: false, reason: `git rebase failed: ${lastLine(rebase.output)}` }
  return { ok: false, reason: `conflict in ${files.join(', ')}; rebase aborted` }
}

interface PackageJson {
  name?: string
  scripts?: Record<string, string>
}

function readPackage(dir: string): PackageJson | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as PackageJson
  } catch {
    return undefined
  }
}

const scriptsIn = (pkg: PackageJson | undefined): string[] =>
  CHECK_SCRIPTS.filter(script => pkg?.scripts?.[script] !== undefined)

export const packageManager = (cwd: string): 'pnpm' | 'npm' =>
  fs.existsSync(path.join(cwd, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm'

/** The nearest directory below the root holding a package.json, or undefined for a root file. */
export function nearestPackageDir(cwd: string, file: string): string | undefined {
  for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir)) {
    if (fs.existsSync(path.join(cwd, dir, 'package.json'))) return dir
  }
  return undefined
}

async function changedPackageDirs(run: Run, cwd: string, base: string): Promise<string[]> {
  const diff = await run('git', ['diff', '--name-only', `${base}...HEAD`], cwd)
  if (diff.code !== 0) throw new StepError(`git diff failed: ${lastLine(diff.output)}`)
  const dirs = diff.output
    .split('\n')
    .filter(Boolean)
    .map(file => nearestPackageDir(cwd, file))
    .filter((dir): dir is string => dir !== undefined)
  return [...new Set(dirs)].sort()
}

/** Per changed package, never a root fan-out such as `pnpm -r` or turbo. */
async function workspaceCommands(run: Run, cwd: string, base: string): Promise<Command[]> {
  const commands: Command[] = []
  for (const dir of await changedPackageDirs(run, cwd, base)) {
    const pkg = readPackage(path.join(cwd, dir))
    if (pkg?.name === undefined) continue
    const name = pkg.name
    commands.push(...scriptsIn(pkg).map(script => ({ cmd: 'pnpm', args: ['--filter', name, 'run', script] })))
  }
  if (readPackage(cwd)?.scripts?.['capabilities:check'] !== undefined) {
    commands.push({ cmd: 'pnpm', args: ['run', 'capabilities:check'], hint: 'run pnpm capabilities' })
  }
  return commands
}

export async function planChecks(run: Run, cwd: string, base: string): Promise<Command[]> {
  const pm = packageManager(cwd)
  const root = readPackage(cwd)
  if (root?.scripts?.['pr-ready'] !== undefined) return [{ cmd: pm, args: ['run', 'pr-ready'] }]
  if (fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml'))) return workspaceCommands(run, cwd, base)
  return scriptsIn(root).map(script => ({ cmd: pm, args: ['run', script] }))
}

export async function checksStep(
  run: Run,
  cwd: string,
  base: string,
  err: (line: string) => void,
): Promise<StepOutcome> {
  const commands = await planChecks(run, cwd, base)
  if (commands.length === 0) return { ok: true, reason: 'no scripts' }
  const failed: string[] = []
  for (const command of commands) {
    const result = await run(command.cmd, command.args, cwd)
    if (result.code === 0) continue
    err(result.output.trimEnd())
    failed.push(command.hint ? `${commandText(command)} (${command.hint})` : commandText(command))
  }
  return failed.length === 0 ? { ok: true } : { ok: false, reason: `failed: ${failed.join('; ')}` }
}

export async function changesetStep(run: Run, cwd: string, base: string): Promise<StepOutcome> {
  if (!fs.existsSync(path.join(cwd, '.changeset', 'config.json')))
    return { ok: true, reason: 'not configured' }
  const cmd = packageManager(cwd) === 'pnpm' ? 'pnpm' : 'npx'
  const result = await run(cmd, ['changeset', 'status', `--since=${base}`], cwd)
  if (result.code === 0) return { ok: true }
  return { ok: false, reason: lastLine(result.output) }
}

function reporter(out: (line: string) => void) {
  return (step: string, outcome: StepOutcome): boolean => {
    const suffix = outcome.reason ? `: ${outcome.reason}` : ''
    out(outcome.ok ? `ok ${step}${suffix}` : `FAIL ${step}${suffix}`)
    return outcome.ok
  }
}

async function guarded<T extends StepOutcome>(step: () => Promise<T>): Promise<T | StepOutcome> {
  try {
    return await step()
  } catch (error) {
    if (error instanceof StepError) return { ok: false, reason: error.message }
    throw error
  }
}

const resolveBase = (run: Run, cwd: string): Promise<StepOutcome & { base?: string }> =>
  guarded(async () => {
    const base = await defaultBaseRef(run, cwd)
    return { ok: true, reason: base, base }
  })

/**
 * Order: clean tree, base, rebase, checks, changeset. A dirty tree or a failed rebase stops the
 * run, since the checks would not see the tree that merges. Exit 0 only when every step passed.
 */
export async function prReady(opts: PrReadyOptions, deps: PrReadyDeps = defaultDeps()): Promise<number> {
  const { run, cwd } = deps
  const report = reporter(deps.out)
  const fail = (): number => (deps.out('PR-READY FAIL'), 1)
  if (!report('clean-tree', await cleanTreeStep(run, cwd))) return fail()
  const resolved = await resolveBase(run, cwd)
  if (!report('base', resolved) || resolved.base === undefined) return fail()
  const base = resolved.base
  const rebase =
    opts.rebase === false ? { ok: true, reason: 'skipped (--no-rebase)' } : await rebaseStep(run, cwd, base)
  if (!report('rebase', rebase)) return fail()
  let ok = report('checks', await guarded(() => checksStep(run, cwd, base, deps.err)))
  ok = report('changeset', await guarded(() => changesetStep(run, cwd, base))) && ok
  if (opts.title !== undefined || opts.bodyFile !== undefined)
    report('body', { ok: true, reason: 'scan lands with CC-687' })
  if (!ok) return fail()
  const head = await run('git', ['rev-parse', 'HEAD'], cwd)
  deps.out(`PR-READY OK ${head.output.trim()}`)
  return 0
}

export const spawnRun: Run = (cmd, args, cwd) =>
  new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', error => resolve({ code: 127, output: `${cmd}: ${error.message}` }))
    child.on('close', code => resolve({ code: code ?? 1, output: Buffer.concat(chunks).toString() }))
  })

const defaultDeps = (): PrReadyDeps => ({
  run: spawnRun,
  cwd: process.cwd(),
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
})
