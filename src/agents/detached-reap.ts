import { isProcessAlive } from '../broker/lifecycle.js'
import { psArgvReader, type ArgvReader } from '../broker/host-channels.js'
import type { AgentIdentity } from '../protocol.js'
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
 * which lives exactly as long as the claude it started). A visible agent, or a
 * launch that failed before its handle was written, has none and is never reaped.
 */

export interface ProcessProbe {
  isAlive: (pid: number) => boolean
  readArgv: ArgvReader
}

export const hostProbe: ProcessProbe = { isAlive: isProcessAlive, readArgv: psArgvReader }

export type Liveness = { dead: true; pid: number; reason: string } | { dead: false; reason: string }

/** The launcher's own argv: `<node> <cli> run-agent <id>`. */
const runsAgent = (argv: string, agentId: string): boolean =>
  argv.split(/\s+/).some((word, i, words) => word === 'run-agent' && words[i + 1] === agentId)

export function launcherLiveness(agentId: string, probe: ProcessProbe): Liveness {
  const pid = readRuntimeState(agentId)?.handle.pid
  if (pid === undefined) return { dead: false, reason: 'no recorded pid' }
  if (!probe.isAlive(pid)) return { dead: true, pid, reason: `launcher pid ${pid} is gone` }
  const argv = probe.readArgv(pid)
  if (argv === undefined) return { dead: false, reason: `pid ${pid} is alive and its argv is unreadable` }
  if (runsAgent(argv, agentId)) return { dead: false, reason: `launcher pid ${pid} is running` }
  return { dead: true, pid, reason: `pid ${pid} was reused by another process` }
}

/** A detached spawned agent whose exit is not yet on the log; a detach can land after a recorded exit. */
export const awaitsExit = (agent: AgentIdentity | undefined): agent is AgentIdentity =>
  agent?.origin === 'spawned' && agent.state === 'detached' && agent.exitedAt === undefined

/** Rows a previous broker left detached, at the moment this one starts. */
export const detachedAtStart = (roster: readonly AgentIdentity[]): AgentIdentity[] =>
  roster.filter(awaitsExit)

/**
 * Timers per unwatched agent: one settle window after a detach, then one probe.
 * A reattach cancels; a probe that cannot prove death leaves the row as it was.
 */
export class DetachedReaper {
  private readonly pending = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly settleMs: number,
    private readonly check: (agentId: string) => void,
  ) {}

  schedule(agentId: string): void {
    this.cancel(agentId)
    const timer = setTimeout(() => {
      this.pending.delete(agentId)
      this.check(agentId)
    }, this.settleMs)
    timer.unref?.()
    this.pending.set(agentId, timer)
  }

  cancel(agentId: string): void {
    clearTimeout(this.pending.get(agentId))
    this.pending.delete(agentId)
  }

  close(): void {
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
  }
}
