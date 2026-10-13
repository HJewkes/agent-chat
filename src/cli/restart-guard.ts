import { ATTACH_CEILING_MS } from '../agents/supervisor.js'
import { stuckSpawns } from '../broker/doctor.js'
import type { AgentIdentity, ReplyType, ServerMessage } from '../protocol.js'
import { REPLY_TIMEOUT_MS, type BrokerClient } from '../client/broker-client.js'

/**
 * What a running broker would lose on a restart that nothing can recover (CC-104).
 * An open ask is not here: it is a row in events.db, and its asker is pushed the
 * answer when it re-registers (CC-1140).
 */
export interface RestartBlockers {
  spawning: string[]
}

/** The read the guard needs, so tests can answer it without a broker. */
export interface BlockerSource {
  agents(): Promise<AgentIdentity[]>
}

/**
 * Pure. A spawn older than the attach ceiling is excluded: its supervisor wait
 * already died with an earlier broker, so a restart cannot lose it again.
 */
export function restartBlockers(agents: AgentIdentity[], now: number): RestartBlockers {
  const stuck = new Set(stuckSpawns(agents, now, ATTACH_CEILING_MS).map(a => a.agentId))
  return {
    spawning: agents.filter(a => a.state === 'spawning' && !stuck.has(a.agentId)).map(a => a.name),
  }
}

export function refusalMessage(verb: string, blockers: RestartBlockers): string | null {
  const lines: string[] = []
  if (blockers.spawning.length > 0) lines.push(`  mid-spawn: ${blockers.spawning.join(', ')}`)
  if (lines.length === 0) return null
  return [
    `refusing to ${verb}: the broker would lose work in flight.`,
    ...lines,
    `Use --force to ${verb} anyway.`,
  ].join('\n')
}

/** broker-client's default reply timeout, for the frames `REPLY_TIMEOUT_MS` leaves out. */
const DEFAULT_REPLY_MS = 5_000

const replySeconds = (frame: ReplyType): number =>
  Math.round((REPLY_TIMEOUT_MS[frame] ?? DEFAULT_REPLY_MS) / 1000)

/** A broker that does not answer is refused like a busy one: nothing was sent that changes it (CC-1182). */
export function noAnswerMessage(verb: string, frame: ReplyType, seconds: number): string {
  return (
    `refusing to ${verb}: the broker did not answer ${frame} within ${seconds}s; ` +
    `the broker was not touched. Retry, or use --force to ${verb} anyway.`
  )
}

/** The same refusal for a broker the guard could not reach at all. */
export function unreachableMessage(verb: string, reason: string): string {
  return (
    `refusing to ${verb}: the broker did not answer the guard (${reason}); ` +
    `the broker was not touched. Retry, or use --force to ${verb} anyway.`
  )
}

type Read<T> = { ok: true; value: T } | { ok: false; refusal: string }

async function read<T>(verb: string, frame: ReplyType, fetch: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await fetch() }
  } catch {
    return { ok: false, refusal: noAnswerMessage(verb, frame, replySeconds(frame)) }
  }
}

/** The refusal to print, or null when `verb` may go ahead. */
export async function guardRestart(
  verb: string,
  source: BlockerSource,
  options: { force?: boolean; now?: number } = {},
): Promise<string | null> {
  if (options.force) return null
  const agents = await read(verb, 'agents_result', () => source.agents())
  if (!agents.ok) return agents.refusal
  return refusalMessage(verb, restartBlockers(agents.value, options.now ?? Date.now()))
}

/** The live source: the broker's own socket, which already serves the read. */
export function brokerSource(broker: BrokerClient): BlockerSource {
  return {
    agents: async () =>
      (
        (await broker.request({ t: 'agents' }, 'agents_result')) as Extract<
          ServerMessage,
          { t: 'agents_result' }
        >
      ).agents,
  }
}
