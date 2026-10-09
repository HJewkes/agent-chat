import fs from 'node:fs'
import path from 'node:path'
import { frontmatterField } from '../active-work.js'
import type { ShepherdRow } from '../burndown/shepherd.js'
import { BRANCH_PREFIX } from '../isolation/worktree.js'
import { agentLine } from '../teleport-appendix.js'
import type { AgentIdentity } from '../../protocol.js'
import { latestTeleportNumber } from './boot-read.js'
import { isSeatName } from './charter.js'
import { readText, seatLogPath } from './io.js'

/**
 * CC-863: charter section 11 step 2, written by agent-chat at `agent_teleport` instead of by
 * the seat. The block is what `seats boot` reads back (boot-read.ts), so it keeps that format:
 * a `## State at teleport N` heading, one line per in-flight agent, then the inbox cursor.
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
}

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
    `## State at teleport ${facts.n}`,
    ...(facts.grant === undefined ? [] : [`GRANT: ${facts.grant}`]),
    ...(inFlight.length === 0 ? ['- No agent in flight.'] : inFlight),
    `Inbox handled through ${facts.inboxThrough ?? 'none'}.`,
  ].join('\n')
}

async function readShepherd(deps: SeatTeleportDeps): Promise<ShepherdRow[] | undefined> {
  try {
    return await deps.shepherd()
  } catch {
    return undefined
  }
}

/**
 * Appends the block to the seat's log for today and returns where and which N.
 * Undefined, writing nothing, when `seat` names no seat file. Throws only when the log cannot be written.
 */
export async function writeTeleportState(
  deps: SeatTeleportDeps,
  input: SeatTeleportInput,
): Promise<{ file: string; n: number } | undefined> {
  const { autonomyRoot: root, now } = deps
  const seatFile = isSeatName(input.seat) ? readText(path.join(root, 'seats', `${input.seat}.md`)) : undefined
  if (seatFile === undefined) return undefined
  const prefix = frontmatterField(seatFile, 'prefix')
  const rows = await readShepherd(deps)
  const grant = frontmatterField(seatFile, 'grant')
  const file = seatLogPath(root, input.seat, now())
  const log = readText(file)
  const n = nextTeleportNumber(log)
  const block = renderTeleportState({
    n,
    ...(grant === undefined || grant === '' ? {} : { grant }),
    running: input.running,
    shepherd: rows && (prefix === undefined ? [] : seatShepherdRows(rows, prefix)),
    inboxThrough: input.inboxThrough,
  })
  const lead = log === undefined || log === '' ? '' : log.endsWith('\n') ? '\n' : '\n\n'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${lead}${block}\n`)
  return { file, n }
}
