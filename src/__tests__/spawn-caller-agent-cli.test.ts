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
const { callerAgentField } = await import('../cli/agents.js')

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

async function resumeFrame(): Promise<ClientMessage | undefined> {
  await buildProgram()
    .exitOverride()
    .configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
    .parseAsync(['agent', 'resume', 'planner'], { from: 'user' })
    .catch(() => undefined)
  return sent.find(f => f.t === 'resume')
}

describe('callerAgentField', () => {
  it('names the agent from AGENT_CHAT_NAME, ahead of its id', () => {
    expect(callerAgentField({ AGENT_CHAT_NAME: 'tc-x', AGENT_CHAT_AGENT_ID: 'id-1' })).toEqual({
      callerAgent: 'tc-x',
    })
  })

  it('falls back to AGENT_CHAT_AGENT_ID when the name is absent or blank', () => {
    expect(callerAgentField({ AGENT_CHAT_AGENT_ID: 'id-1' })).toEqual({ callerAgent: 'id-1' })
    expect(callerAgentField({ AGENT_CHAT_NAME: '  ', AGENT_CHAT_AGENT_ID: 'id-1' })).toEqual({
      callerAgent: 'id-1',
    })
  })

  it('claims nothing from a plain terminal env or blank values', () => {
    expect(callerAgentField({})).toEqual({})
    expect(callerAgentField({ AGENT_CHAT_NAME: '', AGENT_CHAT_AGENT_ID: ' ' })).toEqual({})
  })
})

describe('agent spawn from an agent shell', () => {
  beforeEach(() => {
    sent.length = 0
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Exited()
    }) as never)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('sends the caller agent on the frame so the broker does not take it for the human', async () => {
    vi.stubEnv('AGENT_CHAT_NAME', 'tc-coord')

    const frame = await spawnWith()

    expect(frame).toMatchObject({ t: 'spawn', callerAgent: 'tc-coord' })
  })

  it('leaves callerAgent off the frame from a plain terminal', async () => {
    const frame = await spawnWith()

    expect(frame).toBeDefined()
    expect(frame).not.toHaveProperty('callerAgent')
  })

  it('sends the caller agent on a resume frame too (TP-4256 A3)', async () => {
    vi.stubEnv('AGENT_CHAT_NAME', 'tc-coord')

    expect(await resumeFrame()).toMatchObject({ t: 'resume', callerAgent: 'tc-coord' })
  })
})
