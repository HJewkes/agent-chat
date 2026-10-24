import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Reply = Record<string, unknown>
const sent: Record<string, unknown>[] = []
let reply: Reply = { t: 'spawn_result', ok: true, name: 'planner', agentId: 'a1' }

vi.mock('../cli/client.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  withBroker: async (fn: (b: unknown) => Promise<unknown>) =>
    fn({
      request: async (frame: Record<string, unknown>) => {
        sent.push(frame)
        return reply
      },
    }),
  fail: (message: string): never => {
    throw new Error(message)
  },
}))

const { agentSpawn } = await import('../cli/agents.js')

class Exited extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`)
  }
}

let logs: string[]

async function run(options: Parameters<typeof agentSpawn>[3] = {}): Promise<number | undefined> {
  try {
    await agentSpawn('planner', 'fable-architect', ['plan', 'it'], options)
  } catch (err) {
    if (err instanceof Exited) return err.code
    throw err
  }
  return undefined
}

describe('agentSpawn', () => {
  beforeEach(() => {
    sent.length = 0
    logs = []
    reply = { t: 'spawn_result', ok: true, name: 'planner', agentId: 'a1' }
    vi.unstubAllEnvs()
    vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line))
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Exited(code)
    }) as never)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('sends only the required fields when no option is given', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined)
    await run()

    expect(sent[0]).toMatchObject({
      t: 'spawn',
      name: 'planner',
      profile: 'fable-architect',
      brief: 'plan it',
    })
    for (const key of ['briefing', 'configDir', 'task', 'workRole', 'surface', 'spawnedAs', 'host'])
      expect(sent[0]).not.toHaveProperty(key)
    expect(sent[0]).not.toHaveProperty('remoteControl')
    expect(sent[0]).not.toHaveProperty('spawnerConfigDir')
  })

  it('maps every option onto its frame field', async () => {
    await run({
      briefing: 'init',
      configDir: '/cfg',
      task: 'CC-1',
      role: 'implementer',
      surface: 'headless' as never,
      spawnedAs: 'shepherd',
      remoteControl: true,
      host: 'box',
      launchedBy: undefined,
      launchReason: 'because',
    })

    expect(sent[0]).toMatchObject({
      briefing: 'init',
      configDir: '/cfg',
      task: 'CC-1',
      workRole: 'implementer',
      surface: 'headless',
      spawnedAs: 'shepherd',
      remoteControl: true,
      host: 'box',
      launchReason: 'because',
    })
  })

  it('forwards the shell CLAUDE_CONFIG_DIR as spawnerConfigDir', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/shell-cfg')
    await run()

    expect(sent[0]).toMatchObject({ spawnerConfigDir: '/shell-cfg' })
  })

  it('omits remoteControl when it is false', async () => {
    await run({ remoteControl: false })

    expect(sent[0]).not.toHaveProperty('remoteControl')
  })

  it('prints warnings and the spawn line, then exits 0', async () => {
    reply = {
      t: 'spawn_result',
      ok: true,
      name: 'planner',
      agentId: 'a1',
      host: 'box',
      warnings: ['w1', 'w2'],
    }

    const code = await run()

    expect(logs).toEqual(['w1', 'w2', 'Spawned planner (a1) on box.'])
    expect(code).toBe(0)
  })

  it('prints the refusal with its code and retryable flag, then exits 1', async () => {
    reply = { t: 'spawn_result', ok: false, reason: 'no room', code: 'budget', retryable: true }

    const code = await run()

    expect(logs).toEqual(['Not spawned: no room', 'code: budget retryable: true'])
    expect(code).toBe(1)
  })

  it('prints the code alone when retryable is absent', async () => {
    reply = { t: 'spawn_result', ok: false, reason: 'no room', code: 'budget' }

    await run()

    expect(logs).toEqual(['Not spawned: no room', 'code: budget'])
  })

  it('prints no code line for a refusal without a code', async () => {
    reply = { t: 'spawn_result', ok: false, reason: 'nope' }

    await run()

    expect(logs).toEqual(['Not spawned: nope'])
  })

  it('fails with the brief error when there are no words and no stdin', async () => {
    await expect(agentSpawn('planner', 'fable-architect', [], {})).rejects.toThrow()
    expect(sent).toHaveLength(0)
  })
})
