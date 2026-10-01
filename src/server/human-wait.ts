import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { BrokerClient } from '../client/broker-client.js'
import type { AgentIdentity, AgentLifecycle, QueueItem, ServerMessage } from '../protocol.js'
import { findTranscript } from '../agents/transcript.js'
import { parseLine, readTail, USAGE_TAIL_BYTES } from '../agents/transcript-usage.js'

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
/** Detached is still running: machine-guard counts it live, so a park must too. */
const LIVE_STATES: ReadonlySet<AgentLifecycle> = new Set(['spawning', 'live', 'detached'])
const CHILD_ACTIVITY_LIMIT = 200
/** The first line of a return-contract report: implementers send `Status:`, reviewers `Verdict:`. */
const REPORT = /^(Status|Verdict):/
const GIT_TIMEOUT_MS = 5_000
/** A human turn of tool calls often outgrows 256 KB, so the tail widens until it holds the prompt. */
const TAIL_STEPS = [USAGE_TAIL_BYTES, 1024 * 1024, 4 * 1024 * 1024]
/** Read-only status: no index.lock in a checkout a live agent may share, and no fsmonitor program. */
const GIT_READ_ONLY = ['--no-optional-locks', '-c', 'core.fsmonitor=false']

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null
const mid = (reason: MidEpisodeReason): WaitClass => ({ kind: 'mid-episode', reason })

/** How to compare edit paths with dirty ones: relative edits resolve against the session's cwd. */
export interface PathContext {
  cwd: string
  real: (absolute: string) => string
}

const AS_GIVEN: PathContext = { cwd: process.cwd(), real: p => p }

/**
 * Pure: how the session's final turn stands, given the dirty paths and the children it still awaits.
 *
 * `records` undefined means the tail was torn or garbled. No commit parsing: the dirty-path
 * intersection already shows whether an edit landed, and a command line cannot.
 */
export function classifyWait(
  records: readonly unknown[] | undefined,
  dirtyPaths: readonly string[],
  children: readonly string[],
  paths: Partial<PathContext> = {},
): WaitClass {
  const { cwd, real } = { ...AS_GIVEN, ...paths }
  const turn = records === undefined ? undefined : finalTurn(records)
  const last = turn?.at(-1)
  if (turn === undefined || last === undefined) return UNKNOWN
  const open = openToolNames(turn)
  if (open.some(name => name !== ASK)) return mid('open-tool')
  const canonical = (p: string): string => real(path.resolve(cwd, p))
  const dirty = new Set(dirtyPaths.map(canonical))
  if (editedPaths(turn).some(p => dirty.has(canonical(p)))) return mid('partial-edit')
  if (children.length > 0) return mid('awaited-children')
  if (open.length > 0) return { kind: 'awaiting-ask' }
  const stop = (last.message as Rec).stop_reason
  return last.type === 'assistant' && stop === 'end_turn' ? { kind: 'awaiting-turn-end' } : UNKNOWN
}

/**
 * Parse a transcript tail. The cut first line is dropped; a half-written or garbled LAST line
 * gives undefined, because the record it hides may be the one that ends the wait.
 */
export function recordsOf(tail: string): Rec[] | undefined {
  if (!tail.endsWith('\n')) return undefined
  const lines = tail.slice(0, -1).split('\n')
  if (parseLine(lines.at(-1) ?? '') === undefined) return undefined
  return lines.flatMap(line => {
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

/** Undefined when no prompt is in the tail: the turn began earlier, and its first edits are cut off. */
function finalTurn(records: readonly unknown[]): Rec[] | undefined {
  const turn = records.filter(isTurnRecord)
  const start = turn.findLastIndex(opensTurn)
  return start < 0 ? undefined : turn.slice(start)
}

/** The tail from the final turn's prompt on, read no wider than it needs; past 4 MB the turn reads as unknown. */
export function readTurnRecords(file: string): Rec[] | undefined {
  let records: Rec[] | undefined
  for (const bytes of TAIL_STEPS) {
    const tail = readTail(file, bytes)
    records = recordsOf(tail)
    const whole = Buffer.byteLength(tail) < bytes
    if (records === undefined || whole || records.filter(isTurnRecord).some(opensTurn)) return records
  }
  return records
}

const blocksOfType = (turn: Rec[], type: string): Rec[] =>
  turn.flatMap(blocksOf).filter(block => block.type === type)

function openToolNames(turn: Rec[]): string[] {
  const answered = new Set(blocksOfType(turn, 'tool_result').map(b => b.tool_use_id))
  return blocksOfType(turn, 'tool_use')
    .filter(use => !answered.has(use.id))
    .map(use => String(use.name))
}

function editedPaths(turn: Rec[]): string[] {
  return blocksOfType(turn, 'tool_use').flatMap(use => {
    const key = EDIT_PATH_KEYS[String(use.name)]
    const target = key !== undefined && isRecord(use.input) ? use.input[key] : undefined
    return typeof target === 'string' ? [target] : []
  })
}

/** Symlinks resolved, so `/var/x` and git's `/private/var/x` compare equal; a deleted file keeps its name. */
export function canonicalPath(absolute: string): string {
  try {
    return fs.realpathSync.native(absolute)
  } catch {
    try {
      return path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute))
    } catch {
      return absolute
    }
  }
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

/** Pure: live children of `self` that have sent it no report since they were spawned. */
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
        REPORT.test(item.text),
    )
  return agents.filter(a => a.spawnedBy === self && LIVE_STATES.has(a.state) && !reported(a)).map(a => a.name)
}

const run = promisify(execFile)

const git = async (cwd: string, args: string[], timeout: number): Promise<string> =>
  (await run('git', [...GIT_READ_ONLY, '-C', cwd, ...args], { timeout })).stdout

/** git exits 128 for a cwd outside any repo; a timeout or missing git is a different failure. */
const notARepo = (error: unknown): boolean => isRecord(error) && error.code === 128

/** Undefined when the status cannot be read; a cwd outside any repo has nothing dirty. */
export async function readDirtyPaths(cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string[] | undefined> {
  let root: string
  try {
    root = (await git(cwd, ['rev-parse', '--show-toplevel'], timeoutMs)).trim()
  } catch (error) {
    return notARepo(error) ? [] : undefined
  }
  try {
    const porcelain = await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'], timeoutMs)
    return parseDirtyPaths(porcelain, root)
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
    const records = readTurnRecords(transcript.path)
    const dirty = await readDirtyPaths(source.cwd)
    if (dirty === undefined) return UNKNOWN
    const children = source.self === null ? [] : await readAwaitedChildren(source.broker, source.self)
    return classifyWait(records, dirty, children, { cwd: source.cwd, real: canonicalPath })
  } catch {
    return UNKNOWN
  }
}
