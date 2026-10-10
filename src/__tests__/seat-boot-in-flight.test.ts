import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Claim } from '../agents/burndown/ledger.js'
import type { BootDeps } from '../agents/seats/boot.js'
import {
  claimsPort,
  eventsVerdictsPort,
  parseShepherdFlights,
  shepherdPort,
} from '../agents/seats/in-flight-read.js'
import type { AgentIdentity } from '../protocol.js'
import { EventLog } from '../broker/event-log.js'
import { bootReport } from '../cli/verbs/seats.js'

/**
 * CC-934: `seats boot` prints In flight from claims, Shepherd rows, the roster and verdicts.
 * Every repo, PR, sha, agent and path is synthetic.
 */

const SEAT = 'sample-coord'
const PR_A = 'acme/widgets#12'
const HEAD_A = 'a'.repeat(40)
const OLD_HEAD = 'b'.repeat(40)
const SEAT_FILE = `---\nname: ${SEAT}\nprefix: sc\npool: pool-a\n---\n# ${SEAT}\n`
const QUEUE = `# Queue\n\n## In flight\n\n- HAND-KEPT ROW sc-stale\n\n## Next\n\n1. task B\n`

let tmp: string
let root: string
let events: EventLog

const claim = (over: Partial<Claim>): Claim =>
  ({
    taskId: 'T-1',
    initiative: 'init',
    spawnedAt: '2026-10-10T00:00:00.000Z',
    phase: 'implementing',
    phaseAt: '2026-10-10T00:00:00.000Z',
    seat: SEAT,
    ...over,
  }) as Claim

const agent = (over: Partial<AgentIdentity>): AgentIdentity =>
  ({
    agentId: 'id',
    name: 'sc-impl',
    profile: 'implementer',
    state: 'running',
    spawnedBy: SEAT,
    cwd: path.join(os.homedir(), 'wt', 'one'),
    ...over,
  }) as AgentIdentity

const shepherdRows = [
  {
    repo: 'acme/widgets',
    pr: 12,
    branch: 'agent-chat/sc-task-one',
    runId: 'r1',
    task: 'init/T-1',
    phase: 'review',
    headSha: HEAD_A,
    nextAction: 'wait for review',
    pendingGate: null,
    held: null,
    stalled: null,
  },
  {
    repo: 'acme/widgets',
    pr: 40,
    branch: 'agent-chat/other-task',
    runId: 'r2',
    task: 'init/T-9',
    phase: 'ci',
    headSha: 'c'.repeat(40),
    nextAction: null,
    pendingGate: null,
    held: null,
    stalled: null,
  },
]

const verdictBody = (verdict: string, pr: string, head: string): string =>
  `Verdict: ${verdict}\nPR: ${pr}\nHead: ${head}\n`

function deps(over: Partial<BootDeps['inFlight']> = {}): BootDeps {
  return {
    now: () => new Date(2026, 9, 10, 12, 0),
    autonomyRoot: root,
    homeDir: os.homedir(),
    eventsDb: path.join(tmp, 'events.db'),
    status: async () => {
      throw new Error('no broker')
    },
    inFlight: {
      roster: async () => [agent({}), agent({ name: 'elsewhere-x', spawnedBy: 'someone' })],
      shepherd: shepherdPort(() => ({ status: 0, stdout: JSON.stringify(shepherdRows) })),
      verdicts: eventsVerdictsPort(path.join(tmp, 'events.db')),
      claims: claimsPort(path.join(tmp, 'burndown.json')),
      ...over,
    },
  }
}

