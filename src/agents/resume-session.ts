import fs from 'node:fs'
import path from 'node:path'
import type { AgentEventRow } from '../broker/event-store.js'
import type { AgentIdentity, IsolationName } from '../protocol.js'
import type { WorktreeRecord } from './isolation/worktree.js'
import { findTranscript, transcriptPath } from './transcript.js'

/**
 * CC-126: bringing an agent back WITH its conversation.
 *
 * Two routes, because retire is absorbing. An agent that finished or detached
 * still holds its identity and name, so `agent_resume` relaunches that identity
 * on `--resume`. A retired one has given its name up, so it comes back as a new
 * identity through `agent_spawn` with `resume_session`, which is why retire
 * records the session id and transcript path on its row.
 *
 * Durable identity is not durable context: `--resume` replays a transcript
 * Claude Code owns and may have reaped. Every outcome therefore says whether
 * the transcript was found, and a missing one is refused rather than launched,
 * since `claude --resume` on an unknown id exits without doing anything.
 */

/** What the caller is told about the conversation it asked for. */
export interface TranscriptVerdict {
  path: string
  found: boolean
}

/** The turn a headless resume starts on when the coordinator sent nothing to say. */
export const RESUMED_BRIEF = [
  'You have been resumed by agent-chat on your existing conversation, after your process had stopped.',
  'Your name and identity are unchanged. Check your inbox with chat_inbox for anything that arrived',
  'while you were stopped, then continue the work or report where it stands over agent-chat.',
].join(' ')

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const verdictLine = (t: TranscriptVerdict): string =>
  t.found ? `transcript found: ${t.path}` : `no transcript found at ${t.path}`

/** The transcript an existing identity would resume, found wherever Claude Code actually wrote it. */
export function identityTranscript(agent: AgentIdentity): TranscriptVerdict {
  const found = findTranscript(agent.cwd, agent.sessionId, agent.configDir)
  return { path: found.path, found: found.exists }
}

/**
 * CC-283: the newest record of agent-chat allocating the tree at `worktree`, as
 * an adopted record, so an agent that adopted it can re-create it once removed.
 */
export function allocationRecord(
  rows: readonly AgentEventRow[],
  worktree: string,
): WorktreeRecord | undefined {
  const at = path.resolve(worktree)
  const meta = rows.findLast(
    row =>
      row.kind === 'isolation_allocated' &&
      row.meta.strategy === 'worktree' &&
      row.meta.assigned !== 'true' &&
      row.meta.worktree === at,
  )?.meta
  if (!meta?.gitRoot || !meta.branch || !fs.existsSync(meta.gitRoot)) return undefined
  return { gitRoot: meta.gitRoot, worktree: at, branch: meta.branch, adopted: true }
}

/**
 * CC-140: the worktree an agent ran in, when it is gone from disk and agent-chat created it.
 *
 * An assigned worktree comes back only from its allocator's record (CC-283);
 * one the task system made has none, so it is never re-created here.
 */
export function goneWorktree(rows: readonly AgentEventRow[], agentId: string): WorktreeRecord | undefined {
  const meta = rows.findLast(row => row.kind === 'isolation_allocated' && row.ref === agentId)?.meta
  if (meta?.strategy !== 'worktree') return undefined
  if (meta.assigned === 'true')
    return meta.worktree && !fs.existsSync(meta.worktree) ? allocationRecord(rows, meta.worktree) : undefined
  const { gitRoot, worktree, branch } = meta
  if (!gitRoot || !worktree || !branch || fs.existsSync(worktree) || !fs.existsSync(gitRoot)) return undefined
  return { gitRoot, worktree, branch }
}

/** The removed worktree of the newest retired agent that ran this session, if there is one to re-create. */
export function retiredWorktree(
  retired: readonly AgentIdentity[],
  rows: readonly AgentEventRow[],
  sessionId: string,
): WorktreeRecord | undefined {
  const owner = retired
    .filter(a => a.state === 'retired' && a.sessionId === sessionId)
    .sort((a, b) => b.lastEventAt - a.lastEventAt)[0]
  return owner === undefined ? undefined : goneWorktree(rows, owner.agentId)
}

