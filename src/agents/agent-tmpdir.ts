import fs from 'node:fs'
import type { AgentIdentity } from '../protocol.js'
import { AGENT_ID_ENV, LAUNCHER_PID_ENV } from '../launch-identity.js'
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
 */

export const TMP_ROOT = '/tmp'
const DIR_MODE = 0o700
/** No `.`, `/` or `\`, so a valid name can never leave /tmp or name a parent. */
const VALID_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i
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
  mkdir(path: string, mode: number): void
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
  mkdir: (path, mode) => fs.mkdirSync(path, { mode }),
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

/** The one path this module will ever create or remove for an agent, or undefined when either part is invalid. */
export function agentTmpPath(name: string, pid: number): string | undefined {
  if (!VALID_NAME.test(name) || !Number.isSafeInteger(pid) || pid <= 0) return undefined
  return `${TMP_ROOT}/${PREFIX}${name}-${pid}`
}

const isOwnDir = (stat: TmpStat | undefined, uid: number): boolean =>
  stat !== undefined && !stat.isSymbolicLink() && stat.isDirectory() && stat.uid === uid

export interface AgentTmpRequest {
  name: string
  /** The launcher's pid: `run-agent`'s own, which a relaunch never reuses while the old one runs. */
  pid: number
  platform?: NodeJS.Platform
  fs?: TmpFs
  uid?: number
}

/** Creates the agent's dir 0700 and returns it; undefined off Linux or when it cannot be made safely. */
export function ensureAgentTmpDir(request: AgentTmpRequest): string | undefined {
  const { platform = process.platform, fs: tmpFs = realTmpFs, uid = currentUid() } = request
  const dir = agentTmpPath(request.name, request.pid)
  if (platform !== 'linux' || dir === undefined) return undefined
  try {
    tmpFs.mkdir(dir, DIR_MODE)
    return dir
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return undefined
  }
  // A leftover from a recycled pid is reused only if it is ours; anything else in a shared
  // /tmp could be planted to read or redirect the agent's temp files.
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

/** Removes exactly `/tmp/ac-<name>-<pid>` once nothing alive is tied to it. A missing dir is not an error. */
export function removeAgentTmpDir(target: RemovalTarget, deps: RemovalDeps): TmpRemoval {
  const dir = agentTmpPath(target.name, target.pid)
  if (dir === undefined) return { removed: false, path: '', reason: 'invalid name or pid' }
  const stat = deps.fs.lstat(dir)
  if (stat === undefined) return { removed: false, path: dir, reason: 'missing' }
  if (stat.isSymbolicLink()) return { removed: false, path: dir, reason: 'symlink' }
  if (!stat.isDirectory()) return { removed: false, path: dir, reason: 'not a directory' }
  if (stat.uid !== deps.uid) return { removed: false, path: dir, reason: `owned by uid ${stat.uid}` }
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
      path: agentTmpPath(target.name, target.pid) ?? '',
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

/** Run by `run-agent` as it exits, after the orphan reap: removes its own launch's dir. */
export function removeOwnTmpDir(name: string, agentId: string, launcherPid: number, deps: ExitTmpDeps): void {
  if (deps.platform !== 'linux') return
  const result = tryRemove({ name, pid: launcherPid, agentIds: new Set([agentId]) }, deps)
  logRemoval(deps.log, 'exit', agentId, result)
}

export interface TmpSweepDeps extends RemovalDeps {
  roster: () => readonly AgentIdentity[]
  now: () => number
  log: Log
  /** Paths already reported as kept, so a standing refusal is logged once rather than every sweep. */
  announced?: Set<string>
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
function pidOf(entry: string, name: string): number | undefined {
  const prefix = `${PREFIX}${name}-`
  if (!entry.startsWith(prefix)) return undefined
  const digits = entry.slice(prefix.length)
  if (!/^[1-9]\d{0,9}$/.test(digits)) return undefined
  const pid = Number(digits)
  return agentTmpPath(name, pid) === `${TMP_ROOT}/${entry}` ? pid : undefined
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
  for (const entry of deps.fs.readdir(TMP_ROOT)) {
    if (!entry.startsWith(PREFIX)) continue
    for (const [name, agentIds] of names) {
      const pid = pidOf(entry, name)
      if (pid !== undefined) sweepOne({ name, pid, agentIds }, deps)
    }
  }
}
