import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { childEnv, type RunResult } from '../../exec.js'
import type { AgentIdentity, QueueItem } from '../../protocol.js'
import { SHEPHERD_BIN, SHEPHERD_STATUS_ARGS, SHEPHERD_WAITING_ARGS } from '../../shepherd-client.js'
import { taskScalars } from '../active-work.js'
import { loadCharterPools, loadPolicy } from '../burndown/policy.js'
import { readTail } from '../transcript-usage.js'
import { BLOCK_PAGE_TO } from './block-page.js'
import { charterSeats, isSeatName } from './charter.js'
import { coordinatorSeats } from './coordinators.js'
import { parseShepherdFlights, settle, type Settled, type ShepherdFlight } from './in-flight-read.js'
import {
  deriveOperatorBrief,
  type BriefSeat,
  type BriefUnavailable,
  type BurndownState,
  type OperatorBrief,
} from './operator-brief.js'
import { readPaceDoc } from './pace-pass.js'
import { seatFileNamed } from './seat-of.js'
import { readWaiting, type ShepherdWaiting } from './shepherd-waiting.js'
import { poolPaces, readInbox, type AccountPace, type InboxReading, type StatusDeps } from './status.js'

/**
 * CC-1551: the operator brief's reads. Each port throws when it cannot answer; the brief lists it under
 * `unavailable` and derives from the rest. Every port only reads: the broker sees `agents` and `queue`
 * frames, Shepherd sees `status` and `waiting`, and nothing runs gh.
 */

export interface OperatorBriefPorts {
  /** The coordinator seats plus any extra names asked for, each with its prefix and caps. */
  seats: (extra: string[]) => Promise<BriefSeat[]>
  roster: () => Promise<AgentIdentity[]>
  queue: () => Promise<QueueItem[]>
  inbox: (seat: string) => Promise<InboxReading>
  shepherd: () => Promise<ShepherdFlight[]>
  waiting: () => Promise<ShepherdWaiting>
  pools: () => Promise<AccountPace[]>
  machineStop: () => Promise<string | null>
  paceAgeSeconds: () => Promise<number | null>
  burndown: () => Promise<BurndownState>
  /** Status by task id (`<initiative>/<ID>`); an id with no task file is left out. */
  tasks: (ids: string[]) => Promise<Record<string, string>>
}

export interface BriefReadOptions {
  now: Date
  show?: string[]
  plain: (err: unknown) => string
}

const value = <T>(s: Settled<T>): T | undefined => (s.ok ? s.value : undefined)

function unavailableOf(sources: Record<string, Settled<unknown>>): BriefUnavailable[] {
  return Object.entries(sources).flatMap(([source, s]) => (s.ok ? [] : [{ source, reason: s.reason }]))
}

/** One line for the inbox source, naming the seats it could not read. */
function inboxUnavailable(readings: Array<[string, Settled<InboxReading>]>): BriefUnavailable[] {
  const failed = readings.flatMap(([seat, s]) => (s.ok ? [] : [{ seat, reason: s.reason }]))
  const first = failed[0]
  if (first === undefined) return []
  return [{ source: 'inbox', reason: `${failed.map(f => f.seat).join(', ')}: ${first.reason}` }]
}

async function seatInboxes(
  ports: OperatorBriefPorts,
  seats: BriefSeat[],
  plain: BriefReadOptions['plain'],
): Promise<Array<[string, Settled<InboxReading>]>> {
  return Promise.all(seats.map(async s => [s.name, await settle(() => ports.inbox(s.name), plain)] as const))
}

const taskIds = (rows: ShepherdFlight[] | undefined): string[] => [
  ...new Set((rows ?? []).flatMap(r => (r.task === null ? [] : [r.task]))),
]

/** Reads every port once, in parallel where nothing depends on another read, then derives. */
export async function readOperatorBrief(
  ports: OperatorBriefPorts,
  opts: BriefReadOptions,
): Promise<OperatorBrief> {
  const { plain } = opts
  const [seats, roster, queue, shepherd, waiting, pools, machineStop, pace, burndown] = await Promise.all([
    settle(() => ports.seats(opts.show ?? []), plain),
    settle(ports.roster, plain),
    settle(ports.queue, plain),
    settle(ports.shepherd, plain),
    settle(ports.waiting, plain),
    settle(ports.pools, plain),
    settle(ports.machineStop, plain),
    settle(ports.paceAgeSeconds, plain),
    settle(ports.burndown, plain),
  ])
  const seatList = value(seats) ?? []
  const shown = seatList.filter(s => opts.show === undefined || opts.show.includes(s.name))
  const [inboxes, tasks] = await Promise.all([
    seatInboxes(ports, shown, plain),
    settle(() => ports.tasks(taskIds(value(shepherd))), plain),
  ])
  const sources = { seats, roster, queue, shepherd, waiting, pools, machineStop, pace, burndown, tasks }
  return deriveOperatorBrief({
    now: opts.now,
    seats: seatList,
    ...(opts.show === undefined ? {} : { show: opts.show }),
    roster: value(roster),
    inbox: Object.fromEntries(inboxes.flatMap(([seat, s]) => (s.ok ? [[seat, s.value]] : []))),
    shepherd: value(shepherd),
    waiting: value(waiting),
    queue: value(queue),
    pools: value(pools),
    machineStop: value(machineStop),
    paceAgeSeconds: value(pace),
    burndown: value(burndown),
    taskStatus: value(tasks),
    unavailable: [...unavailableOf(sources), ...inboxUnavailable(inboxes)],
  })
}

