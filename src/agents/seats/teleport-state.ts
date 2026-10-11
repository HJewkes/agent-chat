import fs from 'node:fs'
import path from 'node:path'
import { frontmatterField } from '../active-work.js'
import type { ShepherdRow } from '../burndown/shepherd.js'
import { BRANCH_PREFIX } from '../isolation/worktree.js'
import { agentLine } from '../teleport-appendix.js'
import type { AgentIdentity } from '../../protocol.js'
import { GENERATED_MARK, latestTeleportNumber, readTeleportBlock } from './boot-read.js'
import { isSeatName } from './charter.js'
import { readSeatJournal, readText, seatJournalDays, seatLogPath } from './io.js'

/**
 * CC-863: charter section 11 step 2, written by agent-chat at `agent_teleport` instead of by
 * the seat. The block is what `seats boot` reads back (boot-read.ts), so it keeps that format:
 * a `## State at teleport N` heading, one line per in-flight agent, then the inbox cursor.
 *
 * While charter section 11 still has the seat write its own block, a block the seat wrote in
 * this session wins: its cursor is the last message it actually handled, and a later block
 * from agent-chat would hide both that cursor and the seat's own account from `seats boot`.
 */

export type InFlightAgent = Pick<AgentIdentity, 'name' | 'profile' | 'state'>

export interface TeleportStateFacts {
  n: number
  /** The seat file's `grant:`, quoted on the first State line as the seat file asks. */
  grant?: string
  running: InFlightAgent[]
  /** The seat's unfinished Shepherd runs; undefined when Shepherd could not be read. */
  shepherd: ShepherdRow[] | undefined
  /** The msg_id of the seat's newest inbox row when it asked to teleport. */
  inboxThrough: string | undefined
  /** Lines after the in-flight ones, for what could not be listed. */
  notes?: string[]
}

export interface SeatTeleportDeps {
  autonomyRoot: string
  now: () => Date
  /** Undefined or a throw both read as Shepherd being down, which never fails the teleport. */
  shepherd: () => Promise<ShepherdRow[] | undefined>
}

export interface SeatTeleportInput {
  seat: string
  running: InFlightAgent[]
  inboxThrough: string | undefined
  /** Epoch ms the teleporting session began, which tells a block it wrote from an earlier one's. */
  sessionStart: number
}

export interface TeleportStateWritten {
  file: string
  n: number
  /** False when the seat's own block from this session was kept instead. */
  written: boolean
  /** The cursor the successor boots after: the kept block's, or the broker's. */
  after: string | undefined
  /** True when the kept block names no cursor `handledThrough` can read. */
  cursorMissing: boolean
}

const NO_PREFIX_NOTE = '- Shepherd runs not listed: the seat file has no prefix to match their branches.'

const FINISHED: ReadonlySet<string> = new Set(['done', 'cancelled'])
const REASON_TEXT = 120

/** One past the last `State at teleport N` in today's log, or 1. */
export function nextTeleportNumber(log: string | undefined): number {
  const last = log === undefined ? undefined : latestTeleportNumber(log)
  return last === undefined ? 1 : last + 1
}

const branchAgent = (row: ShepherdRow): string | undefined =>
  row.branch?.startsWith(BRANCH_PREFIX) ? row.branch.slice(BRANCH_PREFIX.length) : undefined

/** The seat's unfinished runs, told by the `agent-chat/<prefix>-…` branch its agents push. */
export const seatShepherdRows = (rows: readonly ShepherdRow[], prefix: string): ShepherdRow[] =>
  rows.filter(r => !FINISHED.has(r.phase) && branchAgent(r)?.startsWith(`${prefix}-`) === true)

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, REASON_TEXT)

function shepherdLine(row: ShepherdRow): string {
  const target = row.pr === null ? row.repo : `${row.repo}#${row.pr}`
  const task = row.task ? ` ${row.task}` : ''
  const held = row.held ? `, held ${oneLine(row.held.reason)}` : ''
  const stalled = row.stalled ? `, stalled ${oneLine(row.stalled.reason)}` : ''
  const head = row.headSha ? `, at ${row.headSha.slice(0, 8)}` : ''
  return `- Shepherd ${target}${task} ${row.phase}${held}${stalled}${head} (${branchAgent(row) ?? '?'})`
}

