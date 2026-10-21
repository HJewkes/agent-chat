import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { withPinnedGitProtocols } from '../../git.js'
import { defaultTermsFile, scanDeps, scanGhArgs } from '../../gh-write/scan.js'
import {
  basementCommandText,
  describeDeferred,
  describeExit,
  describeRun,
  infraFailure,
  routeChecks,
  runOnBasement,
  type BasementTarget,
} from './pr-ready-basement.js'
import { depsStep, packageManager } from './pr-ready-deps.js'
import { resolveBase as resolveStackedBase } from './pr-ready-base.js'
import { pushedBranchStep } from './pr-ready-pushed.js'
import { hasPrivacyTest, privacyStep } from './pr-ready-privacy.js'
import { hasTypedLint, typedLintStep } from './pr-ready-typed-lint.js'

export interface RunResult {
  code: number
  output: string
}

/** Runs one command with no shell. Injected so tests record every call and need no network. */
export type Run = (cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<RunResult>

/** Calls `onSignal` with the exit code on SIGINT or SIGTERM; returns the function that removes the handlers. */
export type Trap = (onSignal: (exitCode: number) => void) => () => void

export interface PrReadyOptions {
  title?: string
  bodyFile?: string
  /** `--rebase` sets true: rebase rather than merge the base. `--no-rebase` sets false: skip the update. */
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
  /** Printed one per line after the step line. */
  details?: string[]
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

const lastLine = (text: string): string =>
  text
    .trim()
    .split('\n')
    .filter(line => line.trim() !== '')
    .at(-1) ?? 'no output'

const commandText = (c: Command): string => [c.cmd, ...c.args].join(' ')

/** `-z` output, so a non-ASCII path arrives as itself rather than quoted and escaped. */
const nulSeparated = (output: string): string[] => output.split('\0').filter(Boolean)

const realpathOrResolved = (file: string): string => {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}

/** `exempt` is the PR body file: the brief has agents write it at the worktree root before pr-ready. */
const exemptBodyFile = (cwd: string, bodyFile: string | undefined): string | undefined =>
  bodyFile === undefined ? undefined : realpathOrResolved(path.resolve(cwd, bodyFile))

/**
 * Worktrees often link `node_modules` into the main checkout, and the `node_modules/` ignore
 * rule matches directories only, so git lists the symlink as untracked.
 */
const isUntrackedNodeModules = (line: string): boolean =>
  line.startsWith('?? ') && line.slice(3).replace(/\/$/, '').split('/').includes('node_modules')

export async function cleanTreeStep(run: Run, cwd: string, exempt?: string): Promise<StepOutcome> {
  const status = await run('git', ['status', '--porcelain'], cwd)
  if (status.code !== 0) return { ok: false, reason: `git status failed: ${lastLine(status.output)}` }
  const files = status.output
    .split('\n')
    .filter(line => line.trim() !== '' && !isUntrackedNodeModules(line))
    .map(line => line.slice(3))
    .filter(file => exempt === undefined || realpathOrResolved(path.resolve(cwd, file)) !== exempt)
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

/** How the update step brings the branch up to date with its base; merge never rewrites a commit. */
export type UpdateMode = 'merge' | 'rebase'

const IN_PROGRESS: Record<UpdateMode, string[]> = {
  merge: ['MERGE_HEAD'],
  rebase: ['rebase-merge', 'rebase-apply'],
}

const inProgress = (gitDir: string, mode: UpdateMode): boolean =>
  IN_PROGRESS[mode].some(marker => fs.existsSync(path.join(gitDir, marker)))

/** Synchronous, for a signal handler. True when no merge or rebase is left in progress. */
export function abortUpdateSync(cwd: string, gitDir: string, mode: UpdateMode): boolean {
  if (!inProgress(gitDir, mode)) return true
  try {
    execFileSync('git', [mode, '--abort'], { cwd, stdio: 'ignore' })
  } catch {
    // The state check below reports the outcome.
  }
  return !inProgress(gitDir, mode)
}

async function abortUpdate(run: Run, cwd: string, gitDir: string, mode: UpdateMode): Promise<string> {
  const abort = await run('git', [mode, '--abort'], cwd)
  if (abort.code === 0 && !inProgress(gitDir, mode)) return `${mode} aborted`
  return `git ${mode} --abort failed (${lastLine(abort.output)}); a ${mode} is still in progress, abort it by hand`
}

/**
 * CC-1458: git stamps the committer, and a merge commit's author too, from the global config. Reusing
 * the HEAD commit's author, which a tainted earlier rebase leaves alone, keeps a noreply branch noreply.
 * A rebase keeps each commit's own author, so only a merge sets one. Undefined when HEAD's identity is unreadable.
 */
async function headIdentityEnv(
  run: Run,
  cwd: string,
  mode: UpdateMode,
): Promise<NodeJS.ProcessEnv | undefined> {
  const log = await run('git', ['log', '-1', '--format=%cn%n%ce%n%an%n%ae'], cwd)
  const [committerName, committerEmail, authorName, authorEmail] = log.output.split('\n').map(l => l.trim())
  const name = authorName || committerName
  const email = authorEmail || committerEmail
  if (log.code !== 0 || !name || !email) return undefined
  const committer = { GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email }
  return mode === 'merge' ? { ...committer, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email } : committer
}

const updateArgs = (mode: UpdateMode, base: string): string[] =>
  mode === 'merge' ? ['merge', '--no-edit', base] : ['rebase', base]

/**
 * CC-1547: by default the base is merged in, so every existing commit keeps its sha. A rebase, which
 * rewrites every commit and drops any whose patch the base already holds, runs only under `--rebase`.
 */
export async function updateStep(
  run: Run,
  cwd: string,
  base: string,
  gitDir: string,
  mode: UpdateMode,
  warn: (line: string) => void = () => {},
): Promise<StepOutcome> {
  const branch = base.slice(REMOTE_PREFIX.length)
  const fetch = await run('git', ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:${base}`], cwd)
  if (fetch.code !== 0)
    return { ok: false, reason: `git fetch of ${branch} failed: ${lastLine(fetch.output)}` }
  const identity = await headIdentityEnv(run, cwd, mode)
  if (!identity) warn(`warning: could not read HEAD's identity; the ${mode} uses the configured identity`)
  const update = await run('git', updateArgs(mode, base), cwd, identity)
  if (update.code === 0) return mode === 'rebase' ? { ok: true, reason: 'rebased (--rebase)' } : { ok: true }
  if (!inProgress(gitDir, mode))
    return { ok: false, reason: `git ${mode} failed: ${lastLine(update.output)}` }
  const unmerged = await run('git', ['diff', '-z', '--name-only', '--diff-filter=U'], cwd)
  const files = nulSeparated(unmerged.output)
  const state = await abortUpdate(run, cwd, gitDir, mode)
  if (files.length === 0)
    return { ok: false, reason: `git ${mode} failed: ${lastLine(update.output)}; ${state}` }
  return { ok: false, reason: `conflict in ${files.join(', ')}; ${state}` }
}

async function gitDirOf(run: Run, cwd: string): Promise<string> {
  const result = await run('git', ['rev-parse', '--absolute-git-dir'], cwd)
  if (result.code !== 0) throw new Error(`git rev-parse failed: ${lastLine(result.output)}`)
  return result.output.trim()
}

/** A SIGINT or SIGTERM mid-update aborts the merge or rebase before the process exits. */
async function trappedUpdateStep(deps: PrReadyDeps, base: string, mode: UpdateMode): Promise<StepOutcome> {
  const gitDir = await gitDirOf(deps.run, deps.cwd)
  const release = deps.trap(exitCode => {
    const state = abortUpdateSync(deps.cwd, gitDir, mode)
      ? `${mode} aborted`
      : `a ${mode} is still in progress, abort it by hand`
    deps.out(`FAIL update: interrupted; ${state}`)
    deps.out(`PR-READY FAIL exit=${exitCode}`)
  })
  try {
    return await updateStep(deps.run, deps.cwd, base, gitDir, mode, deps.err)
  } finally {
    release()
  }
}

interface PackageJson {
  name?: string
  scripts?: Record<string, string>
}

export function readPackage(dir: string): PackageJson | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as PackageJson
  } catch {
    return undefined
  }
}

const scriptsIn = (pkg: PackageJson | undefined): string[] =>
  CHECK_SCRIPTS.filter(script => pkg?.scripts?.[script] !== undefined)

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

export async function changedFiles(run: Run, cwd: string, base: string): Promise<string[]> {
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
  const details = results.map(describeRun)
  const infra = results.map(infraFailure).find(reason => reason !== undefined)
  if (infra) return { reasons: [`${infra} (${codes})`], codes, details }
  const failed = results.filter(r => r.code !== 0).map(r => basementCommandText(target, r.script))
  const reasons = failed.length > 0 ? [`failed on basement: ${failed.join('; ')} (${codes})`] : []
  return { reasons, codes, details }
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
      reason: [
        `deferred to basement after push: ${route.runs.map(r => r.command).join('; ')}`,
        ...problems,
      ].join('; '),
      details: route.runs.map(describeDeferred),
    }
  if (route.kind === 'local' && route.warning) err(`warning: ${route.warning}`)
  const remote =
    route.kind === 'remote' ? await basementChecks(run, cwd, route.target, scripts, err) : undefined
  const reasons = [...(remote?.reasons ?? (await localChecks(run, cwd, commands, err))), ...problems]
  const details = remote?.details ?? []
  if (reasons.length > 0) return { ok: false, reason: reasons.join('; '), details }
  return remote ? { ok: true, reason: `basement ${remote.codes}`, details } : { ok: true }
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
    outcome.details?.forEach(out)
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
 * Base: the open PR's base branch, else `branch.<b>.agent-chat-base`, else the stacked origin branch
 * with an open PR, else origin/HEAD (see pr-ready-base.ts).
 * Order: clean tree, base, update (merge the base in; rebase only under `--rebase`), deps (only when
 * node_modules is missing), checks, typed-lint (root lint:types only, always local), privacy
 * (agent-chat only), changeset, scan. A dirty tree, a failed update or a failed install stops the run, since the checks would not see the tree that merges. Exit 0 only when every step passed.
 */
export async function prReady(opts: PrReadyOptions, deps: PrReadyDeps = defaultDeps()): Promise<number> {
  const { run, cwd } = deps
  const report = reporter(deps.out)
  const step = async (name: string, fn: () => Promise<StepOutcome>) => report(name, await guarded(fn))
  const fail = (): number => (deps.out('PR-READY FAIL exit=1'), 1)
  let base = ''
  const resolveBase = async (): Promise<StepOutcome> => {
    const resolved = await resolveStackedBase(run, cwd, await defaultBaseRef(run, cwd))
    base = resolved.ref
    return { ok: true, reason: resolved.reason }
  }
  const update = async (): Promise<StepOutcome> => {
    if (opts.rebase === false) return { ok: true, reason: 'skipped (--no-rebase)' }
    const mode = opts.rebase === true ? 'rebase' : 'merge'
    return (
      (await pushedBranchStep(run, cwd, base, opts.strict === true)) ?? trappedUpdateStep(deps, base, mode)
    )
  }
  if (!(await step('clean-tree', () => cleanTreeStep(run, cwd, exemptBodyFile(cwd, opts.bodyFile)))))
    return fail()
  if (!(await step('base', resolveBase))) return fail()
  if (!(await step('update', update))) return fail()
  const install = await guarded(async () => (await depsStep(run, cwd)) ?? { ok: true })
  if (install.reason !== undefined && !report('deps', install)) return fail()
  let ok = await step('checks', () => checksStep(run, cwd, base, deps.err, deps.env, deps.hostname))
  if (hasTypedLint(cwd)) ok = (await step('typed-lint', () => typedLintStep(run, cwd, base, deps.err))) && ok
  if (hasPrivacyTest(cwd)) ok = (await step('privacy', () => privacyStep(run, cwd, deps.err))) && ok
  ok = (await step('changeset', () => changesetStep(run, cwd, base))) && ok
  ok = (await step('scan', () => scanStep(opts, cwd, deps.termsFile))) && ok
  if (!ok) return fail()
  const head = await run('git', ['rev-parse', 'HEAD'], cwd)
  const caveat = nothingToScan(opts) ? ' (scan skipped: no body file)' : ''
  deps.out(`PR-READY OK exit=0 ${head.output.trim()}${caveat}`)
  return 0
}

export const spawnRun: Run = (cmd, args, cwd, env) =>
  new Promise(resolve => {
    const child = spawn(cmd, args, {
      cwd,
      env: withPinnedGitProtocols({ ...process.env, ...env }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
        onSignal(code)
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