/** The only frames the brief sends; each is answered without changing broker state. */
export type BriefFrame = { t: 'agents' } | { t: 'queue' }

export type AsyncRunner = (bin: string, args: string[]) => Promise<Pick<RunResult, 'status' | 'stdout'>>

/** What the live ports read from; a test points each at a fixture or a spy. */
export interface BriefSystem {
  autonomyRoot: string
  activeWorkRoot: string
  homeDir: string
  eventsDb: string
  pacePath: string
  burndownPausePath: string
  burndownTicksPath: string
  now: () => Date
  broker: (frame: BriefFrame) => Promise<unknown>
  exec: AsyncRunner
  readBudget: StatusDeps['readBudget']
  machineStop: () => { reason: string } | null
}

const SHEPHERD_TIMEOUT_MS = 15_000
const SHEPHERD_MAX_BYTES = 64 * 1024 * 1024

/** `execFile` without blocking; a non-zero exit keeps its status and stdout, since `waiting` exits 1 with an answer. */
export const execAsync: AsyncRunner = async (bin, args) => {
  try {
    const { stdout } = await promisify(execFile)(bin, args, {
      cwd: os.homedir(),
      env: childEnv(),
      encoding: 'utf8',
      timeout: SHEPHERD_TIMEOUT_MS,
      maxBuffer: SHEPHERD_MAX_BYTES,
    })
    return { status: 0, stdout }
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown }
    return {
      status: typeof e.code === 'number' ? e.code : null,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
    }
  }
}

/** The operator is no charter seat; its agents carry this prefix by convention when it has no seat file. */
export const OPERATOR_PREFIX = 'tpo'

/** Charter seats carry their prefix and caps; any other name gets its own seat file's prefix and no caps. */
export function briefSeats(root: string, extra: string[]): BriefSeat[] {
  const charter = fs.readFileSync(path.join(root, 'charter.md'), 'utf8')
  const listed = charterSeats(charter).filter(isSeatName)
  const policy = listed[0] === undefined ? {} : loadPolicy(root, listed[0]).seats
  return [...new Set([...coordinatorSeats(charter), ...extra])].map(name => {
    const seat = policy[name]
    if (seat !== undefined) {
      const caps = { implementer: seat.concurrency.implementers, reviewer: seat.concurrency.reviewers }
      return { name, prefix: seat.prefix, caps }
    }
    const own = seatFileNamed(root, name)?.seat.prefix
    return { name, prefix: own ?? (name === BLOCK_PAGE_TO ? OPERATOR_PREFIX : undefined), caps: null }
  })
}

const TICK_TAIL_BYTES = 256 * 1024

function burndownState(sys: BriefSystem): BurndownState {
  const pausedSince = fs.existsSync(sys.burndownPausePath)
    ? fs.statSync(sys.burndownPausePath).mtime.toISOString()
    : null
  if (!fs.existsSync(sys.burndownTicksPath)) return { pausedSince, lastTick: null }
  const last = readTail(sys.burndownTicksPath, TICK_TAIL_BYTES).trimEnd().split('\n').at(-1) ?? ''
  const ts = last === '' ? undefined : (JSON.parse(last) as { ts?: unknown }).ts
  return { pausedSince, lastTick: typeof ts === 'string' ? ts : null }
}

/** One read of each initiative's tasks directory, however many of its tasks are asked for. */
function taskStatuses(awRoot: string, ids: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  const wanted = new Set(ids)
  for (const slug of new Set(ids.map(id => id.split('/')[0] ?? ''))) {
    const dir = path.join(awRoot, slug, 'tasks')
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.yml')) : []
    for (const file of files) {
      const { id, status } = taskScalars(fs.readFileSync(path.join(dir, file), 'utf8'))
      const key = `${slug}/${id}`
      if (id !== undefined && status !== undefined && wanted.has(key)) out[key] = status
    }
  }
  return out
}

async function shepherdFlights(sys: BriefSystem): Promise<ShepherdFlight[]> {
  const result = await sys.exec(SHEPHERD_BIN, SHEPHERD_STATUS_ARGS)
  if (result.status !== 0) throw new Error(`shepherd status exited ${result.status ?? 'on a signal'}`)
  return parseShepherdFlights(result.stdout)
}

export function liveBriefPorts(sys: BriefSystem): OperatorBriefPorts {
  return {
    seats: async extra => briefSeats(sys.autonomyRoot, extra),
    roster: async () => ((await sys.broker({ t: 'agents' })) as { agents: AgentIdentity[] }).agents,
    queue: async () => ((await sys.broker({ t: 'queue' })) as { items: QueueItem[] }).items,
    inbox: async seat => readInbox(sys.eventsDb, seat),
    shepherd: () => shepherdFlights(sys),
    waiting: async () => readWaiting(await sys.exec(SHEPHERD_BIN, SHEPHERD_WAITING_ARGS)),
    pools: async () => poolPaces(sys, loadCharterPools(sys.autonomyRoot), sys.now()),
    machineStop: async () => sys.machineStop()?.reason ?? null,
    paceAgeSeconds: async () => {
      const doc = readPaceDoc(sys.pacePath)
      return doc === undefined ? null : Math.round((sys.now().getTime() - doc.at) / 1000)
    },
    burndown: async () => burndownState(sys),
    tasks: async ids => taskStatuses(sys.activeWorkRoot, ids),
  }
}
