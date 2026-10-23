import path from 'node:path'
import { z } from 'zod'
import { liveCoordinators } from '../../agents/seats/coordinators.js'
import { readAgentEvents } from '../../agents/seats/io.js'
import { home } from '../../paths.js'
import { defineVerb, Report } from '../command.js'

export const seatsCoordinatorsVerb = defineVerb({
  name: 'seats.coordinators',
  description:
    'print the coordinator seats a seat merge waits on (CC-1559): every coordinator-role agent the ' +
    'event log shows spawning, live or detached, on one space-separated line. Exits non-zero when ' +
    'events.db is unreadable or no coordinator is live',
  args: z.object({ db: z.string().optional() }),
  result: Report,
  cli: {
    options: {
      db: { long: '--db', description: 'events.db to read (default: the broker home)' },
    },
  },
  async run({ db }) {
    const dbPath = db ?? path.join(home(), 'events.db')
    let rows
    try {
      rows = readAgentEvents(dbPath, Number.MAX_SAFE_INTEGER)
    } catch (err) {
      return { ok: false, lines: [], errors: [`cannot read ${dbPath}: ${(err as Error).message}`] }
    }
    const seats = liveCoordinators(rows)
    if (seats.length === 0) return { ok: false, lines: [], errors: [`${dbPath} shows no live coordinator`] }
    return { ok: true, lines: [seats.join(' ')] }
  },
})
