import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage } from '../protocol.js'

const sent: ClientMessage[] = []

vi.mock('../cli/client.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  withBroker: async (fn: (b: unknown) => Promise<unknown>) =>
    fn({
      request: async (frame: ClientMessage) => {
        sent.push(frame)
        return { t: 'spawn_result', ok: true, name: 'planner', agentId: 'a1' }
      },
    }),
  fail: (reason: string): never => {
    throw new Error(reason)
  },
}))

const { buildProgram } = await import('../cli/index.js')

class Exited extends Error {}

async function spawnWith(...flags: string[]): Promise<ClientMessage | undefined> {
  const program = buildProgram()
  program.exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
  for (const command of program.commands) command.exitOverride()
  const agent = program.commands.find(c => c.name() === 'agent')
  agent?.commands.forEach(c => c.exitOverride().configureOutput({ writeErr: () => undefined }))
  await program
    .parseAsync(['agent', 'spawn', 'planner', 'fable-architect', 'plan it', ...flags], { from: 'user' })
    .catch(() => undefined)
  return sent.find(f => f.t === 'spawn')
}

describe('agent spawn --spawned-as', () => {
  beforeEach(() => {
    sent.length = 0
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Exited()
    }) as never)
  })
  afterEach(() => vi.restoreAllMocks())

  it('claims a Shepherd spawn on the frame so the broker records it as Shepherd, not the human', async () => {
    const frame = await spawnWith('--spawned-as', 'shepherd')

    expect(frame).toMatchObject({ t: 'spawn', spawnedAs: 'shepherd' })
  })

  it('claims a burndown spawn alongside its task', async () => {
    const frame = await spawnWith('--spawned-as', 'burndown', '--task', 'CC-1')

    expect(frame).toMatchObject({ t: 'spawn', spawnedAs: 'burndown', task: 'CC-1' })
  })

  it('refuses any other claimant, sending nothing', async () => {
    const frame = await spawnWith('--spawned-as', 'human')

    expect(frame).toBeUndefined()
  })

  it('leaves spawnedAs off the frame when the flag is omitted', async () => {
    const frame = await spawnWith()

    expect(frame).toBeDefined()
    expect(frame).not.toHaveProperty('spawnedAs')
  })
})
