import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentIdentity } from '../protocol.js'

const roster = vi.hoisted(() => ({ agents: [] as unknown[], sessions: [] as unknown[] }))
const modelReads = vi.hoisted(() => ({
  read: undefined as ((cwd: string) => string | undefined) | undefined,
}))

vi.mock('../agents/transcript.js', async importOriginal => {
  const original = await importOriginal<typeof import('../agents/transcript.js')>()
  return {
    ...original,
    observedModel: (cwd: string, sessionId: string, dir?: string) =>
      modelReads.read ? modelReads.read(cwd) : original.observedModel(cwd, sessionId, dir),
  }
})

vi.mock('../cli/client.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../cli/client.js')>()),
  withBroker: async <T>(fn: (b: unknown) => Promise<T>): Promise<T> =>
    fn({
      request: async (message: { t: string }) =>
        message.t === 'agents'
          ? { t: 'agents_result', agents: roster.agents }
          : { t: 'list_result', sessions: roster.sessions },
    }),
}))

const { buildProgram } = await import('../cli/index.js')

const SESSION_ID = '11111111-2222-3333-4444-555555555555'

const liveAgent = (): AgentIdentity => ({
  agentId: 'a1',
  name: 'worker',
  profile: 'implementer',
  state: 'live',
  origin: 'spawned',
  spawnedBy: 'boss',
  spawnedAt: 1,
  brief: 'do it',
  cwd: '/tmp/cc176-nowhere',
  isolation: 'none',
  surface: 'headless',
  sessionId: SESSION_ID,
  configDir: '/tmp/cc176-config',
  lastEventAt: 2,
  generation: 1,
})

const lsOutput = async (...flags: string[]): Promise<string> => {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void lines.push(args.join(' ')))
  await buildProgram().parseAsync(['node', 'agent-chat', 'agent', 'ls', ...flags])
  return lines.join('\n')
}

beforeEach(() => {
  roster.agents = [liveAgent()]
  roster.sessions = [{ name: 'worker' }]
})
afterEach(() => {
  vi.restoreAllMocks()
  modelReads.read = undefined
})

describe('agent ls --json', () => {
  it('prints one array whose live entry carries the session id', async () => {
    const rows = JSON.parse(await lsOutput('--json')) as Record<string, unknown>[]

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: 'worker',
      state: 'live',
      presence: 'live',
      profile: 'implementer',
      surface: 'headless',
      cwd: '/tmp/cc176-nowhere',
      sessionId: SESSION_ID,
      spawnedBy: 'boss',
      account: '/tmp/cc176-config',
    })
    expect(rows[0]?.transcriptPath).toContain(`${SESSION_ID}.jsonl`)
  })

  it('reports a disconnected live agent as detached and an empty roster as []', async () => {
    roster.sessions = []
    const [row] = JSON.parse(await lsOutput('--json')) as { presence: string }[]
    expect(row?.presence).toBe('detached')

    roster.agents = []
    expect(JSON.parse(await lsOutput('--json'))).toEqual([])
  })
})

describe('agent ls --json inferred and spawnedAt', () => {
  const exited = (exit: NonNullable<AgentIdentity['exit']>): AgentIdentity => ({
    ...liveAgent(),
    state: 'exited',
    exit,
  })

  it('marks an exit written by the settle timer as inferred', async () => {
    roster.sessions = []
    roster.agents = [exited({ code: null, summary: 'exit inferred from presence', inferred: true })]
    const [row] = JSON.parse(await lsOutput('--json')) as Record<string, unknown>[]
    expect(row).toMatchObject({ presence: 'exited', inferred: true })
  })

  it('marks a recorded exit, and an agent that has not exited, as not inferred', async () => {
    roster.sessions = []
    roster.agents = [exited({ code: 0, summary: 'done' }), { ...liveAgent(), name: 'other', agentId: 'a2' }]
    const rows = JSON.parse(await lsOutput('--json')) as Record<string, unknown>[]
    expect(rows.map(r => r.inferred)).toEqual([false, false])
  })

  it('reports the spawn time as an ISO string', async () => {
    const [row] = JSON.parse(await lsOutput('--json')) as Record<string, unknown>[]
    expect(row?.spawnedAt).toBe('1970-01-01T00:00:00.001Z')
  })
})

describe('agent ls --json when one transcript cannot be read', () => {
  // Mutation caught: the per-agent read rethrows, so one bad transcript aborts the whole listing.
  it('reports model null for that agent and still lists the others', async () => {
    roster.agents = [{ ...liveAgent(), name: 'broken', agentId: 'a2', cwd: '/tmp/cc178-broken' }, liveAgent()]
    modelReads.read = cwd => {
      if (cwd === '/tmp/cc178-broken') throw new SyntaxError('malformed transcript line')
      return 'claude-sonnet-5-5'
    }

    const rows = JSON.parse(await lsOutput('--json')) as { name: string; model: string | null }[]

    expect(rows.map(r => [r.name, r.model])).toEqual([
      ['broken', null],
      ['worker', 'claude-sonnet-5-5'],
    ])
  })
})

describe('agent ls default output', () => {
  it('stays the multi-line text view', async () => {
    const text = await lsOutput()

    expect(text.split('\n')).toEqual([
      `${'worker'.padEnd(16)} ${'running'.padEnd(13)} ${'implementer'.padEnd(12)} a1`,
      `${' '.repeat(16)} /tmp/cc176-nowhere`,
      `${' '.repeat(16)} account: /tmp/cc176-config`,
      expect.stringContaining(`${' '.repeat(16)} transcript: `),
    ])
  })
})

describe('agent ls filters (CC-888)', () => {
  const agent = (name: string, state: AgentIdentity['state'], connected: boolean): AgentIdentity => {
    roster.sessions = [...(roster.sessions as { name: string }[]), ...(connected ? [{ name }] : [])]
    return { ...liveAgent(), name, agentId: `id-${name}`, state }
  }

  beforeEach(() => {
    roster.sessions = []
    roster.agents = [
      agent('alpha', 'live', true),
      agent('beta', 'exited', false),
      agent('gamma', 'retired', false),
    ]
  })

  const names = async (...flags: string[]): Promise<string[]> =>
    JSON.parse(await lsOutput('--json', ...flags)).map((row: { name: string }) => row.name)

  it('keeps only agents in the given state', async () => {
    expect(await names('--state', 'running')).toEqual(['alpha'])
  })

  it('accepts --state repeatedly and keeps agents in any of the states', async () => {
    expect(await names('--state', 'finished', '--state', 'retired')).toEqual(['beta', 'gamma'])
  })

  it('refuses a state the roster never reports', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit')
    }) as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(lsOutput('--state', 'sleeping')).rejects.toThrow('exit')
    expect(exit).toHaveBeenCalled()
  })

  it('keeps only the agent with exactly that name', async () => {
    expect(await names('--name', 'beta')).toEqual(['beta'])
    expect(await names('--name', 'bet')).toEqual([])
  })

  it('prints one line per agent with --format line', async () => {
    const text = await lsOutput('--format', 'line')

    expect(text.split('\n')).toEqual([
      'alpha running implementer id-alpha /tmp/cc176-nowhere',
      'beta finished implementer id-beta /tmp/cc176-nowhere',
      'gamma retired implementer id-gamma /tmp/cc176-nowhere',
    ])
  })

  it('combines --format line with the filters', async () => {
    expect(await lsOutput('--format', 'line', '--state', 'retired')).toBe(
      'gamma retired implementer id-gamma /tmp/cc176-nowhere',
    )
  })
})
