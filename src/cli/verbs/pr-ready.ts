import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { defaultTermsFile, scanDeps, scanGhArgs } from '../../gh-write/scan.js'
import {
  basementCommandText,
  describeExit,
  infraFailure,
  routeChecks,
  runOnBasement,
  type BasementTarget,
} from './pr-ready-basement.js'
import { pushedBranchStep } from './pr-ready-pushed.js'

export interface RunResult {
  code: number
  output: string
}

/** Runs one command with no shell. Injected so tests record every call and need no network. */
export type Run = (cmd: string, args: string[], cwd: string) => Promise<RunResult>

/** Calls `onSignal` on SIGINT or SIGTERM; returns the function that removes the handlers. */
export type Trap = (onSignal: () => void) => () => void

export interface PrReadyOptions {
  title?: string
  bodyFile?: string
  /** Commander sets this false for `--no-rebase`. */
  rebase?: boolean
  /** Fail, rather than note, a pushed branch that is behind the default branch. */
  strict?: boolean
}

export interface PrReadyDeps {
  run: Run
  cwd: string
  out: (line: string) => void
  err: (line: string) => void
  trap: Trap
  /** The private-term list gh-write reads; injected so tests use a synthetic one. */
  termsFile: string
  /** Read for AGENT_CHAT_BASEMENT_HOST and AGENT_CHAT_NAME; injected so tests never see the real one. */
  env?: NodeJS.ProcessEnv
  /** Compared with the basement host to call basement-suite directly there; injected for tests. */
  hostname?: string
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

interface CheckPlan {
  commands: Command[]
  /** Changed files the plan cannot check, each a reason the step fails. */
  problems: string[]
}

export const CHECK_SCRIPTS = ['format:check', 'lint', 'typecheck', 'type-check']
const REMOTE_PREFIX = 'refs/remotes/origin/'
const REBASE_DIRS = ['rebase-merge', 'rebase-apply']

const lastLine = (text: string): string =>
  text
    .trim()
    .split('\n')
    .filter(line => line.trim() !== '')
    .at(-1) ?? 'no output'

const commandText = (c: Command): string => [c.cmd, ...c.args].join(' ')

/** `-z` output, so a non-ASCII path arrives as itself rather than quoted and escaped. */
const nulSeparated = (output: string): string[] => output.split('\0').filter(Boolean)

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
    throw new Error('no origin/HEAD; run git remote set-head origin --auto')
  }
  return ref
}

const rebaseInProgress = (gitDir: string): boolean =>
  REBASE_DIRS.some(dir => fs.existsSync(path.join(gitDir, dir)))

/** Synchronous, for a signal handler. True when no rebase is left in progress. */
export function abortRebaseSync(cwd: string, gitDir: string): boolean {
  if (!rebaseInProgress(gitDir)) return true
  try {
    execFileSync('git', ['rebase', '--abort'], { cwd, stdio: 'ignore' })
  } catch {
    // The state check below reports the outcome.
  }
  return !rebaseInProgress(gitDir)
}

async function abortRebase(run: Run, cwd: string, gitDir: string): Promise<string> {
  const abort = await run('git', ['rebase', '--abort'], cwd)
  if (abort.code === 0 && !rebaseInProgress(gitDir)) return 'rebase aborted'
  return `git rebase --abort failed (${lastLine(abort.output)}); a rebase is still in progress, abort it by hand`
}

