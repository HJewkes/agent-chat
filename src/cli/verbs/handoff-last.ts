import path from 'node:path'
import { z } from 'zod'
import { openEvents } from '../../agents/seats/io.js'
import { requiredString } from '../../args.js'
import { lastHandoff, type StoredHandoff } from '../../broker/handoffs.js'
import { home } from '../../paths.js'
import { defineVerb, Report } from '../command.js'

/** What became of the teleport a handoff was written for. */
function fate(handoff: StoredHandoff): string {
  if (handoff.delivered) return `its successor ${handoff.successorId} registered`
  if (handoff.committed) return `its successor ${handoff.successorId} never registered`
  return 'the teleport did not go through (aborted, or still counting down)'
}

/** CC-524: read straight from events.db, so a handoff can be printed while the broker is down. */
export function handoffLastReport(dbPath: string, name: string): Report {
  let handoff: StoredHandoff | undefined
  try {
    const db = openEvents(dbPath)
    try {
      handoff = lastHandoff(db, name)
    } finally {
      db.close()
    }
  } catch (err) {
    return { ok: false, lines: [], errors: [`cannot read ${dbPath}: ${(err as Error).message}`] }
  }
  if (handoff === undefined) return { ok: false, lines: [], errors: [`no stored handoff for "${name}"`] }
  const header = `handoff ${handoff.msgId} from ${name} at ${new Date(handoff.at).toISOString()}: ${fate(handoff)}`
  return { ok: true, lines: [header, '', ...handoff.text.split('\n')] }
}

export const handoffLastVerb = defineVerb({
  name: 'handoff.last',
  description: 'print the latest handoff a session stored when it teleported',
  args: z.object({ name: requiredString('name') }),
  result: Report,
  cli: { positional: ['name'] },
  async run({ name }) {
    return handoffLastReport(path.join(home(), 'events.db'), name)
  },
})