export function renderTeleportState(facts: TeleportStateFacts): string {
  const agents = facts.running.map(agentLine)
  const runs =
    facts.shepherd === undefined
      ? ['- Shepherd unreachable at teleport; its runs are not listed.']
      : facts.shepherd.map(shepherdLine)
  const inFlight = [...agents, ...runs]
  return [
    `## State at teleport ${facts.n} ${GENERATED_MARK}`,
    ...(facts.grant === undefined ? [] : [`GRANT: ${facts.grant}`]),
    ...(inFlight.length === 0 ? ['- No agent in flight.'] : inFlight),
    ...(facts.notes ?? []),
    facts.inboxThrough === undefined
      ? 'Inbox: no message had arrived, so boot without --after.'
      : `Inbox handled through ${facts.inboxThrough}.`,
  ].join('\n')
}

async function readShepherd(deps: SeatTeleportDeps): Promise<ShepherdRow[] | undefined> {
  try {
    return await deps.shepherd()
  } catch {
    return undefined
  }
}

const startOfDay = (at: Date): number => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()

export interface KeptBlock {
  n: number
  after: string | undefined
}

/**
 * The seat's latest block when the seat wrote it this session, searching back to the session's
 * first day so a block written just before midnight still counts. A block with no clock line
 * above it counts as this session's: re-showing messages is the safe error.
 */
export function seatBlockThisSession(
  root: string,
  seat: string,
  sessionStart: number,
): KeptBlock | undefined {
  const firstDay = startOfDay(new Date(sessionStart))
  for (const day of seatJournalDays(root, seat)) {
    if (startOfDay(day) < firstDay) return undefined
    const log = readSeatJournal(root, seat, day)
    const block = log === undefined ? undefined : readTeleportBlock(log)
    if (block === undefined) continue
    if (block.generated) return undefined
    const at = block.clockAbove === undefined ? undefined : startOfDay(day) + block.clockAbove * 60_000
    if (at !== undefined && at < sessionStart - (sessionStart % 60_000)) return undefined
    return { n: block.n, after: block.cursor }
  }
  return undefined
}

async function shepherdFacts(
  deps: SeatTeleportDeps,
  prefix: string | undefined,
): Promise<Pick<TeleportStateFacts, 'shepherd' | 'notes'>> {
  if (prefix === undefined) return { shepherd: [], notes: [NO_PREFIX_NOTE] }
  const rows = await readShepherd(deps)
  return { shepherd: rows && seatShepherdRows(rows, prefix) }
}

/** The seat file for `seat` under `root`, or undefined when `seat` names no seat. */
export const readSeatFile = (root: string, seat: string): string | undefined =>
  isSeatName(seat) ? readText(path.join(root, 'seats', `${seat}.md`)) : undefined

/**
 * Appends the block to the seat's log for today, or keeps the one the seat wrote this session.
 * Undefined, writing nothing, when `seat` names no seat file. Throws only when the log cannot be written.
 */
export async function writeTeleportState(
  deps: SeatTeleportDeps,
  input: SeatTeleportInput,
): Promise<TeleportStateWritten | undefined> {
  const { autonomyRoot: root } = deps
  const seatFile = readSeatFile(root, input.seat)
  if (seatFile === undefined) return undefined
  const file = seatLogPath(root, input.seat, deps.now())
  const kept = seatBlockThisSession(root, input.seat, input.sessionStart)
  if (kept !== undefined)
    return { file, n: kept.n, written: false, after: kept.after, cursorMissing: kept.after === undefined }
  const log = readText(file)
  const grant = frontmatterField(seatFile, 'grant')
  const n = nextTeleportNumber(log)
  const block = renderTeleportState({
    n,
    ...(grant === undefined || grant === '' ? {} : { grant }),
    running: input.running,
    ...(await shepherdFacts(deps, frontmatterField(seatFile, 'prefix'))),
    inboxThrough: input.inboxThrough,
  })
  const lead = log === undefined || log === '' ? '' : log.endsWith('\n') ? '\n' : '\n\n'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${lead}${block}\n`)
  return { file, n, written: true, after: input.inboxThrough, cursorMissing: false }
}
