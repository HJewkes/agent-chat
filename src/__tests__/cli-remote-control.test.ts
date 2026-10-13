import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage } from '../protocol.js'

/** CC-840: `agent spawn` and `agent resume` carry `--remote-control` onto their frames. */

const broker = vi.hoisted(() => ({
  sent: [] as ClientMessage[],
  reply: undefined as unknown,
}))

vi.mock('../cli/client.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  withBroker: async (fn: (b: unknown) => Promise<unknown>) =>
    fn({
      request: async (frame: ClientMessage) => {
        broker.sent.push(frame)
        return broker.reply
      },
    }),
  fail: (reason: string): never => {
    throw new Error(reason)
  },
}))

const { buildProgram } = await import('../cli/index.js')

class Exited extends Error {}

const WORKER_REFUSAL =
  'profile "implementer" is a worker and cannot run with Remote Control; only a coordinator profile may'

async function run(...argv: string[]): Promise<void> {
  const program = buildProgram()
  program.exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
  const agent = program.commands.find(c => c.name() === 'agent')
  agent?.commands.forEach(c => c.exitOverride().configureOutput({ writeErr: () => undefined }))
  await program.parseAsync(['agent', ...argv], { from: 'user' }).catch(() => undefined)
}

const frame = (t: ClientMessage['t']) => broker.sent.find(f => f.t === t)

describe('agent spawn --remote-control', () => {
  let log: ReturnType<typeof vi.spyOn>
  let exit: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    broker.sent.length = 0
    broker.reply = { t: 'spawn_result', ok: true, name: 'pilot', agentId: 'a1' }
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Exited()
    }) as never)
  })
  afterEach(() => vi.restoreAllMocks())

  it('asks the broker for Remote Control on a coordinator spawn', async () => {
    await run('spawn', 'pilot', 'coordinator', 'coordinate it', '--remote-control')

    expect(frame('spawn')).toMatchObject({ t: 'spawn', profile: 'coordinator', remoteControl: true })
  })

  it('leaves remoteControl off the spawn frame when the flag is omitted', async () => {
    await run('spawn', 'pilot', 'coordinator', 'coordinate it')

    expect(frame('spawn')).toBeDefined()
    expect(frame('spawn')).not.toHaveProperty('remoteControl')
  })

  it("prints the broker's worker refusal and exits 1", async () => {
    broker.reply = { t: 'spawn_result', ok: false, reason: WORKER_REFUSAL }

    await run('spawn', 'impl', 'implementer', 'build it', '--remote-control')

    expect(log).toHaveBeenCalledWith(`Not spawned: ${WORKER_REFUSAL}`)
    expect(exit).toHaveBeenCalledWith(1)
  })
})

describe('agent resume --remote-control', () => {
  beforeEach(() => {
    broker.sent.length = 0
    broker.reply = { t: 'spawn_result', ok: true, name: 'pilot', agentId: 'a1' }
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Exited()
    }) as never)
  })
  afterEach(() => vi.restoreAllMocks())

  it('carries Remote Control on the resume frame', async () => {
    await run('resume', 'pilot', '--surface', 'iterm-tab', '--remote-control')

    expect(frame('resume')).toMatchObject({ t: 'resume', name: 'pilot', remoteControl: true })
  })

  it('leaves remoteControl off the resume frame when the flag is omitted', async () => {
    await run('resume', 'pilot')

    expect(frame('resume')).toBeDefined()
    expect(frame('resume')).not.toHaveProperty('remoteControl')
  })
})
