import { z } from 'zod'
import { defaultAutonomyRoot } from '../../agents/seats/io.js'
import { liveBriefPorts, type BriefSystem } from '../../agents/seats/operator-brief-read.js'
import { liveBriefSystem, operatorBriefReport } from '../../cli/verbs/operator-brief.js'
import { home } from '../../paths.js'
import { defineTool, type Tool, type ToolContext } from '../command.js'

/** CC-1551: the CLI verb's model and renderer over this session's own broker connection. */

const REPLY = { agents: 'agents_result', queue: 'queue_result' } as const

const liveToolSystem = (ctx: ToolContext): BriefSystem => ({
  ...liveBriefSystem(defaultAutonomyRoot()),
  broker: frame => ctx.broker.request(frame, REPLY[frame.t]),
})

interface BriefToolArgs {
  seat?: string[] | undefined
}

/** Takes the system as a port, so a test drives the tool and the CLI from one fixture. */
export function makeOperatorBrief(system: (ctx: ToolContext) => BriefSystem): Tool<BriefToolArgs> {
  return defineTool({
    name: 'operator_brief',
    description:
      'Read-only status per coordinator seat: agents, Shepherd PRs and gates, unread, pools, stop, ' +
      'burndown, owner queue. Same text as `agent-chat operator-brief`.',
    args: z.object({
      seat: z.array(z.string()).describe('Only these seats.').optional(),
    }),
    result: z.string(),
    async run({ seat }, ctx) {
      const sys = system(ctx)
      const report = await operatorBriefReport(
        liveBriefPorts(sys),
        seat === undefined ? {} : { seat },
        sys.now(),
        [sys.autonomyRoot, home(), sys.homeDir],
      )
      return report.lines.join('\n')
    },
  })
}

export const operatorBrief = makeOperatorBrief(liveToolSystem)
