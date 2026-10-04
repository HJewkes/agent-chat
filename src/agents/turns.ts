import {
  claudeSourceFromPath,
  readRecentSessionTurnsSync,
  type RecentSessionTurn,
  type RecentSessionTurns,
} from '@titan-design/session-read'
import { findTranscript, type Transcript } from './transcript.js'

/**
 * Reading the recent turns of a Claude Code session's own transcript — CC-19.
 *
 * WHAT THIS IS PERMITTED TO DO, decided by the human on 2026-07-27 and encoded
 * here rather than left to convention: cross-session transcript reading is
 * permitted freely. Any session on this machine may read any other's, and there
 * is no opt-in, no consent handshake and no same-project restriction in this
 * module or in the tool that calls it. The trust boundary is the OS account, as
 * it is for the socket (`paths.ts`) — a process that can read this file could
 * read `~/.claude/projects` directly with no help from us.
 *
 * DO NOT reintroduce a gate here believing one already exists. An earlier design
 * note claimed publishing the session id at registration would be a natural
 * opt-in, on the reasoning that the broker knows pid and cwd but not the session
 * id, so a session must volunteer it. That is FALSE and was checked: every MCP
 * subprocess already holds `CLAUDE_CODE_SESSION_ID` in its own environment and
 * `hostIdentity()` sends it on every `register`, with no model involvement at
 * all (`server/host.ts`). The asymmetry the note relied on does not exist. If
 * anyone later wants transcript sharing to be opt-in, it has to be built as an
 * explicit refusal somewhere — not assumed to fall out of what the registry
 * happens to know.
 *
 * `denials.ts` reads the same files for a different question; this one is the
 * conversation itself, not the errors in it.
 */
export interface Turn {
  role: 'user' | 'assistant' | 'system'
  /** ISO timestamp as Claude Code wrote it, or '' when the row carried none. */
  at: string
  text: string
  /** A subagent's turn (`isSidechain`), not the session's own thread. */
  sidechain: boolean
}

export interface TranscriptRead {
  transcript: Transcript
  turns: Turn[]
  /** From the newest row that carried one — transcripts record cwd and gitBranch per row. */
  branch?: string
}

/**
 * Enough tail to cover a couple of dozen turns of a busy session without
 * reading a multi-megabyte file. Tool results are the bulk of it.
 */
const TURN_TAIL_BYTES = 1024 * 1024

/** Per-turn cap, so one enormous tool result cannot fill the caller's context. */
const TURN_CHARS = 700

const toTurn = (turn: RecentSessionTurn): Turn => ({
  role: turn.role,
  at: turn.timestamp ?? '',
  text: turn.text,
  sidechain: turn.sidechain ?? false,
})

/** session-read throws `TypeError` on a window that names another session; that is an empty read here. */
function readRecent(transcriptPath: string, limit: number): RecentSessionTurns | undefined {
  try {
    return readRecentSessionTurnsSync(claudeSourceFromPath(transcriptPath, 'local'), {
      maxBytes: TURN_TAIL_BYTES,
      maxTurns: limit,
      maxCharsPerTurn: TURN_CHARS,
    })
  } catch (error) {
    if (error instanceof TypeError) return undefined
    throw error
  }
}

/**
 * The most recent `limit` turns of a session's transcript.
 *
 * A missing transcript is a normal answer, not an error: the file belongs to
 * another program and may be absent (`--no-session-persistence`), reaped
 * (`cleanupPeriodDays`) or simply not written yet.
 */
export function readTurns(cwd: string, sessionId: string, limit: number, dir?: string): TranscriptRead {
  const transcript = findTranscript(cwd, sessionId, dir)
  if (!transcript.exists) return { transcript, turns: [] }

  const recent = readRecent(transcript.path, limit)
  if (recent === undefined || recent.status === 'unavailable') return { transcript, turns: [] }

  const turns = recent.turns.map(toTurn)
  return recent.branch.status === 'observed'
    ? { transcript, turns, branch: recent.branch.value }
    : { transcript, turns }
}

/** Long enough for a full agent report, which a brief caps at 15 lines. */
const REPORT_CHARS = 20_000

/**
 * The last assistant message of a session's own thread, which is where a
 * headless agent leaves its report. Undefined when there is no transcript or
 * no such message yet.
 */
