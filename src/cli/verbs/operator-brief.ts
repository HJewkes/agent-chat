import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { activeWorkRoot } from '../../agents/active-work.js'
import { readAccountBudget } from '../../agents/budget.js'
import { defaultAutonomyRoot } from '../../agents/seats/io.js'
import { renderOperatorBrief } from '../../agents/seats/operator-brief.js'
import {
  execAsync,
  liveBriefPorts,
  readOperatorBrief,
  type BriefSystem,
  type OperatorBriefPorts,
} from '../../agents/seats/operator-brief-read.js'
import { pacePath } from '../../agents/seats/pace-pass.js'
import { plainError } from '../../agents/seats/status.js'
import { burndownPausePath, burndownTicksPath, home } from '../../paths.js'
import { defineVerb, Report } from '../command.js'
import { withRunningBroker } from './seat-broker.js'
import { readMachineStop } from './seats.js'

/** CC-1551: one read-only call for what a coordinator re-read after every action. */

const REPLY = { agents: 'agents_result', queue: 'queue_result' } as const

export function liveBriefSystem(root: string): BriefSystem {
  return {
    autonomyRoot: root,
    activeWorkRoot: activeWorkRoot(),
    homeDir: os.homedir(),
    eventsDb: path.join(home(), 'events.db'),
    pacePath: pacePath(),
    burndownPausePath: burndownPausePath(),
    burndownTicksPath: burndownTicksPath(),
    now: () => new Date(),
    broker: frame => withRunningBroker(client => client.request(frame, REPLY[frame.t])),
    exec: execAsync,
    readBudget: (dir, nowMs) => readAccountBudget(dir, nowMs),
    machineStop: () => readMachineStop(),
  }
}

export interface BriefArgs {
  seat?: string[]
  json?: boolean
  maxLines?: number
}

/** The verb's body over explicit ports, so a test can drive it from fixtures and spies. */
export async function operatorBriefReport(
  ports: OperatorBriefPorts,
  args: BriefArgs,
  now: Date,
  dirs: string[],
): Promise<Report> {
  const show = args.seat === undefined || args.seat.length === 0 ? undefined : args.seat
  const brief = await readOperatorBrief(ports, {
    now,
    ...(show === undefined ? {} : { show }),
    plain: err => plainError(err, dirs),
  })
  const lines = args.json === true ? [JSON.stringify(brief)] : renderOperatorBrief(brief, args)
  return { ok: true, lines }
}

export const operatorBriefVerb = defineVerb({
  name: 'operator-brief',
  description:
    'one read-only status block per coordinator seat: live and finished agents, Shepherd PRs and gates, ' +
    'unread count, plus pools, the machine stop, burndown and the owner queue. Never runs gh',
  args: z.object({
    seat: z.array(z.string()).optional(),
    json: z.boolean().optional(),
    root: z.string().optional(),
    maxLines: z.number().int().positive().optional(),
  }),
  result: Report,
  cli: {
    options: {
      seat: {
        long: '--seat',
        description: 'only this seat (repeatable); a seat the charter omits still gets a block',
      },
      json: { long: '--json', description: 'print the whole brief as one JSON object, never cut' },
      root: { long: '--root', description: 'autonomy directory holding charter.md and seats/' },
      maxLines: { long: '--max-lines', description: 'cut the text to this many lines (default 60)' },
    },
  },
  async run({ seat, json, root, maxLines }) {
    const sys = liveBriefSystem(root ?? defaultAutonomyRoot())
    const args = { ...(seat === undefined ? {} : { seat }), ...(json === undefined ? {} : { json }) }
    return operatorBriefReport(
      liveBriefPorts(sys),
      { ...args, ...(maxLines === undefined ? {} : { maxLines }) },
      sys.now(),
      [sys.autonomyRoot, home(), sys.homeDir],
    )
  },
})
