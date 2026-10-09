import fs from 'node:fs'
import type { AgentIdentity } from '../protocol.js'
import { AGENT_ID_ENV, LAUNCHER_PID_ENV } from '../launch-identity.js'

/**
 * CC-898: kill what a finished headless agent left behind.
 *
 * A process belongs to a launch when its environment carries that launch's
 * `AGENT_CHAT_AGENT_ID` and `AGENT_CHAT_LAUNCHER_PID` together. The agent id alone is not
 * enough: a resume keeps it, so a name or id match could kill a live successor. The launcher
 * pid is `run-agent`'s own, which a relaunch never reuses while the old one still runs.
 *
 * The environment is read from /proc, which only Linux has. A process whose environ cannot
 * be read is skipped, never guessed at.
 */

/** How long a row stays exited or retired before the sweep trusts that its processes are strays. */
export const SWEEP_GRACE_MS = 3 * 60_000
/** Between TERM and KILL. */
export const KILL_GRACE_MS = 2_000
const LOGGED_COMMAND_MAX = 120
const LOGGED_COMMANDS = 5

export interface ProcessTable {
  pids(): number[]
  /** undefined when the environment cannot be read (gone, or another uid). */
  environ(pid: number): Record<string, string> | undefined
  command(pid: number): string
  parentOf(pid: number): number | undefined
  isAlive(pid: number): boolean
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void
}

export interface Target {
  pid: number
  agentId: string
  command: string
}

export interface ReapReport {
  agentIds: string[]
  count: number
  commands: string[]
  survivors: number[]
}

export type LaunchMatch = (env: Record<string, string>) => boolean

export const procTable = (): ProcessTable => ({
  pids: () =>
    fs
      .readdirSync('/proc')
      .filter(name => /^\d+$/.test(name))
      .map(Number),
  environ: pid => {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8')
      return Object.fromEntries(
        raw
          .split('\0')
          .filter(entry => entry.includes('='))
          .map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]),
      )
    } catch {
      return undefined
    }
  },
  command: pid => {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim()
    } catch {
      return ''
    }
  },
  parentOf: pid => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    } catch {
      return undefined
    }
  },
  isAlive: pid => {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  signal: (pid, signal) => process.kill(pid, signal),
})

/** `run-agent <id>` is the launcher's own argv; a recycled pid runs something else. */
export const isLauncherOf = (command: string, agentId: string): boolean =>
  command.split(/\s+/).some((word, i, words) => word === 'run-agent' && words[i + 1] === agentId)

/** Never the caller, its ancestors, or agent-chat's own infrastructure. */
function protectedPids(table: ProcessTable, self: number): Set<number> {
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

/**
 * The environment says which launch a process descends from, not that it is a disposable stray:
 * the broker and every `run-agent` inherit the identity of whichever agent started them.
 * So agent-chat's own broker, launchers and MCP servers are never targets. Loose on purpose:
 * a stray that merely mentions one of these words is left alone.
 */
const INFRASTRUCTURE_VERBS = new Set(['broker', 'run-agent', 'mcp'])
const isAgentChatInfrastructure = (command: string): boolean =>
  command
    .split(/\s+/)
    .slice(1)
    .some(word => INFRASTRUCTURE_VERBS.has(word))

/** Processes whose environment satisfies `match`, minus every one the safety rules protect. */
export function findTargets(table: ProcessTable, match: LaunchMatch, self = process.pid): Target[] {
  const skip = protectedPids(table, self)
  const targets: Target[] = []
  for (const pid of table.pids()) {
    if (skip.has(pid)) continue
    const env = table.environ(pid)
    if (env === undefined || !match(env)) continue
    const command = table.command(pid)
    if (isAgentChatInfrastructure(command)) continue
    targets.push({ pid, command, agentId: env[AGENT_ID_ENV] ?? '' })
  }
  return targets
}

function signalAll(table: ProcessTable, pids: number[], signal: 'SIGTERM' | 'SIGKILL'): void {
  for (const pid of pids) {
    try {
      table.signal(pid, signal)
    } catch {
      // Already gone, or not ours to signal: the survivor check reports what matters.
    }
  }
}

/** Phase one: TERM. The targets go to `finishReap` once the grace has passed. */
export function startReap(table: ProcessTable, match: LaunchMatch, self = process.pid): Target[] {
  const targets = findTargets(table, match, self)
  signalAll(
    table,
    targets.map(t => t.pid),
    'SIGTERM',
  )
  return targets
}

/** Phase two: KILL what ignored TERM, and name whatever outlived even that. */
export function finishReap(table: ProcessTable, targets: Target[]): number[] {
  const stubborn = targets.map(t => t.pid).filter(pid => table.isAlive(pid))
  signalAll(table, stubborn, 'SIGKILL')
  return stubborn.filter(pid => table.isAlive(pid))
}

export function reportOf(targets: Target[], survivors: number[]): ReapReport {
  return {
    agentIds: [...new Set(targets.map(t => t.agentId))],
    count: targets.length,
    commands: targets.slice(0, LOGGED_COMMANDS).map(t => t.command.slice(0, LOGGED_COMMAND_MAX)),
    survivors,
  }
}

/** The processes of one exact launch. */
export const matchLaunch =
  (agentId: string, launcherPid: string): LaunchMatch =>
  env =>
    env[AGENT_ID_ENV] === agentId && env[LAUNCHER_PID_ENV] === launcherPid

/**
 * The sweep's match: any launch of an agent whose row is finished, unless the launcher that
 * launch names is still a live `run-agent <id>`, which is a resume running under the same id.
 */
export const matchFinished =
  (finished: ReadonlySet<string>, table: ProcessTable): LaunchMatch =>
  env => {
    const agentId = env[AGENT_ID_ENV]
    const launcher = Number(env[LAUNCHER_PID_ENV])
    if (agentId === undefined || !finished.has(agentId) || !Number.isInteger(launcher) || launcher <= 0) {
      return false
    }
    return !(table.isAlive(launcher) && isLauncherOf(table.command(launcher), agentId))
  }

/** Rows exited or retired for longer than the grace. */
export function finishedIds(roster: readonly AgentIdentity[], now: number): Set<string> {
  const done = roster.filter(
    a =>
      (a.state === 'exited' || a.state === 'retired') &&
      now - (a.exitedAt ?? a.lastEventAt) >= SWEEP_GRACE_MS,
  )
  return new Set(done.map(a => a.agentId))
}

export interface ExitReapDeps {
  table: ProcessTable
  log: (event: string, detail: Record<string, unknown>) => void
  /** Synchronous: a `process.on('exit')` handler cannot await. */
  sleepSync: (ms: number) => void
  platform: NodeJS.Platform
}

export const realExitDeps = (log: ExitReapDeps['log']): ExitReapDeps => ({
  table: procTable(),
  log,
  sleepSync: ms => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  platform: process.platform,
})

/** Run by `run-agent` as it exits: kills what its own launch left behind, then logs it. */
export function reapOwnLaunch(
  agentId: string,
  launcherPid: number,
  deps: ExitReapDeps,
): ReapReport | undefined {
  if (deps.platform !== 'linux') {
    deps.log('orphan_reap_skipped', { agentId, reason: `no /proc on ${deps.platform}` })
    return undefined
  }
  const targets = startReap(deps.table, matchLaunch(agentId, String(launcherPid)), launcherPid)
  if (targets.length === 0) return undefined
  deps.sleepSync(KILL_GRACE_MS)
  const report = reportOf(targets, finishReap(deps.table, targets))
  deps.log('orphans_reaped', { source: 'exit', ...report })
  return report
}