export function finalAssistantText(cwd: string, sessionId: string, dir?: string): string | undefined {
  const transcript = findTranscript(cwd, sessionId, dir)
  if (!transcript.exists) return undefined
  let recent: RecentSessionTurns
  try {
    recent = readRecentSessionTurnsSync(claudeSourceFromPath(transcript.path, 'local'), {
      maxBytes: TURN_TAIL_BYTES,
      maxTurns: 20,
      maxCharsPerTurn: REPORT_CHARS,
      projection: 'text',
    })
  } catch (error) {
    if (error instanceof TypeError) return undefined
    throw error
  }
  const own = recent.turns.filter(t => t.role === 'assistant' && t.sidechain !== true && t.kind === 'message')
  return own.at(-1)?.text
}

/**
 * What a stall check needs from a transcript (CC-653): when the agent last made
 * progress, and the tool call it is waiting on, if any. `lastAt` is absent when
 * the window holds no progress row at all.
 */
export type Activity = { lastAt?: string; pending?: { tool: string; at: string } }

/**
 * Rows that show the agent itself moving. A `user/message` is a delivery, hook,
 * reminder or resume and a `system` row is the harness, so neither counts.
 */
const isProgress = (turn: RecentSessionTurn): boolean =>
  turn.timestamp !== null &&
  ((turn.role === 'assistant' && (turn.kind === 'message' || turn.kind === 'tool_call')) ||
    (turn.role === 'user' && turn.kind === 'tool_result'))

/** session-read renders a call as `[tool <Name>] <input>`; `?` when a longer block ahead of it leaves no marker inside the 80-char cap. */
const toolName = (text: string): string => /\[tool (?!result)([^\]\s]+)\]/.exec(text)?.[1] ?? '?'

/**
 * Tools an agent calls to wait rather than to work (CC-659), matched by MCP
 * suffix so every plugin prefix counts: a poll loop must not read as progress.
 */
export const POLL_TOOLS: ReadonlySet<string> = new Set([
  'chat_inbox',
  'chat_status',
  'chat_list',
  'chat_activity',
  'agent_list',
  'session_budget',
])

/** session-read renders a Bash call's input as JSON, so a sleep is a command that starts `sleep`. */
const SLEEP_CALL = /^\[tool Bash\] \{"command":"\s*sleep\b/

const isPollCall = (turn: RecentSessionTurn): boolean =>
  POLL_TOOLS.has(toolName(turn.text).split('__').at(-1) ?? '') || SLEEP_CALL.test(turn.text)

/** Drops poll calls and the results that close them, pairing results with calls oldest first as `openCalls` does. */
function withoutPolling(progress: readonly RecentSessionTurn[]): RecentSessionTurn[] {
  const kept: RecentSessionTurn[] = []
  const openIsPoll: boolean[] = []
  for (const turn of progress) {
    if (turn.kind === 'tool_call') {
      const poll = isPollCall(turn)
      openIsPoll.push(poll)
      if (!poll) kept.push(turn)
    } else if (turn.kind !== 'tool_result' || openIsPoll.shift() !== true) kept.push(turn)
  }
  return kept
}

/** Any failed read is "could not tell" for a stall check, never a crash of the tick that asked. */
function readActivityTurns(transcriptPath: string): RecentSessionTurns | undefined {
  try {
    return readRecentSessionTurnsSync(claudeSourceFromPath(transcriptPath, 'local'), {
      maxBytes: TURN_TAIL_BYTES,
      maxTurns: 50,
      maxCharsPerTurn: 80,
      projection: 'activity',
    })
  } catch {
    return undefined
  }
}

/** The newest progress row of a session's transcript, and its open tool call when that row is one. */
export function readActivity(
  cwd: string,
  sessionId: string,
  dir?: string,
): Activity | 'missing' | 'unreadable' {
  const transcript = findTranscript(cwd, sessionId, dir)
  if (!transcript.exists) return 'missing'
  const recent = readActivityTurns(transcript.path)
  if (recent === undefined || recent.status === 'unavailable') return 'unreadable'

  const progress = withoutPolling(recent.turns.filter(isProgress))
  const lastAt = progress.at(-1)?.timestamp
  if (lastAt === null || lastAt === undefined) return {}
  const open = openCalls(progress)
  return open[0] === undefined
    ? { lastAt }
    : { lastAt, pending: { tool: toolName(open[0].text), at: open[0].timestamp ?? lastAt } }
}

/**
 * Calls still awaiting a result. session-read exposes no tool_use id, so each
 * result closes the oldest open call: parallel calls A, B then result A leave B open.
 */
function openCalls(progress: readonly RecentSessionTurn[]): RecentSessionTurn[] {
  const open: RecentSessionTurn[] = []
  for (const turn of progress) {
    if (turn.kind === 'tool_call') open.push(turn)
    else if (turn.kind === 'tool_result') open.shift()
  }
  return open
}