const boot = async (over: Partial<BootDeps['inFlight']> = {}): Promise<string[]> => {
  const report = await bootReport(deps(over), SEAT, undefined, false)
  expect(report.ok).toBe(true)
  return report.lines
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-boot-flight-')))
  root = path.join(tmp, 'autonomy')
  fs.mkdirSync(path.join(root, 'seats'), { recursive: true })
  fs.mkdirSync(path.join(root, 'queues'), { recursive: true })
  fs.writeFileSync(path.join(root, 'seats', `${SEAT}.md`), SEAT_FILE)
  fs.writeFileSync(path.join(root, 'queues', `${SEAT}.md`), QUEUE)
  events = new EventLog(path.join(tmp, 'events.db'))
  events.append({
    kind: 'message',
    actor: 'rev',
    target: SEAT,
    msgId: 'v1',
    body: verdictBody('FIX_FIRST', PR_A, OLD_HEAD),
  })
  events.append({
    kind: 'message',
    actor: 'rev',
    target: SEAT,
    msgId: 'v2',
    body: verdictBody('MERGE', PR_A, HEAD_A),
  })
  fs.writeFileSync(
    path.join(tmp, 'burndown.json'),
    JSON.stringify({
      version: 1,
      claims: [
        claim({
          taskId: 'T-1',
          pr: `https://github.com/${PR_A.replace('#', '/pull/')}`,
          agentName: 'sc-impl',
        }),
        claim({ taskId: 'T-2', phase: 'done' }),
        claim({ taskId: 'T-3', seat: 'other-seat' }),
        claim({ taskId: 'T-4', slice: 'b', phase: 'queued' }),
      ],
    }),
  )
})

afterEach(() => {
  events.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('In flight', () => {
  it('prints the PR with head, verdict and CI from fixtures and not the queue file section', async () => {
    const text = (await boot()).join('\n')

    expect(text).toContain(
      `pr ${PR_A} | head ${HEAD_A.slice(0, 8)} | verdict MERGE | ci passed | phase review | task init/T-1 | agent sc-impl`,
    )
    expect(text).toContain('next wait for review')
    expect(text).not.toContain('HAND-KEPT ROW')
    expect(text).toContain('1. task B')
  })

  it('leaves out other seats, finished claims and Shepherd rows off the seat prefix', async () => {
    const text = (await boot()).join('\n')

    expect(text).not.toContain('acme/widgets#40')
    expect(text).not.toContain('T-3')
    expect(text).not.toContain('T-2')
    expect(text).not.toContain('elsewhere-x')
  })

  it('names a claim with no PR and no agent, in one line', async () => {
    const lines = await boot()

    expect(lines).toContain('claim T-4/b queued | no PR, no agent on the roster')
  })

  it('marks a verdict for an older head as stale', async () => {
    const rows = [{ ...shepherdRows[0], headSha: 'd'.repeat(40) }]
    const lines = await boot({ shepherd: async () => parseShepherdFlights(JSON.stringify(rows)) })

    expect(lines.join('\n')).toContain(`verdict MERGE (stale, at ${HEAD_A.slice(0, 8)})`)
  })

  it('prints one unavailable line per failed source and keeps the rest', async () => {
    const lines = await boot({
      shepherd: async () => {
        throw new Error('shepherd down')
      },
      roster: async () => {
        throw new Error('broker down')
      },
    })

    expect(lines.filter(l => /^unavailable: (roster|shepherd|verdicts|claims)$/.test(l)).sort()).toEqual([
      'unavailable: roster',
      'unavailable: shepherd',
    ])
    expect(lines.join('\n')).toContain(
      `pr ${PR_A} | head ? | verdict MERGE (stale, at ${HEAD_A.slice(0, 8)})`,
    )
    expect(lines).toContain('== queue ' + path.join(root, 'queues', `${SEAT}.md`))
  })
})

describe('the Shepherd port', () => {
  it('throws when the status exits non-zero, so the boot reports it unavailable', async () => {
    const port = shepherdPort(() => ({ status: 1, stdout: '' }))

    await expect(port()).rejects.toThrow()
  })

  it('skips a malformed row and reads pendingGate and held', () => {
    const rows = parseShepherdFlights(
      JSON.stringify([
        { repo: 'acme/widgets' },
        { ...shepherdRows[0], pendingGate: { kind: 'approval' }, held: { reason: 'owner' } },
      ]),
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ pendingGate: 'approval', held: true })
  })
})
