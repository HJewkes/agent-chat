import { ATTACH_CEILING_MS } from '../agents/supervisor.js'
import { stuckSpawns } from '../broker/doctor.js'
import type { AgentIdentity, QueueItem, ServerMessage } from '../protocol.js'
import type { BrokerClient } from '../client/broker-client.js'

/** What a running broker would lose on a restart that nothing can recover (CC-104). */
export interface RestartBlockers {
  spawning: string[]
  asks: { from: string; excerpt: string }[]
}

/** The two reads the guard needs, so tests can answer them without a broker. */
export interface BlockerSource {
  agents(): Promise<AgentIdentity[]>
  queue(): Promise<QueueItem[]>
}

const EXCERPT_CHARS = 60

const excerpt = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat
}

/**
 * Pure. A spawn older than the attach ceiling is excluded: its supervisor wait
 * already died with an earlier broker, so a restart cannot lose it again.
 */
export function restartBlockers(agents: AgentIdentity[], queue: QueueItem[], now: number): RestartBlockers {
  const stuck = new Set(stuckSpawns(agents, now, ATTACH_CEILING_MS).map(a => a.agentId))
  return {
    spawning: agents.filter(a => a.state === 'spawning' && !stuck.has(a.agentId)).map(a => a.name),
    asks: queue
      .filter(item => item.kind === 'question')
      .map(item => ({ from: item.from, excerpt: excerpt(item.text) })),
  }
}

export function refusalMessage(verb: string, blockers: RestartBlockers): string | null {
  const lines: string[] = []
  if (blockers.spawning.length > 0) lines.push(`  mid-spawn: ${blockers.spawning.join(', ')}`)
  for (const ask of blockers.asks) lines.push(`  unanswered ask from ${ask.from}: "${ask.excerpt}"`)
  if (lines.length === 0) return null
  return [
    `refusing to ${verb}: the broker would lose work in flight.`,
    ...lines,
    `Use --force to ${verb} anyway.`,
  ].join('\n')
}

/** The refusal to print, or null when `verb` may go ahead. */
export async function guardRestart(
  verb: string,
  source: BlockerSource,
  options: { force?: boolean; now?: number } = {},
): Promise<string | null> {
  if (options.force) return null
  const [agents, queue] = await Promise.all([source.agents(), source.queue()])
  return refusalMessage(verb, restartBlockers(agents, queue, options.now ?? Date.now()))
}

/** The live source: the broker's own socket, which already serves both reads. */
export function brokerSource(broker: BrokerClient): BlockerSource {
  return {
    agents: async () =>
      (
        (await broker.request({ t: 'agents' }, 'agents_result')) as Extract<
          ServerMessage,
          { t: 'agents_result' }
        >
      ).agents,
    queue: async () =>
      (
        (await broker.request({ t: 'queue' }, 'queue_result')) as Extract<
          ServerMessage,
          { t: 'queue_result' }
        >
      ).items,
  }
}
