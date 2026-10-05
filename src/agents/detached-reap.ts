import path from 'node:path'
import { isProcessAlive } from '../broker/lifecycle.js'
import { psArgvReader, type ArgvReader } from '../broker/host-channels.js'
import type { AgentIdentity } from '../protocol.js'
import { knownConfigDirs, readSessionRecords, type SessionRecord } from './claude-sessions.js'
import { readRuntimeState } from './launch-files.js'

/**
 * CC-450: exit inference for a spawned agent this broker did not launch.
 *
 * `rehydrate` refuses to put such an agent in `live` because its pid may have been
 * recycled and nobody is watching it, so a presence-only settle would declare a
 * running agent dead. This infers an exit only on direct evidence instead: the
 * launcher pid recorded in `runtime.json` is gone, or now runs something else.
 * Nothing is signalled and nothing enters `live`.
 *
 * Only a headless launch records a pid (the `agent-chat run-agent <id>` process,
 * which lives exactly as long as the claude it started). A visible agent, an adopted
 * human session, or a launch that failed before its handle was written has none, so
 * its liveness comes from Claude Code's own session records instead (`claude-sessions.ts`).
 */

export interface ProcessProbe {
  isAlive: (pid: number) => boolean
  readArgv: ArgvReader
  /** Claude Code's running-session records across every account dir, plus `extraDirs`. */
  sessionRecords: (extraDirs: readonly string[]) => SessionRecord[]
}

export const hostProbe: ProcessProbe = {
  isAlive: isProcessAlive,
  readArgv: psArgvReader,
  sessionRecords: extraDirs => readSessionRecords([...extraDirs, ...knownConfigDirs()]),
}

export type Liveness = { dead: true; pid?: number; reason: string } | { dead: false; reason: string }
export type DeadLiveness = Extract<Liveness, { dead: true }>

/** The launcher's own argv: `<node> <cli> run-agent <id>`. */
const runsAgent = (argv: string, agentId: string): boolean =>
  argv.split(/\s+/).some((word, i, words) => word === 'run-agent' && words[i + 1] === agentId)

/** A native `.../claude` binary or an npm install's `@anthropic-ai/claude-code` entry. */
const runsClaude = (argv: string): boolean =>
  argv.split(/\s+/).some(word => path.basename(word) === 'claude' || word.includes('/claude-code/'))

export const launcherPid = (agentId: string): number | undefined => readRuntimeState(agentId)?.handle.pid

export function launcherLiveness(agentId: string, probe: ProcessProbe): Liveness {
  const pid = launcherPid(agentId)
  if (pid === undefined) return { dead: false, reason: 'no recorded pid' }
  if (!probe.isAlive(pid)) return { dead: true, pid, reason: `launcher pid ${pid} is gone` }
  const argv = probe.readArgv(pid)
  if (argv === undefined) return { dead: false, reason: `pid ${pid} is alive and its argv is unreadable` }
  if (runsAgent(argv, agentId)) return { dead: false, reason: `launcher pid ${pid} is running` }
  return { dead: true, pid, reason: `pid ${pid} was reused by another process` }
}

function sessionPidLiveness(record: SessionRecord, probe: ProcessProbe): Liveness {
  const { pid, sessionId } = record
  if (!probe.isAlive(pid)) return { dead: true, pid, reason: `session ${sessionId} pid ${pid} is gone` }
  const argv = probe.readArgv(pid)
  if (argv === undefined || runsClaude(argv)) return { dead: false, reason: `session pid ${pid} is running` }
  return { dead: true, pid, reason: `session pid ${pid} was reused by another process` }
}

/** For a row with no launcher pid: is a Claude Code process still holding its session id? */
export function sessionLiveness(agent: AgentIdentity, probe: ProcessProbe): Liveness {
  if (agent.sessionId === '') return { dead: false, reason: 'no recorded pid or session id' }
  const records = probe.sessionRecords(agent.configDir === undefined ? [] : [agent.configDir])
  if (records.length === 0) return { dead: false, reason: 'no Claude Code session records to read' }
  const verdicts = records.filter(r => r.sessionId === agent.sessionId).map(r => sessionPidLiveness(r, probe))
  const running = verdicts.find(v => !v.dead)
  if (running) return running
  return (
    verdicts[0] ?? { dead: true, reason: `no running Claude Code process holds session ${agent.sessionId}` }
  )
}

export const agentLiveness = (agent: AgentIdentity, probe: ProcessProbe): Liveness =>
  launcherPid(agent.agentId) === undefined
    ? sessionLiveness(agent, probe)
    : launcherLiveness(agent.agentId, probe)

/** A detached agent, spawned or adopted, whose exit is not yet on the log. */
export const awaitsExit = (agent: AgentIdentity | undefined): agent is AgentIdentity =>
  agent?.state === 'detached' && agent.exitedAt === undefined

/** Rows a previous broker left detached, at the moment this one starts. */
export const detachedAtStart = (roster: readonly AgentIdentity[]): AgentIdentity[] =>
  roster.filter(awaitsExit)

/** CC-476: rows probed per event-loop turn, so a boot backlog cannot starve the socket. */
export const REAP_BATCH = 25

/** One read of the session records per batch, however many rows in it ask. */
export function batchProbe(probe: ProcessProbe): ProcessProbe {
  const records = new Map<string, SessionRecord[]>()
  return {
    ...probe,
    sessionRecords: extraDirs => {
      const key = extraDirs.join('\0')
      const cached = records.get(key) ?? probe.sessionRecords(extraDirs)
      records.set(key, cached)
      return cached
    },
  }
}

/**
 * Timers per unwatched agent: one settle window after a detach, then one probe.
 * A reattach cancels; a probe that cannot prove death leaves the row as it was.
 * Due probes queue and run `REAP_BATCH` at a time, yielding between batches.
 */
export class DetachedReaper {
  private readonly pending = new Map<string, NodeJS.Timeout>()
  private readonly due = new Set<string>()
  private drain: NodeJS.Timeout | undefined

  constructor(
    private readonly settleMs: number,
    private readonly probe: ProcessProbe,
    private readonly check: (agentId: string, probe: ProcessProbe) => void,
  ) {}

  schedule(agentId: string): void {
    this.cancel(agentId)
    const timer = setTimeout(() => {
      this.pending.delete(agentId)
      this.due.add(agentId)
      this.drainSoon()
    }, this.settleMs)
    timer.unref?.()
    this.pending.set(agentId, timer)
  }

  cancel(agentId: string): void {
    clearTimeout(this.pending.get(agentId))
    this.pending.delete(agentId)
    this.due.delete(agentId)
  }

  close(): void {
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    this.due.clear()
    clearTimeout(this.drain)
    this.drain = undefined
  }

  /** Runs now unless a batch ran this turn; then the rest waits for the next turn. */
  private drainSoon(): void {
    if (this.drain === undefined) this.runBatch()
  }

  private runBatch(): void {
    const batch = [...this.due].slice(0, REAP_BATCH)
    const probe = batchProbe(this.probe)
    for (const agentId of batch) {
      this.due.delete(agentId)
      this.check(agentId, probe)
    }
    this.drain = setTimeout(() => {
      this.drain = undefined
      if (this.due.size > 0) this.runBatch()
    }, 0)
    this.drain.unref?.()
  }
}
