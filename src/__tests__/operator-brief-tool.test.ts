import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAccountBudget } from '../agents/budget.js'
import { liveBriefPorts, type BriefFrame, type BriefSystem } from '../agents/seats/operator-brief-read.js'
import { EventLog } from '../broker/event-log.js'
import { operatorBriefReport } from '../cli/verbs/operator-brief.js'
import { invokeTool, type ToolContext } from '../server/command.js'
import { makeOperatorBrief } from '../server/commands/operator-brief.js'
import { TOOL_DEFINITIONS } from '../server/tools.js'
import type { AgentIdentity } from '../protocol.js'

/** CC-1551 S4: the operator_brief MCP tool over the same fixture ports as the CLI verb. Everything is synthetic. */

const NOW = new Date('2026-10-10T12:00:00.000Z')
const SEATS = ['aa-coord', 'bb-coord']
const FIXTURE_CHARTER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'score-2026-09-29',
  'charter.md',
)
const seatFile = (name: string, prefix: string): string =>
  `---\nschema: autonomy-seat/v1\nname: ${name}\nrole: product\nprefix: ${prefix}\npool: pool-a\n` +
  `concurrency: {implementers: 3, reviewers: 2, planners: 1}\n---\n`

const run = {
  repo: 'acme/widgets',
  pr: 5,
  branch: 'agent-chat/aa-five',
  runId: 'r5',
  task: 'init/T-1',
  phase: 'fixing',
  headSha: 'c'.repeat(40),
  nextAction: null,
  pendingGate: null,
  implementer: 'aa-impl',
  held: null,
  stalled: null,
}

let tmp: string
let events: EventLog

const agent = { agentId: 'id', name: 'aa-impl', profile: 'implementer', state: 'running', spawnedBy: 'aa-coord' }

function system(): BriefSystem {
  return {
    autonomyRoot: path.join(tmp, 'autonomy'),
    activeWorkRoot: path.join(tmp, 'aw'),
    homeDir: tmp,
    eventsDb: path.join(tmp, 'events.db'),
    pacePath: path.join(tmp, 'pace.json'),
    burndownPausePath: path.join(tmp, 'burndown.paused'),
    burndownTicksPath: path.join(tmp, 'burndown-ticks.jsonl'),
    now: () => NOW,
    broker: async (frame: BriefFrame) =>
      frame.t === 'agents' ? { agents: [agent as AgentIdentity] } : { items: [] },
    exec: async (_bin, args) =>
      args[1] === 'waiting'
        ? { status: 1, stdout: JSON.stringify({ owner: [], seat: [] }) }
        : { status: 0, stdout: JSON.stringify([run]) },
    readBudget: (dir, nowMs) => readAccountBudget(dir, nowMs),
    machineStop: () => null,
  }
}

const ctx = { warnings: [], format: 'human', registeredName: 'tp-operator' } as unknown as ToolContext

async function toolText(args: Record<string, unknown>): Promise<string> {
  const reply = await invokeTool(makeOperatorBrief(system), args, ctx)
  return reply.content[0]?.text ?? ''
}

async function cliText(args: { seat?: string[] }): Promise<string> {
  const sys = system()
  const report = await operatorBriefReport(liveBriefPorts(sys), args, NOW, [sys.autonomyRoot, tmp])
  return report.lines.join('\n')
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-operator-brief-tool-')))
  const root = path.join(tmp, 'autonomy')
  fs.mkdirSync(path.join(root, 'seats'), { recursive: true })
  const charter = fs.readFileSync(FIXTURE_CHARTER, 'utf8').replace(/^seats: .*$/m, `seats: [${SEATS.join(', ')}]`)
  fs.writeFileSync(path.join(root, 'charter.md'), charter)
  fs.writeFileSync(path.join(root, 'seats', 'aa-coord.md'), seatFile('aa-coord', 'aa'))
  fs.writeFileSync(path.join(root, 'seats', 'bb-coord.md'), seatFile('bb-coord', 'bb'))
  fs.mkdirSync(path.join(tmp, 'aw', 'init', 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'aw', 'init', 'tasks', 't-1.yml'), 'id: T-1\nstatus: in-progress\n')
  events = new EventLog(path.join(tmp, 'events.db'))
  events.append({ kind: 'message', actor: 'someone', target: 'aa-coord', msgId: 'm1', body: 'hello' })
})

afterEach(() => {
  events.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('operator_brief tool', () => {
  it('gives the same text as the CLI verb for the same ports', async () => {
    const text = await toolText({})

    expect(text).toBe(await cliText({}))
    expect(text).toContain('== aa-coord  impl 1/3 rev 0/2 · unread 1')
  })

  it('narrows the output to the asked seat like --seat', async () => {
    const text = await toolText({ seat: ['bb-coord'] })

    expect(text).toBe(await cliText({ seat: ['bb-coord'] }))
    expect(text.split('\n').filter(l => l.startsWith('== '))).toEqual([expect.stringMatching(/^== bb-coord /)])
  })

  it('is in the published tool list', () => {
    const names = TOOL_DEFINITIONS.map(t => t.name)

    expect(names).toContain('operator_brief')
  })
})
