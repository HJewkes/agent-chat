import fs from 'node:fs'
import path from 'node:path'
import { planFromSource, runBackfill, type BackfillSource } from '../agents/ledger/backfill-run.js'
import type { PlannedRow } from '../agents/ledger/backfill.js'
import { shadowSupervisorId } from '../agents/ledger/shadow-ledger.js'
import { EventLog } from '../broker/event-log.js'
import { probeSocket } from '../broker/lifecycle.js'
import { home } from '../paths.js'

interface BackfillOptions {
  dryRun?: boolean
  since?: number
}

export const days = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`bad --since: ${value} (a positive number of days)`)
  return parsed
}

/** Offline only: the broker's own boot hook covers the online case, and two writers would race. */
export async function backfill(opts: BackfillOptions): Promise<void> {
  const file = path.join(home(), 'events.db')
  if (await probeSocket())
    fail('a broker holds the socket; stop it first (agent-chat service stop --hold 300)')
  if (!fs.existsSync(file)) fail(`${file} does not exist; nothing to backfill`)
  const events = new EventLog(file)
  try {
    const options = { fence: { supervisorId: shadowSupervisorId(), generation: 1 }, sinceDays: opts.since }
    if (opts.dryRun) printPlan(planFromSource(events, options))
    else printOutcome(events, options)
  } finally {
    events.close()
  }
}

function printOutcome(events: BackfillSource, options: Parameters<typeof runBackfill>[1]): void {
  const { planned, applied, rejected } = runBackfill(events, options)
  for (const miss of rejected) console.log(`rejected ${miss.agentId}: ${miss.reason}`)
  console.log(`planned ${planned.length}, applied ${applied}, rejected ${rejected.length}`)
  if (rejected.length > 0) process.exitCode = 1
}

/** One line per agent: name, id, planned phases, and where each value came from. */
function printPlan(rows: PlannedRow[]): void {
  for (const row of rows) {
    const sources = row.sources.map(s => `${s.field}=${s.value} (${s.from})`).join(' ')
    console.log(`${row.name} ${row.agentId} ${row.phases.join('>')} ${sources}`)
  }
}

function fail(message: string): never {
  console.error(`agent-chat lifecycle backfill: ${message}`)
  process.exit(1)
}