export async function rebaseStep(run: Run, cwd: string, base: string, gitDir: string): Promise<StepOutcome> {
  const branch = base.slice(REMOTE_PREFIX.length)
  const fetch = await run('git', ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:${base}`], cwd)
  if (fetch.code !== 0) return { ok: false, reason: `git fetch failed: ${lastLine(fetch.output)}` }
  const rebase = await run('git', ['rebase', base], cwd)
  if (rebase.code === 0) return { ok: true }
  if (!rebaseInProgress(gitDir)) return { ok: false, reason: `git rebase failed: ${lastLine(rebase.output)}` }
  const unmerged = await run('git', ['diff', '-z', '--name-only', '--diff-filter=U'], cwd)
  const files = nulSeparated(unmerged.output)
  const state = await abortRebase(run, cwd, gitDir)
  if (files.length === 0)
    return { ok: false, reason: `git rebase failed: ${lastLine(rebase.output)}; ${state}` }
  return { ok: false, reason: `conflict in ${files.join(', ')}; ${state}` }
}

async function gitDirOf(run: Run, cwd: string): Promise<string> {
  const result = await run('git', ['rev-parse', '--absolute-git-dir'], cwd)
  if (result.code !== 0) throw new Error(`git rev-parse failed: ${lastLine(result.output)}`)
  return result.output.trim()
}

/** A SIGINT or SIGTERM mid-rebase aborts the rebase before the process exits. */
async function trappedRebaseStep(deps: PrReadyDeps, base: string): Promise<StepOutcome> {
  const gitDir = await gitDirOf(deps.run, deps.cwd)
  const release = deps.trap(() => {
    const state = abortRebaseSync(deps.cwd, gitDir)
      ? 'rebase aborted'
      : 'a rebase is still in progress, abort it by hand'
    deps.out(`FAIL rebase: interrupted; ${state}`)
    deps.out('PR-READY FAIL')
  })
  try {
    return await rebaseStep(deps.run, deps.cwd, base, gitDir)
  } finally {
    release()
  }
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

const escapeRegExp = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

/** The glob forms pnpm workspaces use: `*` within one segment, `**` across segments. */
export function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .split('/')
    .map(segment => (segment === '**' ? '.*' : segment.split('*').map(escapeRegExp).join('[^/]*')))
    .join('/')
  return new RegExp(`^${body}$`)
}

/** Whether a repo-relative directory is a workspace member under `pnpm-workspace.yaml`. */
export function workspaceMembership(cwd: string): (dir: string) => boolean {
  const doc = YAML.parse(fs.readFileSync(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8')) as {
    packages?: string[]
  } | null
  const globs = doc?.packages ?? []
  const include = globs.filter(g => !g.startsWith('!')).map(globToRegExp)
  const exclude = globs.filter(g => g.startsWith('!')).map(g => globToRegExp(g.slice(1)))
  return dir => include.some(re => re.test(dir)) && !exclude.some(re => re.test(dir))
}

export type Owner =
  { kind: 'member'; dir: string; name: string } | { kind: 'root' } | { kind: 'outside'; dir: string }

/**
 * The nearest named workspace member holding a file. A file under no package.json but the root's
 * is root-only. A file whose nearest named package is not a member is `outside`: `pnpm --filter`
 * could match nothing there and exit 0.
 */
export function ownerOf(cwd: string, file: string, isMember: (dir: string) => boolean): Owner {
  let outside: string | undefined
  for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir)) {
    const name = readPackage(path.join(cwd, dir))?.name
    if (name === undefined) continue
    if (isMember(dir)) return { kind: 'member', dir, name }
    outside ??= dir
  }
  return outside === undefined ? { kind: 'root' } : { kind: 'outside', dir: outside }
}

async function changedFiles(run: Run, cwd: string, base: string): Promise<string[]> {
  const diff = await run('git', ['diff', '-z', '--name-only', `${base}...HEAD`], cwd)
  if (diff.code !== 0) throw new Error(`git diff failed: ${lastLine(diff.output)}`)
  return nulSeparated(diff.output)
}

/** Per changed member, never a root fan-out such as `pnpm -r` or turbo. */
async function workspacePlan(run: Run, cwd: string, base: string): Promise<CheckPlan> {
  const isMember = workspaceMembership(cwd)
  const members = new Map<string, string>()
  const problems: string[] = []
  for (const file of await changedFiles(run, cwd, base)) {
    const owner = ownerOf(cwd, file, isMember)
    if (owner.kind === 'member') members.set(owner.dir, owner.name)
    if (owner.kind === 'outside') problems.push(`${file} is in ${owner.dir}, not a workspace member`)
  }
  const commands: Command[] = [...members.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([dir, name]) =>
      scriptsIn(readPackage(path.join(cwd, dir))).map(script => ({
        cmd: 'pnpm',
        args: ['--filter', name, 'run', script],
      })),
    )
  if (readPackage(cwd)?.scripts?.['capabilities:check'] !== undefined) {
    commands.push({ cmd: 'pnpm', args: ['run', 'capabilities:check'], hint: 'run pnpm capabilities' })
  }
  return { commands, problems }
}

export async function planChecks(run: Run, cwd: string, base: string): Promise<CheckPlan> {
  const pm = packageManager(cwd)
  const root = readPackage(cwd)
  if (root?.scripts?.['pr-ready'] !== undefined)
    return { commands: [{ cmd: pm, args: ['run', 'pr-ready'] }], problems: [] }
  if (fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml'))) return workspacePlan(run, cwd, base)
  return { commands: scriptsIn(root).map(script => ({ cmd: pm, args: ['run', script] })), problems: [] }
}

/** Every planned command ends in its script name, so one repo-level run covers all members. */
const distinctScripts = (commands: Command[]): string[] => [
  ...new Set(commands.map(c => c.args.at(-1)).filter((s): s is string => s !== undefined)),
]

async function localChecks(run: Run, cwd: string, commands: Command[], err: (l: string) => void) {
  const failed: string[] = []
  for (const command of commands) {
    const result = await run(command.cmd, command.args, cwd)
    if (result.code === 0) continue
    err(result.output.trimEnd())
    failed.push(command.hint ? `${commandText(command)} (${command.hint})` : commandText(command))
  }
  return failed.length > 0 ? [`failed: ${failed.join('; ')}`] : []
}

async function basementChecks(
  run: Run,
  cwd: string,
  target: BasementTarget,
  scripts: string[],
  err: (line: string) => void,
) {
  const results = await runOnBasement(run, cwd, target, scripts)
  const codes = results.map(describeExit).join(', ')
  for (const result of results.filter(r => r.code !== 0)) err(result.output.trimEnd())
  const infra = results.map(infraFailure).find(reason => reason !== undefined)
  if (infra) return { reasons: [`${infra} (${codes})`], codes }
  const failed = results.filter(r => r.code !== 0).map(r => basementCommandText(target, r.script))
  return { reasons: failed.length > 0 ? [`failed on basement: ${failed.join('; ')} (${codes})`] : [], codes }
}

export async function checksStep(
  run: Run,
  cwd: string,
  base: string,
  err: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  hostname: string = os.hostname(),
): Promise<StepOutcome> {
  const { commands, problems } = await planChecks(run, cwd, base)
  if (commands.length === 0 && problems.length === 0) return { ok: true, reason: 'no scripts' }
  const scripts = distinctScripts(commands)
  const route =
    scripts.length === 0
      ? { kind: 'local' as const }
      : await routeChecks(run, cwd, base, scripts, env, hostname)
  if (route.kind === 'deferred')
    return {
      ok: problems.length === 0,
      reason: [`deferred to basement after push: ${route.commands.join('; ')}`, ...problems].join('; '),
    }
  if (route.kind === 'local' && route.warning) err(`warning: ${route.warning}`)
  const remote =
    route.kind === 'remote' ? await basementChecks(run, cwd, route.target, scripts, err) : undefined
  const reasons = [...(remote?.reasons ?? (await localChecks(run, cwd, commands, err))), ...problems]
  if (reasons.length > 0) return { ok: false, reason: reasons.join('; ') }
  return remote ? { ok: true, reason: `basement ${remote.codes}` } : { ok: true }
}

/** Never a bare `npx changeset`: without `--no-install` npx downloads an unrelated package of that name. */
export const changesetCommand = (cwd: string, base: string): Command =>
  packageManager(cwd) === 'pnpm'
    ? { cmd: 'pnpm', args: ['exec', 'changeset', 'status', `--since=${base}`] }
    : { cmd: 'npx', args: ['--no-install', '@changesets/cli', 'status', `--since=${base}`] }

export async function changesetStep(run: Run, cwd: string, base: string): Promise<StepOutcome> {
  if (!fs.existsSync(path.join(cwd, '.changeset', 'config.json')))
    return { ok: true, reason: 'not configured' }
  const command = changesetCommand(cwd, base)
  const result = await run(command.cmd, command.args, cwd)
  if (result.code === 0) return { ok: true }
  return { ok: false, reason: lastLine(result.output) }
}

const SCAN_SKIPPED = 'skipped (no body file)'

const nothingToScan = (opts: PrReadyOptions): boolean =>
  opts.bodyFile === undefined && opts.title === undefined

/**
 * gh-write's own scan over the text `gh pr create` would post, so a finding fails here with the
 * reason gh-write would give. An early warning only: gh-write scans again at post time.
 */
export async function scanStep(opts: PrReadyOptions, cwd: string, termsFile: string): Promise<StepOutcome> {
  if (nothingToScan(opts)) return { ok: true, reason: SCAN_SKIPPED }
  const args = ['pr', 'create']
  if (opts.title !== undefined) args.push('--title', opts.title)
  if (opts.bodyFile !== undefined) args.push('--body-file', path.resolve(cwd, opts.bodyFile))
  const scan = await scanGhArgs(args, scanDeps(termsFile))
  return 'reason' in scan ? { ok: false, reason: scan.reason } : { ok: true }
}

function reporter(out: (line: string) => void) {
  return (step: string, outcome: StepOutcome): boolean => {
    const suffix = outcome.reason ? `: ${outcome.reason}` : ''
    out(outcome.ok ? `ok ${step}${suffix}` : `FAIL ${step}${suffix}`)
    return outcome.ok
  }
}

/** Any throw becomes a failed step, so the run still prints FAIL lines and exits non-zero. */
async function guarded(step: () => Promise<StepOutcome>): Promise<StepOutcome> {
  try {
    return await step()
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Order: clean tree, base, rebase, checks, changeset, scan. A dirty tree or a failed rebase stops the
 * run, since the checks would not see the tree that merges. Exit 0 only when every step passed.
 */
export async function prReady(opts: PrReadyOptions, deps: PrReadyDeps = defaultDeps()): Promise<number> {
  const { run, cwd } = deps
  const report = reporter(deps.out)
  const step = async (name: string, fn: () => Promise<StepOutcome>) => report(name, await guarded(fn))
  const fail = (): number => (deps.out('PR-READY FAIL'), 1)
  let base = ''
  const resolveBase = async (): Promise<StepOutcome> => {
    base = await defaultBaseRef(run, cwd)
    return { ok: true, reason: base }
  }
  const rebase = async (): Promise<StepOutcome> => {
    if (opts.rebase === false) return { ok: true, reason: 'skipped (--no-rebase)' }
    return (await pushedBranchStep(run, cwd, base, opts.strict === true)) ?? trappedRebaseStep(deps, base)
  }
  if (!(await step('clean-tree', () => cleanTreeStep(run, cwd)))) return fail()
  if (!(await step('base', resolveBase))) return fail()
  if (!(await step('rebase', rebase))) return fail()
  let ok = await step('checks', () => checksStep(run, cwd, base, deps.err, deps.env, deps.hostname))
  ok = (await step('changeset', () => changesetStep(run, cwd, base))) && ok
  ok = (await step('scan', () => scanStep(opts, cwd, deps.termsFile))) && ok
  if (!ok) return fail()
  const head = await run('git', ['rev-parse', 'HEAD'], cwd)
  const caveat = nothingToScan(opts) ? ' (scan skipped: no body file)' : ''
  deps.out(`PR-READY OK ${head.output.trim()}${caveat}`)
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

export interface SignalTarget {
  once(signal: NodeJS.Signals, listener: () => void): unknown
  off(signal: NodeJS.Signals, listener: () => void): unknown
  exit(code: number): void
}

const SIGNAL_EXIT_CODES: [NodeJS.Signals, number][] = [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]

export function signalTrap(target: SignalTarget = process): Trap {
  return onSignal => {
    const listeners = SIGNAL_EXIT_CODES.map(([signal, code]) => {
      const listener = () => {
        onSignal()
        target.exit(code)
      }
      target.once(signal, listener)
      return [signal, listener] as const
    })
    return () => listeners.forEach(([signal, listener]) => target.off(signal, listener))
  }
}

const defaultDeps = (): PrReadyDeps => ({
  run: spawnRun,
  cwd: process.cwd(),
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
  trap: signalTrap(),
  termsFile: defaultTermsFile(),
})
