import type { BrokerClient } from '../../client/broker-client.js'
import type { AgentIdentity } from '../../protocol.js'
import type { Liveness } from '../detached-reap.js'
import {
  briefText,
  burstFilter,
  detachedCandidates,
  noticeText,
  pickDetached,
  type DetachedAlertConfig,
  type DetachedCandidate,
} from './detached-alert.js'
import type { Notified } from './notified-state.js'
import type { WakeResult } from './run.js'

/**
 * The seat watchdog's detached sub-pass over explicit ports. It reads the roster and files at most one
 * human-queue notice; it never appends a row, so it cannot fight the reaper over an exit.
 */
export interface DetachedPorts {
  rules: DetachedAlertConfig
  roster(): Promise<AgentIdentity[]>
  /** Read-only liveness of a row on this host; the reaper owns any exit it implies. */
  probe(agent: AgentIdentity): Liveness
  loadState(): Notified
  saveState(notified: Notified): void
  notify(text: string): Promise<WakeResult>
  log(detail: Record<string, unknown>): void
}

const PREFIX = 'detached: '

/** Every candidate, and the ones that may page: local rows whose process is still alive, remote rows in a burst. */
async function readDue(
  ports: DetachedPorts,
  nowMs: number,
): Promise<{ all: DetachedCandidate[]; due: DetachedCandidate[] }> {
  const roster = await ports.roster()
  const byId = new Map(roster.map(a => [a.agentId, a]))
  const all = detachedCandidates(roster, ports.rules, nowMs)
  const alive = all.filter(c => {
    const agent = byId.get(c.agentId)
    return c.remote || (agent !== undefined && !ports.probe(agent).dead)
  })
  return { all, due: burstFilter(alive, ports.rules) }
}

function dryRunLines(
  all: DetachedCandidate[],
  due: DetachedCandidate[],
  rules: DetachedAlertConfig,
): string[] {
  const paged = new Set(due.map(c => c.agentId))
  const listed = all.filter(c => !paged.has(c.agentId))
  return [
    ...(due.length === 0 ? [] : [`${PREFIX}would notify: ${noticeText(due, rules)}`]),
    ...(listed.length === 0 ? [] : [`${PREFIX}listed, not paged: ${briefText(listed, rules)}`]),
    `${PREFIX}${all.length} candidates, ${due.length} would page (dry run; nothing sent)`,
  ]
}

export async function runDetachedAlert(
  ports: DetachedPorts,
  opts: { dryRun: boolean; nowMs: number },
): Promise<string[]> {
  if (!ports.rules.enabled) return [`${PREFIX}detachedAlert.enabled is false; nothing done`]
  const { all, due } = await readDue(ports, opts.nowMs)
  if (opts.dryRun) return dryRunLines(all, due, ports.rules)
  const picked = pickDetached(due, ports.rules, ports.loadState(), opts.nowMs)
  if (picked.notify.length > 0) {
    const sent = await ports.notify(noticeText(picked.notify, ports.rules))
    if (!sent.ok) return [`${PREFIX}notice failed: ${sent.detail}; state kept for the next pass`]
  }
  ports.saveState(picked.notified)
  ports.log({ candidates: all.length, due: due.length, noticed: picked.notify.length })
  return [`${PREFIX}${all.length} candidates, ${due.length} due, ${picked.notify.length} noticed`]
}

/** The roster through the one read-only frame the pass sends on the watchdog's connection. */
export const brokerRoster = (client: Pick<BrokerClient, 'request'>) => async (): Promise<AgentIdentity[]> => {
  const reply = await client.request({ t: 'agents' }, 'agents_result')
  return reply.t === 'agents_result' ? reply.agents : []
}
