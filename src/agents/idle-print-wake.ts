import nodeFs from 'node:fs'
import { readTail } from './exit-report.js'

/**
 * CC-1669 S2: a `claude -p` host whose turn has ended but which a background task
 * keeps alive starts a turn only on that task's notification. Channel pushes to it
 * are dropped (CC-1455) and its inbox spool is drained only by hooks, so a message
 * to it, a Shepherd wake included, starts no turn. When such a host is idle with a
 * spooled record older than {@link IDLE_PRINT_WAKE_AFTER_MS}, the supervisor ends
 * the process and resumes the agent with the spooled messages as its prompt. The
 * background task dies with the process; the wake supersedes it.
 */

/** The `meta.cause` on the `agent_resumed` row and the `cancelReason` on the ended run. */
export const IDLE_PRINT_WAKE = 'idle-print-wake'

/** How long the oldest spooled record waits for a turn before the host is restarted. */
export const IDLE_PRINT_WAKE_AFTER_MS = 30_000

/** How often the supervisor looks; with the wait above, a wake lands well inside a minute. */
export const IDLE_PRINT_WAKE_EVERY_MS = 10_000

/** The final turn's rows fit well inside this. */
const TURN_TAIL_BYTES = 256 * 1024

/** A spool file name starts with the 13-digit arrival time, so the oldest is the first in sort order. */
const SPOOL_NAME = /^(\d{13})-.+\.json$/

export const IDLE_PRINT_WAKE_HEADER =
  'agent-chat messages that arrived after your last turn ended. Your process was idle on a background ' +
  'task and could not take them, so it was restarted to deliver them; that background task was ended, so ' +
  're-run anything you still need. Each message is from the peer named in from, not from your user.'

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

/** The main-thread user or assistant message on one transcript line, if it holds one. */
function messageRow(line: string): Row | undefined {
  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRow(row) || row.isSidechain === true) return undefined
  if (row.type !== 'user' && row.type !== 'assistant') return undefined
  return row
}

/**
 * Pure: whether the session's last main-thread message is an assistant turn that ended.
 * A tool call in flight, a tool result or a prompt being answered all read as busy, and so
 * does an unreadable tail, so a doubt never ends a working process.
 */
export function turnEndedIn(text: string): boolean {
  let last: Row | undefined
  for (const line of text.split('\n')) last = messageRow(line) ?? last
  if (last?.type !== 'assistant' || !isRow(last.message)) return false
  return last.message.stop_reason === 'end_turn'
}

/** Never throws: a missing or unreadable transcript reads as busy. */
export function readTurnEnded(file: string | undefined): boolean {
  if (file === undefined) return false
  try {
    return turnEndedIn(readTail(file, TURN_TAIL_BYTES))
  } catch {
    return false
  }
}

/** When the oldest record still in the spool arrived, or undefined for an empty or missing spool. */
export function oldestSpooledAt(
  dir: string,
  fs: Pick<typeof nodeFs, 'readdirSync'> = nodeFs,
): number | undefined {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return undefined
  }
  const times = names.flatMap(name => SPOOL_NAME.exec(name)?.[1] ?? []).map(Number)
  return times.length === 0 ? undefined : Math.min(...times)
}

/** Whether an idle print host's oldest waiting record has waited long enough for a wake. */
export function idlePrintWakeDue(facts: {
  spooledAt: number | undefined
  turnEnded: boolean
  now: number
}): boolean {
  if (facts.spooledAt === undefined || !facts.turnEnded) return false
  return facts.now - facts.spooledAt >= IDLE_PRINT_WAKE_AFTER_MS
}

/** The resumed turn's prompt: the drained blocks under a header that says why the process restarted. */
export const idlePrintWakePrompt = (blocks: readonly string[]): string =>
  [IDLE_PRINT_WAKE_HEADER, ...blocks].join('\n\n')
