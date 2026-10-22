import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAccountBudget } from '../agents/budget.js'
import {
  liveBriefPorts,
  readOperatorBrief,
  type AsyncRunner,
  type BriefFrame,
  type BriefSystem,
} from '../agents/seats/operator-brief-read.js'
import { plainError } from '../agents/seats/status.js'
import { EventLog } from '../broker/event-log.js'
import { operatorBriefReport } from '../cli/verbs/operator-brief.js'
import type { AgentIdentity } from '../protocol.js'

/** CC-1551: the operator brief over its live ports, driven from a fixture root and spies. Everything is synthetic. */

const NOW = new Date('2026-10-10T12:00:00.000Z')
const SEATS = ['aa-coord', 'bb-coord']
const FIXTURE_CHARTER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'score-2026-09-29',
  'charter.md',
)
const CHARTER = fs
  .readFileSync(FIXTURE_CHARTER, 'utf8')
  .replace(/^seats: .*$/m, `seats: [${SEATS.join(', ')}]`)
const seatFile = (name: string, prefix: string): string =>
  `---\nschema: autonomy-seat/v1\nname: ${name}\nrole: product\nprefix: ${prefix}\npool: pool-a\n` +
  `concurrency: {implementers: 3, reviewers: 2, planners: 1}\n---\n`

const runs = [
  {
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
  },
]
const waiting = { owner: [], seat: [] }

let tmp: string
let events: EventLog
let frames: string[]
let execs: string[][]

const agent = (over: Partial<AgentIdentity>): AgentIdentity =>
  ({
    agentId: 'id',
    name: 'aa-impl',
    profile: 'implementer',
    state: 'running',
    spawnedBy: 'aa-coord',
    ...over,
  }) as AgentIdentity

const shepherdAnswers: AsyncRunner = async (_bin, args) =>
  args[1] === 'waiting'
    ? { status: 1, stdout: JSON.stringify(waiting) }
    : { status: 0, stdout: JSON.stringify(runs) }

function system(exec: AsyncRunner = shepherdAnswers): BriefSystem {
  return {
    autonomyRoot: path.join(tmp, 'autonomy'),
    activeWorkRoot: path.join(tmp, 'aw'),
    homeDir: tmp,
    eventsDb: path.join(tmp, 'events.db'),
    pacePath: path.join(tmp, 'pace.json'),
    burndownPausePath: path.join(tmp, 'burndown.paused'),
    burndownTicksPath: path.join(tmp, 'burndown-ticks.jsonl'),
    now: () => NOW,
    broker: async (frame: BriefFrame) => {
      frames.push(frame.t)
      return frame.t === 'agents' ? { agents: [agent({})] } : { items: [] }
    },
    exec: async (bin, args) => {
      execs.push([bin, ...args])
      return exec(bin, args)
    },
    readBudget: (dir, nowMs) => readAccountBudget(dir, nowMs),
    machineStop: () => null,
  }
}

const brief = async (args: Parameters<typeof operatorBriefReport>[1] = {}, sys = system()) => {
  const report = await operatorBriefReport(liveBriefPorts(sys), args, NOW, [tmp])
  expect(report.ok).toBe(true)
  return report.lines
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-operator-brief-')))
  const root = path.join(tmp, 'autonomy')
  fs.mkdirSync(path.join(root, 'seats'), { recursive: true })
  fs.writeFileSync(path.join(root, 'charter.md'), CHARTER)
  for (const [name, prefix] of [
    ['aa-coord', 'aa'],
    ['bb-coord', 'bb'],
  ] as const)
    fs.writeFileSync(path.join(root, 'seats', `${name}.md`), seatFile(name, prefix))
  fs.mkdirSync(path.join(tmp, 'aw', 'init', 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'aw', 'init', 'tasks', 't-1.yml'), 'id: T-1\nstatus: in-progress\n')
  events = new EventLog(path.join(tmp, 'events.db'))
  events.append({ kind: 'message', actor: 'someone', target: 'aa-coord', msgId: 'm1', body: 'hello' })
  frames = []
  execs = []
})

afterEach(() => {
  events.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('agent-chat operator-brief', () => {
  it('sends only read frames to the broker and runs only Shepherd status and waiting', async () => {
    await brief()

    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every(t => ['agents', 'queue', 'list'].includes(t))).toBe(true)
    expect(execs.length).toBe(2)
    for (const [bin, , verb] of execs) {
      expect(bin).toBe('titan-factory')
      expect(['status', 'waiting']).toContain(verb)
    }
  })

  it('still gives the agent and inbox lines when Shepherd is down', async () => {
    const down: AsyncRunner = async () => {
      throw new Error('serve is down')
    }

    const text = (await brief({}, system(down))).join('\n')

    expect(text).toContain('unavailable: shepherd (serve is down)')
    expect(text).toContain('== aa-coord  impl 1/3 rev 0/2 · unread 1')
    expect(text).toContain('  live: aa-impl')
  })

  it('gives a block with caps n/a to the operator, whom the charter does not list', async () => {
    const lines = await brief()

    expect(lines.some(l => l.startsWith('== tp-operator  impl 0/n/a rev 0/n/a · '))).toBe(true)
    expect(lines.some(l => l.startsWith('unavailable: seats'))).toBe(false)
  })

  it('prints the whole model as one JSON object with each PR task status', async () => {
    const [line] = await brief({ json: true })

    const expected = await readOperatorBrief(liveBriefPorts(system()), {
      now: NOW,
      plain: err => plainError(err, [tmp]),
    })
    const parsed = JSON.parse(line as string) as typeof expected
    expect(parsed).toEqual(JSON.parse(JSON.stringify(expected)))
    expect(parsed.seats[0]?.prs).toMatchObject([{ pr: 'acme/widgets#5', taskStatus: 'in-progress' }])
  })

  it('prints only the asked seat block under the header', async () => {
    const lines = await brief({ seat: ['bb-coord'] })

    expect(lines[0]).toBe('operator-brief 2026-10-10T12:00Z')
    expect(lines.filter(l => l.startsWith('== '))).toEqual([expect.stringMatching(/^== bb-coord /)])
  })
})
