import path from 'node:path'
import { burndownLedgerPath, burndownTickStatusPath, burndownTicksPath, home, logPath } from '../../paths.js'
import type { DispatchRecord } from '../seats/dispatch-record.js'
import { isSeatName, parseSeat } from '../seats/charter.js'
import { dispatchLogPath } from '../seats/dispatch-log.js'
import { openEvents, readSeatJournal, readText, seatFileNames } from '../seats/io.js'
import { seatFileNamed, seatOf } from '../seats/seat-of.js'
import {
  GATE_CODES,
  type DispatchStatsPorts,
  type GateCode,
  type GateRow,
  type GateRows,
} from './dispatch-stats.js'
import { readLedger } from './ledger.js'
import { loadResolvedConfig } from './settings-store.js'
import { readWasteObservations } from './waste-source.js'
import { readTickStatus } from './tick-status.js'
import type { VerdictObservation } from './waste.js'

/** CC-933: `dispatch-stats`' ports over this machine's agent-chat home and the autonomy root at `root`. */
export function dispatchStatsPorts(root: string, now: Date): DispatchStatsPorts {
  return {
    now,
    seats: () => seatFileNames(root),
    tickRows: () => readText(burndownTicksPath()),
    ledger: () => readLedger(burndownLedgerPath()),
    dispatchLog: seat => seatDispatchLog(root, seat),
    journal: (seat, day) => readSeatJournal(root, seat, day),
    lastOkAt: () => readTickStatus(burndownTickStatusPath()).lastOkAt,
    maxAgents: () => loadResolvedConfig().tick.maxAgents,
    readyFloor: () => loadResolvedConfig().tick.readyFloor,
    verdicts: (runs, sinceMs) => readVerdicts(runs, sinceMs, now),
    gateRows: sinceMs =>
      readGateRows(root, { logFile: logPath(), dbPath: path.join(home(), 'events.db') }, sinceMs, now),
  }
}

interface GateSources {
  /** `broker.log`; its one rotation, `${logFile}.1`, is read too. */
  logFile: string
  dbPath: string
}

interface UnattributedRow extends Omit<GateRow, 'seat'> {
  name: string
  spawner: string
}

const gateCodeOf = (value: unknown): GateCode | undefined => GATE_CODES.find(code => code === value)

function parseLogLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * The gate's warn lines in `broker.log` and its rotation, plus the oldest line's time. A refuse-mode line is
 * skipped: the refusal's own `agent_spawn_refused` event counts it, and counting both would count it twice.
 */
function logGateRows(
  logFile: string,
  sinceMs: number,
): { rows: UnattributedRow[]; oldestMs: number | undefined } {
  const rows: UnattributedRow[] = []
  let oldestMs: number | undefined
  for (const file of [`${logFile}.1`, logFile]) {
    for (const line of (readText(file) ?? '').split('\n')) {
      const entry = parseLogLine(line)
      const ts = typeof entry?.ts === 'string' ? Date.parse(entry.ts) : NaN
      if (entry === undefined || Number.isNaN(ts)) continue
      oldestMs = Math.min(oldestMs ?? ts, ts)
      const code = gateCodeOf(entry.event)
      if (code === undefined || entry.mode === 'refuse' || ts < sinceMs) continue
      rows.push({ code, refused: false, ts, name: String(entry.name), spawner: String(entry.requested_by) })
    }
  }
  return { rows, oldestMs }
}

/** The window's `agent_spawn_refused` events whose reason names a gate code; throws when events.db is unreadable. */
function refusedGateRows(dbPath: string, sinceMs: number, now: Date): UnattributedRow[] {
  const db = openEvents(dbPath)
  try {
    const events = db
      .prepare(
        "SELECT ts, actor, target, body FROM events WHERE kind = 'agent_spawn_refused' AND ts >= ? AND ts <= ? ORDER BY id",
      )
      .all(sinceMs, now.getTime()) as unknown as {
      ts: number
      actor: string
      target: string | null
      body: string | null
    }[]
    return events.flatMap(e => {
      const code = GATE_CODES.find(c => (e.body ?? '').startsWith(`${c}:`))
      return code === undefined
        ? []
        : [{ code, refused: true, ts: e.ts, name: e.target ?? '', spawner: e.actor }]
    })
  } finally {
    db.close()
  }
}

/** The spawner when it is a seat itself, else the seat whose prefix names the spawned agent. */
function seatFor(root: string, row: UnattributedRow): string | undefined {
  const own = seatFileNamed(root, row.spawner)
  if (own !== undefined) return own.seat.name
  const match = seatOf(root, row.name, row.spawner)
  return match.kind === 'seat' ? match.seat.seat.name : undefined
}

/**
 * CC-965: the seat spawn gate's rows in the window. `partial` when the oldest log line is newer than the window's
 * start or events.db cannot be read, since either leaves counts missing rather than zero.
 */
export function readGateRows(root: string, sources: GateSources, sinceMs: number, now: Date): GateRows {
  const logged = logGateRows(sources.logFile, sinceMs)
  let refused: UnattributedRow[] = []
  let dbRead = true
  try {
    refused = refusedGateRows(sources.dbPath, sinceMs, now)
  } catch {
    dbRead = false
  }
  const rows = [...logged.rows, ...refused].map(({ name, spawner, ...row }) => {
    const seat = seatFor(root, { ...row, name, spawner })
    return seat === undefined ? row : { ...row, seat }
  })
  return { rows, partial: !dbRead || logged.oldestMs === undefined || logged.oldestMs > sinceMs }
}

function seatDispatchLog(root: string, seat: string): string | undefined {
  const text = isSeatName(seat) ? readText(path.join(root, 'seats', `${seat}.md`)) : undefined
  const parsed = text === undefined ? undefined : parseSeat(seat, text)
  if (text === undefined || parsed === undefined) return undefined
  const file = dispatchLogPath(root, { seat: parsed, text })
  return file === undefined ? undefined : readText(file)
}

/** The verdicts on the runs' PRs, via the waste detectors' reader; a task's seat is not needed to find them. */
function readVerdicts(runs: readonly DispatchRecord[], sinceMs: number, now: Date): VerdictObservation[] {
  const tasks = [...new Set(runs.flatMap(r => r.task ?? []))].map(task => ({ task, seat: '' }))
  const obs = readWasteObservations(path.join(home(), 'events.db'), {
    tasks,
    dispatches: runs,
    window: { startMs: sinceMs, endMs: now.getTime() },
  })
  if ('error' in obs) throw new Error(obs.error)
  return obs.verdicts
}
