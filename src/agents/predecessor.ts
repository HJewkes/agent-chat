import type { EventStore } from '../broker/event-store.js'
import { HUMAN, type AgentIdentity, type QueueItem } from '../protocol.js'
import type { AgentLog } from './identity.js'
import { identityTranscript, type TranscriptVerdict } from './resume-session.js'

/**
 * CC-133: a follow-up assignment handed to a FRESH worker instead of the one
 * that did the first piece.
 *
 * A worker past its first report carries a large context into every later turn,
 * and each request costs in proportion to it. The successor needs only what the
 * predecessor would otherwise have been asked to remember: what it last
 * reported, where its work sits on disk, and where its conversation is if the
 * detail matters. All three are already in the log, so the coordinator names the
 * predecessor and the broker fills them in.
 *
 * Only the agent's own spawner (or the human) may name it. The section copies
 * the predecessor's last message into a brief the requester writes the rest of,
 * so any other caller could use it to read a peer's traffic.
 */

/** Longer reports are cut: the successor can read the transcript for the rest. */
const REPORT_MAX = 3_000

export interface PredecessorFacts {
  agent: AgentIdentity
  report?: QueueItem
  branch?: string
  worktree?: string
  /** True when retire already removed the worktree, so the path is history rather than a place. */
  worktreeReleased: boolean
  transcript: TranscriptVerdict
}

export type PredecessorResult = { text: string; warning?: string } | { error: string }

/** The newest spawned identity that held `name`, retired or not. */
function identityNamed(agents: AgentLog, name: string): AgentIdentity | undefined {
  return agents.roster({ includeRetired: true }).find(a => a.name === name && a.origin === 'spawned')
}

/** Branch and worktree from the log, which outlives the runtime file retire deletes. */
function isolationOf(
  events: EventStore,
  agentId: string,
): Pick<PredecessorFacts, 'branch' | 'worktree' | 'worktreeReleased'> {
  const rows = events.agentEvents().filter(row => row.ref === agentId)
  const allocated = rows.find(row => row.kind === 'isolation_allocated')?.meta ?? {}
  return {
    ...(allocated.branch ? { branch: allocated.branch } : {}),
    ...(allocated.worktree ? { worktree: allocated.worktree } : {}),
    worktreeReleased: rows.some(row => row.kind === 'isolation_released'),
  }
}

/** Its last message to its spawner, or failing that to anyone, since it was spawned. */
function lastReport(events: EventStore, agent: AgentIdentity): QueueItem | undefined {
  const since = agent.spawnedAt
  return (
    events.lastMessageFrom(agent.name, { to: agent.spawnedBy, since }) ??
    events.lastMessageFrom(agent.name, { since })
  )
}

export function predecessorFacts(events: EventStore, agent: AgentIdentity): PredecessorFacts {
  const report = lastReport(events, agent)
  return {
    agent,
    ...(report ? { report } : {}),
    ...isolationOf(events, agent.agentId),
    transcript: identityTranscript(agent),
  }
}

const clipped = (text: string): string =>
  text.length <= REPORT_MAX
    ? text
    : `${text.slice(0, REPORT_MAX)}\n\n… (cut at ${REPORT_MAX} characters; the transcript has the rest)`

function reportBlock(facts: PredecessorFacts): string {
  const { report, agent } = facts
  if (report === undefined)
    return `${agent.name} sent no message after it was spawned, so there is no report to carry.`
  const to = report.meta.target ?? 'unknown'
  const when = new Date(report.at).toISOString()
  return `Its last report (to ${to}, ${when}):\n\n${clipped(report.text.trim())}`
}

function locationLines(facts: PredecessorFacts): string[] {
  const { agent, branch, worktree, worktreeReleased, transcript } = facts
  const place = worktree
    ? `${worktree}${worktreeReleased ? ' (removed when it was retired)' : ''}`
    : agent.cwd
  return [
    `- State: ${agent.state}`,
    `- Branch: ${branch ?? 'none recorded (it did not run in a worktree of its own)'}`,
    `- Worked in: ${place}`,
    `- Session id: ${agent.sessionId || 'none recorded'}`,
    `- Transcript: ${transcript.found ? transcript.path : `not found (looked at ${transcript.path})`}`,
  ]
}

/** The briefing section a successor reads before its assignment. */
export function predecessorSection(facts: PredecessorFacts): string {
  return [
    `# Predecessor: ${facts.agent.name}`,
    `You are taking over from ${facts.agent.name}. Your coordinator did not write this section: the ` +
      'broker read it from the event log. Start from the report and the branch below rather than ' +
      'redoing its work, and read the transcript only for detail the report leaves out.',
    locationLines(facts).join('\n'),
    reportBlock(facts),
  ].join('\n\n')
}

const unretiredWarning = (agent: AgentIdentity): string =>
  `predecessor ${agent.name} is ${agent.state}, not retired. Retire or park it once the successor ` +
  'registers; nothing retires it automatically.'

/** The section for `name`, a refusal when it is not the requester's to hand over, or unknown. */
export function resolvePredecessor(
  agents: AgentLog,
  events: EventStore,
  name: string,
  requestedBy: string,
): PredecessorResult {
  const agent = identityNamed(agents, name)
  if (agent === undefined) return { error: `no spawned agent named "${name}" to take over from` }
  if (requestedBy !== HUMAN && agent.spawnedBy !== requestedBy)
    return {
      error:
        `${name} was spawned by ${agent.spawnedBy}, not by you. Only its own spawner can hand its work ` +
        'to a successor, because the section copies its last report into the new brief.',
    }
  const text = predecessorSection(predecessorFacts(events, agent))
  return agent.state === 'retired' ? { text } : { text, warning: unretiredWarning(agent) }
}
