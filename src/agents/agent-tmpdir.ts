import fs from 'node:fs'
import path from 'node:path'
import type { AgentIdentity } from '../protocol.js'
import { AGENT_ID_ENV, AGENT_NAME_PATTERN, LAUNCHER_PID_ENV } from '../launch-identity.js'
import { finishedIds, isLauncherOf, procTable, type ProcessTable } from './orphan-reap.js'

/**
 * CC-901: each agent on Linux gets its own TMPDIR, `/tmp/ac-<name>-<launcher pid>`, removed once
 * the launch's processes are gone.
 *
 * Without it every Linux agent shares /tmp, a 1M-inode tmpfs, and nothing an agent or its tools
 * leave there is ever removed. macOS keeps CC-500's per-user temp dir.
 *
 * The removal deletes files, so it is narrow on purpose: it only removes the exact path rebuilt
 * from a validated name and pid, never a pattern; it refuses a symlink, a non-directory and a
 * dir another user owns; and it keeps the dir while any process of that launch is alive or any
 * live process has its cwd or an open fd inside.
 *
 * CC-1184: a launch may put its dir under an on-disk root, `<home>/.cache/agent-chat/tmp`, instead
 * of /tmp, so a review's installed checkouts stop filling the tmpfs's inodes. CC-1264 made it the
 * default for every Linux launch; /tmp stays an accepted root for launches made before that and
 * for the sweep.
 *
 * CC-1266: Claude Code writes each Bash call's output under `CLAUDE_CODE_TMPDIR`, falling back to
 * TMPDIR. A launch's harness dir lives under its own root, `<home>/.cache/agent-chat/harness`, so
 * a full scratch dir cannot take the agent's Bash tool, and the `rm` to recover, down with it.
 *
 * Those three are the only roots accepted; every check above applies under each.
 */

export const TMP_ROOT = '/tmp'
export const DISK_TMP_ROOT_SUFFIX = '/.cache/agent-chat/tmp'
export const HARNESS_ROOT_SUFFIX = '/.cache/agent-chat/harness'
const DIR_MODE = 0o700
const VALID_NAME = new RegExp(`^${AGENT_NAME_PATTERN}$`, 'i')
const PREFIX = 'ac-'

export interface TmpStat {
  isDirectory(): boolean
  isSymbolicLink(): boolean
  uid: number
}

export interface TmpFs {
  /** undefined when the path does not exist. Never follows a symlink. */
  lstat(path: string): TmpStat | undefined
  readdir(path: string): string[]
  /** `recursive` creates missing parents, as for the on-disk root; it does not fail when the path exists. */
  mkdir(path: string, mode: number, recursive?: boolean): void
  chmod(path: string, mode: number): void
  rm(path: string): void
}

export interface TmpProcessTable extends Pick<
  ProcessTable,
  'pids' | 'environ' | 'command' | 'parentOf' | 'isAlive'
> {
  /** undefined when it cannot be read. */
  cwd(pid: number): string | undefined
  /** Link targets of the process's open fds; empty when they cannot be read. */
  fds(pid: number): string[]
}

