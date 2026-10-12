import os from 'node:os'
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

describe('agent spawn --surface', () => {
  beforeEach(() => {
    sent.length = 0
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Exited()
    }) as never)
  })
  afterEach(() => vi.restoreAllMocks())

  it('sends headless so a profile whose surface is iterm-pane can run off macOS', async () => {
    const frame = await spawnWith('--surface', 'headless')

    expect(frame).toMatchObject({ t: 'spawn', profile: 'fable-architect', surface: 'headless' })
  })

  it('refuses a surface that does not exist, sending nothing', async () => {
    const frame = await spawnWith('--surface', 'hologram')

    expect(frame).toBeUndefined()
  })

  it('leaves surface off the frame when the flag is omitted, so the profile default holds', async () => {
    const frame = await spawnWith()

    expect(frame).toBeDefined()
    expect(frame).not.toHaveProperty('surface')
  })
})

describe('agent spawn --host (CC-1059)', () => {
  beforeEach(() => {
    sent.length = 0
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Exited()
    }) as never)
  })
  afterEach(() => vi.restoreAllMocks())

  it('says it can launch here, from which host and OS, so a remote broker hands the launch back', async () => {
    const frame = await spawnWith()

    expect(frame).toMatchObject({
      launchesHere: true,
      callerHost: os.hostname(),
      hostPlatform: process.platform,
      callerHome: os.homedir(),
    })
    expect(frame).not.toHaveProperty('host')
  })

  it('sends the machine --host names', async () => {
    const frame = await spawnWith('--host', 'basement')

    expect(frame).toMatchObject({ host: 'basement', launchesHere: true })
  })
})
