import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentIdentity } from '../protocol.js'

/**
 * CC-491: one figure per account, from the freshest reading on it. Two rows of
 * one name 46 h apart fell in the same weekly window, so they carried the same
 * resets_at, and the older one (33%) read as current beside the newer (79%).
 */

const roster = vi.hoisted(() => ({ agents: [] as unknown[] }))

vi.mock('../cli/client.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../cli/client.js')>()),
  withBroker: async <T>(fn: (b: unknown) => Promise<T>): Promise<T> =>
    fn({ request: async () => ({ t: 'agents_result', agents: roster.agents }) }),
}))

const { agentBudget } = await import('../cli/agents.js')
const { sessionBudget } = await import('../server/commands/session-budget.js')
const { agentList } = await import('../server/commands/agent-list.js')

const NOW_S = 1_800_000_000
const HOUR = 3600
const WEEK_RESET = NOW_S + 3 * 24 * HOUR

let root: string
let workout: string
let agents: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-cc491-'))
  workout = path.join(root, 'workout')
  agents = path.join(root, 'agents')
  vi.spyOn(Date, 'now').mockReturnValue(NOW_S * 1000)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

const writeReading = (dir: string, sessionId: string, writtenAt: number, sevenDay: number): void => {
  const cache = path.join(dir, 'status-cache', 'sessions')
  fs.mkdirSync(cache, { recursive: true })
  fs.writeFileSync(
    path.join(cache, `${sessionId}.json`),
    JSON.stringify({
      session_id: sessionId,
      model_id: 'claude-opus-5',
      written_at: writtenAt,
      context: { used_pct: 30, window_size: 200000, exceeds_200k: false },
      rate_limits: { seven_day: { used_percentage: sevenDay, resets_at: WEEK_RESET } },
    }),
  )
}

const identity = (over: Partial<AgentIdentity>): AgentIdentity => ({
  agentId: 'a1',
  name: 'coord',
  profile: 'opus-coordinator',
  state: 'exited',
  origin: 'adopted',
  spawnedBy: 'coord',
  spawnedAt: 0,
  brief: '',
  cwd: '/repo',
  isolation: 'none',
  surface: 'headless',
  sessionId: 'sess-new',
  configDir: workout,
  lastEventAt: 0,
  generation: 1,
  ...over,
})

/** The incident: same name, same account, same resets_at, 46 h apart. */
function twoRowsOfOneName(): AgentIdentity[] {
  writeReading(workout, 'sess-new', NOW_S - 60, 79)
  writeReading(workout, 'sess-old', NOW_S - 46 * HOUR, 33)
  return [
    identity({ agentId: 'old', sessionId: 'sess-old', lastEventAt: (NOW_S - 46 * HOUR) * 1000 }),
    identity({ agentId: 'new', sessionId: 'sess-new', lastEventAt: (NOW_S - 60) * 1000 }),
  ]
}

const jsonOf = (out: string): Record<string, unknown> =>
  JSON.parse(out.slice(out.indexOf('json: ') + 'json: '.length)) as Record<string, unknown>

describe('agent budget <name> with two rows of one name', () => {
  it('reports only the newer row and the account figure from the freshest reading', async () => {
    roster.agents = twoRowsOfOneName()

    const report = await agentBudget('coord')

    expect(report.lines).toHaveLength(1)
    const [out] = report.lines as [string]
    expect(out).toContain('seven_day 79%')
    expect(out).not.toContain('33%')
    expect(jsonOf(out)).toMatchObject({
      session_id: 'sess-new',
      account: { name: 'workout', stale: false, rate_limits: { seven_day: { used_pct: 79 } } },
    })
  })

  it('skips a retired row even when it is the newest', async () => {
    const rows = twoRowsOfOneName()
    roster.agents = [rows[0], { ...rows[1], state: 'retired' }]

    const report = await agentBudget('coord')

    expect(report.lines).toHaveLength(1)
    expect(jsonOf(report.lines[0]!)).toMatchObject({ session_id: 'sess-old' })
  })
})

describe('session_budget with two rows of one name', () => {
  it('reports only the newer row', async () => {
    const rows = twoRowsOfOneName()
    const ctx = {
      registeredName: 'me',
      broker: { request: async () => ({ t: 'agents_result', agents: rows }) },
    } as never

    const out = await sessionBudget.run({ name: 'coord' }, ctx)

    expect(out).toContain('seven_day 79%')
    expect(out).not.toContain('33%')
    expect(jsonOf(out)).toMatchObject({ session_id: 'sess-new', account: { name: 'workout' } })
  })
})

describe('an account whose freshest reading is past 15 minutes', () => {
  it('is shown stale with its age, never as the account figure', async () => {
    writeReading(workout, 'sess-old', NOW_S - 46 * HOUR, 33)
    roster.agents = [identity({ sessionId: 'sess-old' })]

    const [out] = (await agentBudget('coord')).lines as [string]

    expect(out).toContain(`Account on workout: STALE — newest reading is ${46 * HOUR}s old`)
    expect(out).not.toContain('seven_day 33%')
    const account = jsonOf(out).account as Record<string, unknown>
    expect(account).toMatchObject({ name: 'workout', stale: true, age_seconds: 46 * HOUR })
    expect(account).not.toHaveProperty('rate_limits')
  })
})

describe('the chat_list header', () => {
  it('shows a freshest row past 15 minutes as stale, not as the account figure', async () => {
    writeReading(workout, 'sess-old', NOW_S - 46 * HOUR, 33)
    const { accountUsageLine, readBudget } = await import('../agents/budget.js')

    const line = accountUsageLine([{ name: 'coord', read: readBudget('sess-old', NOW_S * 1000, workout) }])

    expect(line).toBe(
      `Account usage: STALE — newest reading (coord's) is ${46 * HOUR}s old, not a current figure.`,
    )
  })
})

describe('the agent_list header', () => {
  it('shows one line per account, read from the account even when every row is transcript-only', async () => {
    writeReading(workout, 'usage-poller', NOW_S - 30, 79)
    writeReading(agents, 'usage-poller', NOW_S - 20 * 60, 12)
    const ctx = {
      registeredName: 'me',
      broker: {
        request: async () => ({
          t: 'agents_result',
          agents: [
            identity({ name: 'w1', state: 'live', sessionId: 'headless-w1' }),
            identity({ name: 'w2', state: 'live', sessionId: 'headless-w2' }),
            identity({ name: 'a1', state: 'live', sessionId: 'headless-a1', configDir: agents }),
          ],
          slots: { held: 3, cap: 30 },
        }),
      },
    } as never

    const out = await agentList.run({}, ctx)

    const header = out.split('\n').filter(line => line.startsWith('Account usage'))
    expect(header).toEqual([
      'Account usage on workout (30s old): seven_day 79%. · slots 3/30',
      `Account usage on agents: STALE — newest reading is ${20 * 60}s old, not a current figure.`,
    ])
  })
})
