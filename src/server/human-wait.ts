import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import type { BrokerClient } from '../client/broker-client.js'
import type { AgentIdentity, AgentLifecycle, QueueItem, ServerMessage } from '../protocol.js'
import { findTranscript } from '../agents/transcript.js'
import { parseLine, readTail } from '../agents/transcript-usage.js'

/**
 * Whether a session is idle on the human, read from its own transcript tail (CC-135 S2).
 *
 * A park notice is only worth sending to a session that is truly waiting. One that
 * is mid-episode (a tool still running, an edit not yet committed, a worker still
 * owed a report) would lose work by handing off, so every doubt reads as not
 * awaiting: `unknown` is never treated as a wait.
 */

export type MidEpisodeReason = 'open-tool' | 'partial-edit' | 'awaited-children'

export type WaitClass =
  | { kind: 'awaiting-ask' }
  | { kind: 'awaiting-turn-end' }
  | { kind: 'mid-episode'; reason: MidEpisodeReason }
  | { kind: 'unknown' }

type Rec = Record<string, unknown>

const ASK = 'AskUserQuestion'
const UNKNOWN: WaitClass = { kind: 'unknown' }
const EDIT_PATH_KEYS: Readonly<Record<string, string>> = {
  Edit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
}
/** Work that has landed in history: a commit, or a pull request opened from it. */
const LANDS_WORK = /\bgit\b[^\n|;&]*\bcommit\b|\bgh\s+pr\s+create\b/
const LIVE_STATES: ReadonlySet<AgentLifecycle> = new Set(['spawning', 'live'])
const CHILD_ACTIVITY_LIMIT = 200

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null
const mid = (reason: MidEpisodeReason): WaitClass => ({ kind: 'mid-episode', reason })

/** Pure: how the session's final turn stands, given the dirty paths and the children it still awaits. */
export function classifyWait(
  records: readonly unknown[],
  dirtyPaths: readonly string[],
  children: readonly string[],
): WaitClass {
  const turn = finalTurn(records)
  const last = turn.at(-1)
  if (last === undefined) return UNKNOWN
  const open = openToolNames(turn)
  if (open.some(name => name !== ASK)) return mid('open-tool')
  const dirty = new Set(dirtyPaths.map(p => path.resolve(p)))
  if (uncommittedEdits(turn).some(p => dirty.has(p))) return mid('partial-edit')
  if (children.length > 0) return mid('awaited-children')
  if (open.length > 0) return { kind: 'awaiting-ask' }
  const stop = (last.message as Rec).stop_reason
  return last.type === 'assistant' && stop === 'end_turn' ? { kind: 'awaiting-turn-end' } : UNKNOWN
}

/** Parse a transcript tail; a cut or garbled line is dropped rather than guessed at. */
export function recordsOf(tail: string): Rec[] {
  return tail.split('\n').flatMap(line => {
    const record = parseLine(line)
    return record === undefined ? [] : [record]
  })
}

/** Bookkeeping, hook caveats and subagent turns say nothing about the main conversation. */
const isTurnRecord = (r: unknown): r is Rec =>
  isRecord(r) &&
  (r.type === 'user' || r.type === 'assistant') &&
  r.isSidechain !== true &&
  r.isMeta !== true &&
  isRecord(r.message)

const blocksOf = (r: Rec): Rec[] => {
  const content = (r.message as Rec).content
  return Array.isArray(content) ? content.filter(isRecord) : []
}

/** A user record carrying anything but tool results is a new prompt, so it opens a turn. */
const opensTurn = (r: Rec): boolean => r.type === 'user' && !blocksOf(r).some(b => b.type === 'tool_result')

function finalTurn(records: readonly unknown[]): Rec[] {
  const turn = records.filter(isTurnRecord)
  const start = turn.findLastIndex(opensTurn)
  return start < 0 ? turn : turn.slice(start)
}

const blocksOfType = (turn: Rec[], type: string): Rec[] =>
  turn.flatMap(blocksOf).filter(block => block.type === type)

