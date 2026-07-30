import { findTranscript, readTail, type Transcript } from './transcript.js'

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

type Row = Record<string, unknown>

const isRecord = (value: unknown): value is Row => typeof value === 'object' && value !== null

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * Every field below is external data: Claude Code writes these files, this
 * codebase does not, and the format is undocumented and free to change. So each
 * row is narrowed rather than cast (CC-8), and anything unrecognised is skipped
 * instead of being rendered as `undefined` at the caller.
 */
function roleOf(row: Row): Turn['role'] | undefined {
  const type = row.type
  return type === 'user' || type === 'assistant' || type === 'system' ? type : undefined
}

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}… (${value.length - max} more chars)`

/** One line per content block, named by kind so a reader can tell text from tooling. */
function renderBlock(block: unknown): string {
  if (typeof block === 'string') return block
  if (!isRecord(block)) return ''
  switch (block.type) {
    case 'text':
      return str(block.text)
    // Deliberately summarised, not reproduced. Reading a peer's reasoning verbatim
    // is permitted, but it is the least summarisable and most voluminous part of a
    // transcript, and this tool exists to answer "what has it been doing".
    case 'thinking':
      return `[thinking, ${str(block.thinking).length} chars]`
    case 'tool_use':
      return `[tool ${str(block.name) || '?'}] ${truncate(oneLine(JSON.stringify(block.input ?? {})), 200)}`
    case 'tool_result':
      return `[tool result${block.is_error === true ? ', error' : ''}] ${truncate(renderContent(block.content), 300)}`
    case 'image':
      return '[image]'
    default:
      return typeof block.type === 'string' ? `[${block.type}]` : ''
  }
}

function renderContent(content: unknown): string {
  if (typeof content === 'string') return oneLine(content)
  if (!Array.isArray(content)) return ''
  return content.map(renderBlock).filter(Boolean).join('\n')
}

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim()

function toTurn(row: Row): Turn | undefined {
  const role = roleOf(row)
  if (role === undefined) return undefined
  const message = isRecord(row.message) ? row.message : undefined
  // A system row carries its body at the top level; user and assistant rows carry
  // it under `message`. Neither shape is guaranteed, hence both are optional.
  const body = message === undefined ? renderContent(row.content) : renderContent(message.content)
  if (body.trim() === '') return undefined
  return {
    role,
    at: str(row.timestamp),
    text: truncate(body, TURN_CHARS),
    sidechain: row.isSidechain === true,
  }
}

/**
 * The most recent `limit` turns of a session's transcript.
 *
 * A missing transcript is a normal answer, not an error: the file belongs to
 * another program and may be absent (`--no-session-persistence`), reaped
 * (`cleanupPeriodDays`) or simply not written yet.
 */
export function readTurns(cwd: string, sessionId: string, limit: number): TranscriptRead {
  const transcript = findTranscript(cwd, sessionId)
  if (!transcript.exists) return { transcript, turns: [] }

  const tail = readTail(transcript.path, TURN_TAIL_BYTES)
  if (tail === undefined) return { transcript, turns: [] }

  const lines = tail.split('\n')
  // Skip line 0 when we read from an offset: it is usually half a row (readTail).
  const from = tail.length < TURN_TAIL_BYTES ? 0 : 1
  const turns: Turn[] = []
  let branch: string | undefined

  for (let at = from; at < lines.length; at++) {
    const line = lines[at] ?? ''
    if (line.trim() === '') continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue // a partially flushed final line is normal on a live tail
    }
    if (!isRecord(row)) continue
    if (typeof row.gitBranch === 'string' && row.gitBranch !== '') branch = row.gitBranch
    const turn = toTurn(row)
    if (turn !== undefined) turns.push(turn)
  }

  return { transcript, turns: turns.slice(-limit), ...(branch === undefined ? {} : { branch }) }
}