export const realTmpFs: TmpFs = {
  lstat: path => {
    try {
      return fs.lstatSync(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
  },
  readdir: path => fs.readdirSync(path),
  mkdir: (path, mode, recursive) => void fs.mkdirSync(path, { mode, recursive }),
  chmod: (path, mode) => fs.chmodSync(path, mode),
  // Recursive rm unlinks a symlink it meets inside the tree; it never follows one.
  rm: path => fs.rmSync(path, { recursive: true }),
}

const readLink = (path: string): string | undefined => {
  try {
    return fs.readlinkSync(path)
  } catch {
    return undefined
  }
}

const readFds = (pid: number): string[] => {
  try {
    return fs.readdirSync(`/proc/${pid}/fd`).flatMap(fd => readLink(`/proc/${pid}/fd/${fd}`) ?? [])
  } catch {
    return []
  }
}

export const realTmpProcessTable = (): TmpProcessTable => ({
  ...procTable(),
  cwd: pid => readLink(`/proc/${pid}/cwd`),
  fds: readFds,
})

const currentUid = (): number => process.getuid?.() ?? -1

/** The on-disk root under `home`. */
export const diskTmpRoot = (home: string): string => `${home}${DISK_TMP_ROOT_SUFFIX}`

/** The on-disk root of the launches' Claude Code harness dirs under `home`. */
export const diskHarnessRoot = (home: string): string => `${home}${HARNESS_ROOT_SUFFIX}`

/** /tmp, or an absolute, normalised `<home>/.cache/agent-chat/tmp` or `<home>/.cache/agent-chat/harness`. */
export const isTmpRoot = (root: string): boolean =>
  root === TMP_ROOT ||
  (path.posix.isAbsolute(root) &&
    path.posix.normalize(root) === root &&
    (root.endsWith(DISK_TMP_ROOT_SUFFIX) || root.endsWith(HARNESS_ROOT_SUFFIX)))

/** The one path this module will ever create or remove for an agent, or undefined when any part is invalid. */
export function agentTmpPath(name: string, pid: number, root = TMP_ROOT): string | undefined {
  if (!VALID_NAME.test(name) || !Number.isSafeInteger(pid) || pid <= 0 || !isTmpRoot(root)) return undefined
  return `${root}/${PREFIX}${name}-${pid}`
}

const isOwnDir = (stat: TmpStat | undefined, uid: number): boolean =>
  stat !== undefined && !stat.isSymbolicLink() && stat.isDirectory() && stat.uid === uid

/** Why an existing path is not an own, real directory, or undefined when it is one. */
function unsafeDirReason(stat: TmpStat, uid: number): string | undefined {
  if (stat.isSymbolicLink()) return 'symlink'
  if (!stat.isDirectory()) return 'not a directory'
  if (stat.uid !== uid) return `owned by uid ${stat.uid}`
  return undefined
}

/** Why removal must not resolve through `root`; /tmp is root-owned and sticky, so it is exempt as in `ensureRoot`. */
function rootRefusal(tmpFs: TmpFs, root: string, uid: number): string | undefined {
  if (root === TMP_ROOT) return undefined
  const stat = tmpFs.lstat(root)
  if (stat === undefined) return 'missing'
  const unsafe = unsafeDirReason(stat, uid)
  return unsafe === undefined ? undefined : `root ${unsafe}`
}

export interface AgentTmpRequest {
  name: string
  /** The launcher's pid: `run-agent`'s own, which a relaunch never reuses while the old one runs. */
  pid: number
  /** Where the dir goes; defaults to /tmp. */
  root?: string
  platform?: NodeJS.Platform
  fs?: TmpFs
  uid?: number
}

/** The disk root is made on first use; like the leaf, it is used only if it is ours and not a symlink. */
function ensureRoot(tmpFs: TmpFs, root: string, uid: number): boolean {
  if (root === TMP_ROOT) return true
  try {
    tmpFs.mkdir(root, DIR_MODE, true)
    return isOwnDir(tmpFs.lstat(root), uid)
  } catch {
    return false
  }
}

/** Creates the agent's dir 0700 and returns it; undefined off Linux or when it cannot be made safely. */
export function ensureAgentTmpDir(request: AgentTmpRequest): string | undefined {
  const { platform = process.platform, fs: tmpFs = realTmpFs, uid = currentUid(), root = TMP_ROOT } = request
  const dir = agentTmpPath(request.name, request.pid, root)
  if (platform !== 'linux' || dir === undefined || !ensureRoot(tmpFs, root, uid)) return undefined
  try {
    tmpFs.mkdir(dir, DIR_MODE)
    return dir
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return undefined
  }
  // A leftover from a recycled pid is reused only if it is ours; anything else in a shared
  // root could be planted to read or redirect the agent's temp files.
  try {
    if (!isOwnDir(tmpFs.lstat(dir), uid)) return undefined
    tmpFs.chmod(dir, DIR_MODE)
    return dir
  } catch {
    return undefined
  }
}

export type TmpRemoval =
  | { removed: true; path: string; inodes: number }
  | { removed: false; path: string; reason: string; code?: string }

export interface RemovalTarget {
  name: string
  pid: number
  /** The agent ids that may have launched under this name; a process of any of them keeps the dir. */
  agentIds: ReadonlySet<string>
  /** Defaults to /tmp. */
  root?: string
}

export interface RemovalDeps {
  fs: TmpFs
  table: TmpProcessTable
  uid: number
  /** The caller's pid: it and its ancestors never count as holding the dir. */
  self: number
}

function ancestry(table: TmpProcessTable, self: number): Set<number> {
  const chain = new Set<number>([self])
  for (
    let pid = table.parentOf(self);
    pid !== undefined && pid > 1 && !chain.has(pid);
    pid = table.parentOf(pid)
  ) {
    chain.add(pid)
  }
  return chain
}

const isInside = (path: string | undefined, dir: string): boolean =>
  path !== undefined && (path === dir || path.startsWith(`${dir}/`))

/** Why the dir must stay, or undefined when no live process is tied to it. */
function holder(target: RemovalTarget, dir: string, deps: RemovalDeps): string | undefined {
  const skip = ancestry(deps.table, deps.self)
  for (const pid of deps.table.pids()) {
    if (skip.has(pid) || !deps.table.isAlive(pid)) continue
    const env = deps.table.environ(pid)
    const agentId = env?.[AGENT_ID_ENV]
    if (
      agentId !== undefined &&
      target.agentIds.has(agentId) &&
      env?.[LAUNCHER_PID_ENV] === String(target.pid)
    ) {
      return `launch process ${pid} alive`
    }
    if (isInside(deps.table.cwd(pid), dir) || deps.table.fds(pid).some(fd => isInside(fd, dir))) {
      return `in use by pid ${pid}`
    }
  }
  return undefined
}

function countInodes(tmpFs: TmpFs, path: string): number {
  const stat = tmpFs.lstat(path)
  if (stat === undefined) return 0
  if (stat.isSymbolicLink() || !stat.isDirectory()) return 1
  return tmpFs.readdir(path).reduce((sum, entry) => sum + countInodes(tmpFs, `${path}/${entry}`), 1)
}

/**
 * Removes exactly `<root>/ac-<name>-<pid>` once nothing alive is tied to it. A missing dir or root is
 * not an error. A disk root that is a symlink, not a directory or another user's is refused, so the
 * recursive rm never resolves through it to an `ac-*` dir elsewhere.
 */
export function removeAgentTmpDir(target: RemovalTarget, deps: RemovalDeps): TmpRemoval {
  const dir = agentTmpPath(target.name, target.pid, target.root)
  if (dir === undefined) return { removed: false, path: '', reason: 'invalid name or pid' }
  const rootReason = rootRefusal(deps.fs, target.root ?? TMP_ROOT, deps.uid)
  if (rootReason !== undefined) return { removed: false, path: dir, reason: rootReason }
  const stat = deps.fs.lstat(dir)
  if (stat === undefined) return { removed: false, path: dir, reason: 'missing' }
  const unsafe = unsafeDirReason(stat, deps.uid)
  if (unsafe !== undefined) return { removed: false, path: dir, reason: unsafe }
  const busy = holder(target, dir, deps)
  if (busy !== undefined) return { removed: false, path: dir, reason: busy }
  const inodes = countInodes(deps.fs, dir)
  deps.fs.rm(dir)
  return { removed: true, path: dir, inodes }
}

type Log = (event: string, detail: Record<string, unknown>) => void

/**
 * `removeAgentTmpDir` that reports a throw instead of raising it. A tree with a 0555 subdir makes
 * rm throw EACCES part-way; uncaught, that is a stack trace at run-agent exit and, in the sweep,
 * one undeletable dir ending every later pass before the entries after it.
 */
function tryRemove(target: RemovalTarget, deps: RemovalDeps): TmpRemoval {
  try {
    return removeAgentTmpDir(target, deps)
  } catch (err) {
    const { code, message } = err as NodeJS.ErrnoException
    return {
      removed: false,
      path: agentTmpPath(target.name, target.pid, target.root) ?? '',
      reason: message,
      code: code ?? 'unknown',
    }
  }
}

function logRemoval(log: Log, source: 'exit' | 'sweep', agentId: string, result: TmpRemoval): void {
  if (result.removed) {
    log('tmpdir_removed', { source, agentId, path: result.path, inodes: result.inodes })
  } else if (result.code !== undefined) {
    log('tmpdir_remove_failed', {
      source,
      agentId,
      path: result.path,
      code: result.code,
      reason: result.reason,
    })
  } else if (result.reason !== 'missing') {
    log('tmpdir_kept', { source, agentId, path: result.path, reason: result.reason })
  }
}

export interface ExitTmpDeps extends RemovalDeps {
  platform: NodeJS.Platform
  log: Log
}

export const realExitTmpDeps = (log: Log): ExitTmpDeps => ({
  fs: realTmpFs,
  table: realTmpProcessTable(),
  uid: currentUid(),
  self: process.pid,
  platform: process.platform,
  log,
})

/** Run by `run-agent` as it exits, after the orphan reap: removes its own launch's dir under `root`. */
export function removeOwnTmpDir(
  name: string,
  agentId: string,
  launcherPid: number,
  deps: ExitTmpDeps,
  root = TMP_ROOT,
): void {
  if (deps.platform !== 'linux') return
  const result = tryRemove({ name, pid: launcherPid, agentIds: new Set([agentId]), root }, deps)
  logRemoval(deps.log, 'exit', agentId, result)
}

export interface TmpSweepDeps extends RemovalDeps {
  roster: () => readonly AgentIdentity[]
  now: () => number
  log: Log
  /** Paths already reported as kept, so a standing refusal is logged once rather than every sweep. */
  announced?: Set<string>
  /** The roots to scan; defaults to /tmp alone. A root that does not exist is skipped. */
  roots?: readonly string[]
}

/** Finished names mapped to their agent ids; a name that also has a live row is left out entirely. */
function finishedNames(roster: readonly AgentIdentity[], now: number): Map<string, Set<string>> {
  const finished = finishedIds(roster, now)
  const live = new Set(roster.filter(a => !finished.has(a.agentId)).map(a => a.name))
  const names = new Map<string, Set<string>>()
  for (const a of roster) {
    if (!finished.has(a.agentId) || live.has(a.name)) continue
    names.set(a.name, (names.get(a.name) ?? new Set()).add(a.agentId))
  }
  return names
}

/** The launcher pid of `entry` when it is exactly `ac-<name>-<pid>` for this name. */
function pidOf(entry: string, name: string, root: string): number | undefined {
  const prefix = `${PREFIX}${name}-`
  if (!entry.startsWith(prefix)) return undefined
  const digits = entry.slice(prefix.length)
  if (!/^[1-9]\d{0,9}$/.test(digits)) return undefined
  const pid = Number(digits)
  return agentTmpPath(name, pid, root) === `${root}/${entry}` ? pid : undefined
}

function sweepOne(target: RemovalTarget, deps: TmpSweepDeps): void {
  // The launcher itself does not carry the launch identity, so a still-running one is checked by argv.
  const command = deps.table.command(target.pid)
  if (deps.table.isAlive(target.pid) && [...target.agentIds].some(id => isLauncherOf(command, id))) return
  const result = tryRemove(target, deps)
  if (!result.removed && deps.announced?.has(result.path)) return
  if (!result.removed) deps.announced?.add(result.path)
  logRemoval(deps.log, 'sweep', [...target.agentIds].join(','), result)
}

/** One pass: removes the dirs of agents whose rows are finished, for launches that left one behind. */
export function sweepAgentTmpDirs(deps: TmpSweepDeps): void {
  const names = finishedNames(deps.roster(), deps.now())
  if (names.size === 0) return
  for (const root of deps.roots ?? [TMP_ROOT]) {
    if (isTmpRoot(root) && deps.fs.lstat(root) !== undefined) sweepRoot(root, names, deps)
  }
}

function sweepRoot(root: string, names: Map<string, Set<string>>, deps: TmpSweepDeps): void {
  for (const entry of deps.fs.readdir(root)) {
    if (!entry.startsWith(PREFIX)) continue
    for (const [name, agentIds] of names) {
      const pid = pidOf(entry, name, root)
      if (pid !== undefined) sweepOne({ name, pid, agentIds, root }, deps)
    }
  }
}
