import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentIdentity } from '../protocol.js'

const roster = vi.hoisted(() => ({ agents: [] as unknown[], sessions: [] as unknown[] }))

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
afterEach(() => vi.restoreAllMocks())

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
