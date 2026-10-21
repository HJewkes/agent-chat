import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage } from '../protocol.js'

/** CC-1507: titan-console's round notice goes out as `debug send --source console`, not as the human typing. */

const sent: ClientMessage[] = []

vi.mock('../cli/client.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  withBroker: async (fn: (b: unknown) => Promise<unknown>) =>
    fn({
      request: async (frame: ClientMessage) => {
        sent.push(frame)
        return { t: 'send_result', ok: true, msgId: 'm1', recipients: ['beta'] }
      },
    }),
  fail: (reason: string): never => {
    throw new Error(reason)
  },
}))

const { send } = await import('../cli/debug.js')

describe('debug send --source', () => {
  beforeEach(() => {
    sent.length = 0
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  })
  afterEach(() => vi.restoreAllMocks())

  it('puts the console source on the human_send frame', async () => {
    await send('beta', ['round', 'answered'], { source: 'console' })

    expect(sent).toEqual([{ t: 'human_send', to: 'beta', text: 'round answered', source: 'console' }])
  })

  it('refuses an unknown source before sending anything', async () => {
    await expect(send('beta', ['hi'], { source: 'owner-approved' })).rejects.toThrow(
      'known: watchdog, shepherd, console',
    )

    expect(sent).toEqual([])
  })
})
