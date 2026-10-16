import path from 'node:path'
import { z } from 'zod'
import { coordinatorSeats } from '../../agents/seats/coordinators.js'
import { defaultAutonomyRoot, readText } from '../../agents/seats/io.js'
import { defineVerb, Report } from '../command.js'

export const seatsCoordinatorsVerb = defineVerb({
  name: 'seats.coordinators',
  description:
    "print the coordinator seats a seat merge waits on (CC-1348): the charter's seats plus tp-operator, " +
    'on one space-separated line. Exits non-zero when the charter is unreadable or lists no seats',
  args: z.object({ root: z.string().optional() }),
  result: Report,
  cli: {
    options: {
      root: { long: '--root', description: 'autonomy directory holding charter.md' },
    },
  },
  async run({ root }) {
    const charterPath = path.join(root ?? defaultAutonomyRoot(), 'charter.md')
    const charter = readText(charterPath)
    if (charter === undefined) return { ok: false, lines: [], errors: [`cannot read ${charterPath}`] }
    const seats = coordinatorSeats(charter)
    if (seats.length === 0) return { ok: false, lines: [], errors: [`${charterPath} lists no seats`] }
    return { ok: true, lines: [seats.join(' ')] }
  },
})