function openToolNames(turn: Rec[]): string[] {
  const answered = new Set(blocksOfType(turn, 'tool_result').map(b => b.tool_use_id))
  return blocksOfType(turn, 'tool_use')
    .filter(use => !answered.has(use.id))
    .map(use => String(use.name))
}

/** Paths the turn edited after its last commit; a commit clears only what came before it. */
function uncommittedEdits(turn: Rec[]): string[] {
  let edited: string[] = []
  for (const use of blocksOfType(turn, 'tool_use')) {
    const input = isRecord(use.input) ? use.input : {}
    const key = EDIT_PATH_KEYS[String(use.name)]
    const target = key === undefined ? undefined : input[key]
    if (typeof target === 'string') edited.push(path.resolve(target))
    if (use.name === 'Bash' && typeof input.command === 'string' && LANDS_WORK.test(input.command))
      edited = []
  }
  return edited
}

/** Absolute paths from `git status --porcelain -z`, whose entries are relative to the repo root. */
export function parseDirtyPaths(porcelain: string, root: string): string[] {
  const entries = porcelain.split('\0')
  const paths: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? ''
    if (entry.length < 4) continue
    paths.push(path.resolve(root, entry.slice(3)))
    // A rename or copy is followed by its original path, which is no longer in the tree.
    if (/[RC]/.test(entry.slice(0, 2))) i++
  }
  return paths
}

/** Pure: live children of `self` that have sent it no `Status:` report since they were spawned. */
export function awaitedChildren(
  self: string,
  agents: readonly AgentIdentity[],
  activity: ReadonlyMap<string, readonly QueueItem[]>,
): string[] {
  const reported = (child: AgentIdentity): boolean =>
    (activity.get(child.name) ?? []).some(
      item =>
        item.kind === 'message' &&
        item.from === child.name &&
        item.meta.target === self &&
        item.at >= child.spawnedAt &&
        item.text.startsWith('Status:'),
    )
  return agents.filter(a => a.spawnedBy === self && LIVE_STATES.has(a.state) && !reported(a)).map(a => a.name)
}

const run = promisify(execFile)

/** Undefined when the status cannot be read; a cwd outside any repo has nothing dirty. */
export async function readDirtyPaths(cwd: string): Promise<string[] | undefined> {
  let root: string
  try {
    root = (await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])).stdout.trim()
  } catch {
    return []
  }
  try {
    const args = ['-C', cwd, 'status', '--porcelain', '-z', '--untracked-files=all']
    return parseDirtyPaths((await run('git', args)).stdout, root)
  } catch {
    return undefined
  }
}

type Broker = Pick<BrokerClient, 'request'>

export async function readAwaitedChildren(broker: Broker, self: string): Promise<string[]> {
  const roster = (await broker.request({ t: 'agents' }, 'agents_result')) as Extract<
    ServerMessage,
    { t: 'agents_result' }
  >
  const mine = roster.agents.filter(a => a.spawnedBy === self && LIVE_STATES.has(a.state))
  const trails = await Promise.all(
    mine.map(async child => {
      const res = (await broker.request(
        { t: 'activity', name: child.name, limit: CHILD_ACTIVITY_LIMIT },
        'activity_result',
      )) as Extract<ServerMessage, { t: 'activity_result' }>
      return [child.name, res.events] as const
    }),
  )
  return awaitedChildren(self, mine, new Map(trails))
}

export interface WaitSource {
  sessionId: string
  cwd: string
  /** The Claude config dir holding the transcript, when it is not this process's own. */
  configDir?: string
  /** This session's registered name; without one it has no children to await. */
  self: string | null
  broker: Broker
}

/** Never throws: any input that cannot be read makes the answer `unknown`. */
export async function readWait(source: WaitSource): Promise<WaitClass> {
  try {
    const transcript = findTranscript(source.cwd, source.sessionId, source.configDir)
    if (!transcript.exists) return UNKNOWN
    const records = recordsOf(readTail(transcript.path))
    const dirty = await readDirtyPaths(source.cwd)
    if (dirty === undefined) return UNKNOWN
    const children = source.self === null ? [] : await readAwaitedChildren(source.broker, source.self)
    return classifyWait(records, dirty, children)
  } catch {
    return UNKNOWN
  }
}