/** Why an identity cannot be resumed, or undefined when it can. `reattach` says its gone worktree can come back. */
export function resumeBlocker(
  agent: AgentIdentity,
  transcript: TranscriptVerdict,
  reattach?: WorktreeRecord,
): string | undefined {
  if (agent.state === 'live') return `${agent.name} is already live; message it instead`
  if (agent.sessionId === '')
    return `${agent.name} has no recorded session id, so there is no conversation to resume`
  if (!transcript.found)
    return `${agent.name}'s transcript is gone, so it would come back with no conversation`
  if (reattach === undefined && !fs.existsSync(agent.cwd))
    return `${agent.name}'s working directory ${agent.cwd} no longer exists. Not resumed`
  return undefined
}

/** The refusal for a name nothing live holds, pointing a retired one at the spawn route. */
export function missingAgent(
  name: string,
  retired: AgentIdentity | undefined,
  gone?: WorktreeRecord,
): string {
  if (retired === undefined) return `no agent named "${name}"`
  const where =
    gone === undefined
      ? `cwd="${retired.cwd}"`
      : `isolation="worktree" and cwd="${gone.gitRoot}"; its removed worktree ${gone.worktree} is re-created`
  return (
    `${name} was retired, which gave up its name. Its session was ${retired.sessionId}; bring it back ` +
    `as a new agent with agent_spawn resume_session="${retired.sessionId}" and ${where}`
  )
}

export interface ResumeSessionInput {
  resumeSession: string
  inherit?: 'context'
  worktree?: string
  /** CC-140: a retired agent's removed worktree, re-created at launch, so its path is where the transcript is. */
  reattach?: WorktreeRecord
  isolation: IsolationName
  cwd: string
  configDir: string
}

/**
 * Where a spawn's `resume_session` transcript must be, or why it cannot be used.
 *
 * `claude --resume <id>` looks only in the project dir of the cwd it starts in,
 * so the check is the exact derived path rather than a scan. A fresh worktree
 * cannot hold the transcript by construction, so that combination is refused.
 */
export function checkResumeSession(input: ResumeSessionInput): { path: string } | { error: string } {
  const { resumeSession: id } = input
  if (!SESSION_UUID.test(id)) return { error: `resume_session must be a Claude session uuid, got "${id}"` }
  if (input.inherit !== undefined)
    return { error: 'resume_session and inherit: "context" both choose the conversation; pass one' }
  if (input.isolation === 'worktree' && input.worktree === undefined && input.reattach === undefined)
    return {
      error:
        'resume_session cannot run in a freshly allocated worktree: the transcript lives under the ' +
        'directory the session ran in. Pass worktree=<that directory> or isolation "none"',
    }
  const runsIn = input.reattach?.worktree ?? input.worktree ?? input.cwd
  const path = transcriptPath(runsIn, id, input.configDir)
  if (!fs.existsSync(path))
    return { error: `no transcript found at ${path} for resume_session ${id}. Not spawned` }
  return { path }
}

/** The reply to a resume, shared by the MCP tool and the CLI so both say the same thing. */
export function describeResume(
  name: string,
  res: { ok: boolean; reason?: string; transcript?: TranscriptVerdict; warnings?: string[] },
): { ok: boolean; lines: string[] } {
  const verdict = [res.transcript === undefined ? 'transcript: not looked up' : verdictLine(res.transcript)]
  if (!res.ok) return { ok: false, lines: [`Not resumed: ${res.reason}`, ...verdict] }
  return {
    ok: true,
    lines: [
      `Resumed ${name} on its existing conversation, keeping its name. Reach it with chat_send.`,
      ...verdict,
      ...(res.warnings ?? []).map(w => `warning: ${w}`),
    ],
  }
}
