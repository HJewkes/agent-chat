import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { BLOCK_PAGE_TO } from '../../agents/seats/block-page.js'
import { charterOwnerSeat } from '../../agents/seats/charter.js'
import { shepherdPort } from '../../agents/seats/in-flight-read.js'
import { defaultAutonomyRoot, readAgentEvents, readText, scorerEligible } from '../../agents/seats/io.js'
import {
  appendWatchRow,
  lastWatchRow,
  parseSeatStatus,
  readActivity,
  readReports,
  readSeatBook,
  readUnread,
} from '../../agents/seats/seat-watch-read.js'
import { runWatch, type WatchPorts } from '../../agents/seats/seat-watch-run.js'
import { childEnv } from '../../exec.js'
import { cliEntry, home, seatWatchDir } from '../../paths.js'
import { HUMAN } from '../../protocol.js'
import { defineVerb, Report } from '../command.js'

const STATUS_TIMEOUT_MS = 60_000

/** `agent-chat seats status <seat> --json` over the CLI boundary; it exits 1 with a `{seat, error}` body. */
async function seatStatusBudget(root: string, seat: string): ReturnType<WatchPorts['budget']> {
  const args = [cliEntry(), 'seats', 'status', seat, '--json', '--root', root]
  try {
    const { stdout } = await promisify(execFile)(process.execPath, args, {
      env: childEnv(),
      encoding: 'utf8',
      timeout: STATUS_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    })
    return parseSeatStatus(stdout)
  } catch (err) {
    const stdout = (err as { stdout?: unknown }).stdout
    if (typeof stdout === 'string' && stdout.trim().startsWith('{')) return parseSeatStatus(stdout)
    throw err
  }
}

function charterOf(root: string): string {
  const charter = readText(path.join(root, 'charter.md'))
  if (charter === undefined) throw new Error('charter.md is unreadable')
  return charter
}

function livePorts(root: string, dbPath: string, dir: string): WatchPorts {
  const flights = shepherdPort()
  return {
    now: () => new Date(),
    book: rows => readSeatBook(root, charterOf(root), BLOCK_PAGE_TO, rows),
    owners: () => new Set([HUMAN, charterOwnerSeat(charterOf(root)) ?? HUMAN]),
    operator: BLOCK_PAGE_TO,
    agentRows: () => readAgentEvents(dbPath, Number.MAX_SAFE_INTEGER),
    unread: seat => readUnread(dbPath, seat),
    activity: names => readActivity(dbPath, names),
    reports: (seat, sinceMs) => readReports(dbPath, seat, sinceMs),
    flights,
    budget: seat => seatStatusBudget(root, seat),
    queue: seat => scorerEligible(root, seat)?.count,
    dispatcherCovers: () => false,
    lastRow: seat => lastWatchRow(dir, seat),
    append: row => appendWatchRow(dir, row),
  }
}

export const seatsWatchVerb = defineVerb({
  name: 'seats.watch',
  description:
    'the seat-watch wake gate (CC-1661, workflows pilot P1), one pass: for each live seat in the book ' +
    '(re-read each pass; seats with no live coordinator are skipped) build the state packet from ' +
    'events.db, Shepherd and seats status, apply rules R1-R5, and append one JSONL row per seat. ' +
    'Only --shadow runs: it sends nothing and wakes nothing',
  args: z.object({
    shadow: z.boolean().optional(),
    root: z.string().optional(),
    dir: z.string().optional(),
    db: z.string().optional(),
  }),
  result: Report,
  cli: {
    options: {
      shadow: { long: '--shadow', description: 'record decisions only; required until delivery lands' },
      root: { long: '--root', description: 'autonomy directory holding charter.md and seats/' },
      dir: { long: '--dir', description: 'where the <seat>.jsonl rows go (default: the XDG state dir)' },
      db: { long: '--db', description: 'events.db to read (default: the broker home)' },
    },
  },
  async run({ shadow, root, dir, db }) {
    if (shadow !== true)
      return { ok: false, lines: [], errors: ['seats watch delivers nothing yet; run it with --shadow'] }
    const out = dir ?? seatWatchDir()
    try {
      const ports = livePorts(root ?? defaultAutonomyRoot(), db ?? path.join(home(), 'events.db'), out)
      const result = await runWatch(ports, { shadow: true })
      const lines = result.rows.map(
        r => `${r.seat} ${r.decision} ${r.fired.map(f => f.rule).join(',') || '-'}`,
      )
      const skipped =
        result.retired.length === 0 ? [] : [`skipped, no live coordinator: ${result.retired.join(', ')}`]
      return { ok: true, lines: [...lines, ...skipped, `rows in ${out}`] }
    } catch (err) {
      return { ok: false, lines: [], errors: [err instanceof Error ? err.message : String(err)] }
    }
  },
})
