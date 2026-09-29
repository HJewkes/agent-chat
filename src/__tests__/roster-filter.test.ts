import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentIdentity } from '../protocol.js'
import { callerName, filterRoster } from '../agents/roster-filter.js'

const roster = vi.hoisted(() => ({ agents: [] as unknown[] }))

vi.mock('../cli/client.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../cli/client.js')>()),
  withBroker: async <T>(fn: (b: unknown) => Promise<T>): Promise<T> =>
    fn({
      request: async (message: { t: string }) =>
        message.t === 'agents'
          ? { t: 'agents_result', agents: roster.agents }
          : { t: 'list_result', sessions: [] },
    }),
}))

const { buildProgram } = await import('../cli/index.js')
const { agentList } = await import('../server/commands/agent-list.js')

const agent = (name: string, spawnedBy: string): AgentIdentity => ({
  agentId: `id-${name}`,
  name,
  profile: 'implementer',
  state: 'exited',
  origin: 'spawned',
  spawnedBy,
  spawnedAt: 1,
  brief: 'b',
  cwd: '/tmp/roster-filter-nowhere',
  isolation: 'none',
  surface: 'headless',
  sessionId: '',
  lastEventAt: 2,
  generation: 1,
})

// Eleven agents across three spawners; "boss" owns three, two of them under the "cc-" prefix.
const TEN = [
  ...['cc-a', 'cc-b', 'x-c'].map(n => agent(n, 'boss')),
  ...['cc-d', 'y-e', 'y-f', 'y-g'].map(n => agent(n, 'other')),
  ...['z-h', 'z-i', 'cc-j'].map(n => agent(n, 'human')),
  // Contains the prefix without starting with it: a substring match would wrongly keep it.
  agent('old-cc-k', 'human'),
]
const names = (agents: AgentIdentity[]) => agents.map(a => a.name)

describe('filterRoster', () => {
  it('keeps only the three agents the caller spawned out of eleven', () => {
    expect(names(filterRoster(TEN, { spawner: 'boss' }))).toEqual(['cc-a', 'cc-b', 'x-c'])
  })

  it('keeps only agents whose name starts with the prefix', () => {
    expect(names(filterRoster(TEN, { prefix: 'cc-' }))).toEqual(['cc-a', 'cc-b', 'cc-d', 'cc-j'])
  })

  it('combines mine and prefix', () => {
    expect(names(filterRoster(TEN, { spawner: 'boss', prefix: 'cc-' }))).toEqual(['cc-a', 'cc-b'])
  })

  it('counts an agent spawned by a predecessor sharing the callers name as the callers', () => {
    const predecessor = { ...agent('boss', 'human'), state: 'retired' as const }
    const successor = agent('boss', 'human')
    const child = agent('child', 'boss')
    expect(names(filterRoster([predecessor, successor, child], { spawner: 'boss' }))).toEqual(['child'])
  })

  it('returns everything with no filter', () => {
    expect(filterRoster(TEN, {})).toHaveLength(11)
  })
})

describe('callerName', () => {
  it('fails clearly, pointing at --spawner, when the shell has no session name', () => {
    expect(() => callerName({})).toThrow(/--spawner <your registered name>/)
  })
})

describe('agent ls / budget filters', () => {
  const logs: string[] = []
  beforeEach(() => {
    roster.agents = TEN
    logs.length = 0
    vi.stubEnv('AGENT_CHAT_NAME', 'boss')
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logs.push(args.join(' ')))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })
  const run = (...argv: string[]) => buildProgram().parseAsync(['node', 'agent-chat', 'agent', ...argv])

  it("ls --mine --json prints only the caller's three agents", async () => {
    await run('ls', '--mine', '--json')
    expect(JSON.parse(logs.join('\n')).map((r: { name: string }) => r.name)).toEqual(['cc-a', 'cc-b', 'x-c'])
  })

  it('ls --spawner works from a shell with no AGENT_CHAT_NAME', async () => {
    vi.stubEnv('AGENT_CHAT_NAME', '')
    await run('ls', '--spawner', 'other', '--json')
    expect(JSON.parse(logs.join('\n')).map((r: { name: string }) => r.name)).toEqual([
      'cc-d',
      'y-e',
      'y-f',
      'y-g',
    ])
  })

  it('ls --spawner combines with --prefix', async () => {
    await run('ls', '--spawner', 'human', '--prefix', 'cc-', '--json')
    expect(JSON.parse(logs.join('\n')).map((r: { name: string }) => r.name)).toEqual(['cc-j'])
  })

  it('ls --prefix --json prints only matching names', async () => {
    await run('ls', '--prefix', 'y-', '--json')
    expect(JSON.parse(logs.join('\n')).map((r: { name: string }) => r.name)).toEqual(['y-e', 'y-f', 'y-g'])
  })

  it('ls --mine refuses to print everything when the shell has no session name', async () => {
    vi.stubEnv('AGENT_CHAT_NAME', '')
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit')
    }) as never)
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(run('ls', '--mine')).rejects.toThrow('exit')
    expect(exit).toHaveBeenCalledWith(1)
    expect(err.mock.calls.join('\n')).toMatch(/--spawner <your registered name>/)
    expect(logs).toEqual([])
  })

  it('budget --spawner reports only that spawners agents', async () => {
    const { agentBudget } = await import('../cli/agents.js')
    const report = await agentBudget(undefined, { spawner: 'boss' })
    expect(report.lines).toHaveLength(3)
    expect(report.lines.join('\n')).not.toContain('y-e')
  })

  it('budget --mine reports only the callers agents', async () => {
    const { agentBudget } = await import('../cli/agents.js')
    const report = await agentBudget(undefined, { mine: true })
    expect(report.lines).toHaveLength(3)
    expect(report.lines.join('\n')).not.toContain('y-e')
  })
})

describe('agent_list tool filters', () => {
  const ctx = (registeredName: string | null) =>
    ({
      registeredName,
      broker: { request: async () => ({ t: 'agents_result', agents: TEN }) },
    }) as never

  it("mine lists only the session's own spawns", async () => {
    const out = await agentList.run({ mine: true }, ctx('boss'))
    expect(out).toContain('- cc-a ')
    expect(out).not.toContain('- y-e ')
    expect(out.match(/^- /gm)).toHaveLength(3)
  })

  it('prefix lists only matching names', async () => {
    const out = await agentList.run({ prefix: 'z-' }, ctx('boss'))
    expect(out.match(/^- /gm)).toHaveLength(2)
  })

  it('mine refuses when the session holds no name', async () => {
    await expect(agentList.run({ mine: true }, ctx(null))).rejects.toThrow(/--mine needs AGENT_CHAT_NAME/)
  })
})
