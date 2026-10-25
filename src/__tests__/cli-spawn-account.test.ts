import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage } from '../protocol.js'

/** TP-4214: `agent spawn --account` carries the ask on the frame and prints the broker's pick. */

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

const PICKED = 'beta (least-used; max(5h,7d): alpha 70% [5h 10 7d 70], beta 20% [5h 20 7d 5])'
const EXHAUSTED = 'none (least-used; max(5h,7d): alpha over ceiling 95% [5h 95 7d 40], beta stale 900s)'

async function run(...argv: string[]): Promise<string[]> {
  const errors: string[] = []
  const program = buildProgram()
  program.exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
  const agent = program.commands.find(c => c.name() === 'agent')
  agent?.commands.forEach(c => c.exitOverride().configureOutput({ writeErr: text => void errors.push(text) }))
  await program.parseAsync(['agent', ...argv], { from: 'user' }).catch(() => undefined)
  return errors
}

const spawnFrame = () => broker.sent.find(f => f.t === 'spawn')

describe('agent spawn --account', () => {
  let log: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    broker.sent.length = 0
    broker.reply = { t: 'spawn_result', ok: true, name: 'pilot', agentId: 'a1', account: PICKED }
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Exited()
    }) as never)
  })
  afterEach(() => vi.restoreAllMocks())

  it('sends the account on the frame and prints the pick before the spawn line', async () => {
    await run('spawn', 'pilot', 'coordinator', 'coordinate it', '--account', 'least-used')

    expect(spawnFrame()).toMatchObject({ t: 'spawn', account: 'least-used' })
    expect(log.mock.calls.map(call => call[0])).toEqual([`account: ${PICKED}`, 'Spawned pilot (a1).'])
  })

  it('prints the readings and the code when every account is exhausted', async () => {
    broker.reply = {
      t: 'spawn_result',
      ok: false,
      reason: 'no account has a fresh reading under the 90% ceiling',
      code: 'account_exhausted',
      retryable: true,
      account: EXHAUSTED,
    }

    await run('spawn', 'pilot', 'coordinator', 'coordinate it', '--account', 'least-used')

    expect(log).toHaveBeenCalledWith(`account: ${EXHAUSTED}`)
    expect(log).toHaveBeenCalledWith('code: account_exhausted retryable: true')
  })

  it('refuses --account with --config-dir before reaching the broker', async () => {
    const errors = await run('spawn', 'pilot', 'coordinator', 'go', '--account', 'beta', '--config-dir', '/x')

    expect(spawnFrame()).toBeUndefined()
    expect(errors.join('')).toContain('cannot be used with option')
  })

  it('leaves account off the frame when the flag is omitted', async () => {
    await run('spawn', 'pilot', 'coordinator', 'coordinate it')

    expect(spawnFrame()).not.toHaveProperty('account')
  })
})
