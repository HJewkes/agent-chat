import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerClient, BrokerTimeoutError, retryOnBrokerTimeout } from '../client/broker-client.js'
import { encode, lineReader, type ClientMessage, type ServerMessage } from '../protocol.js'

/**
 * CC-1343: a broker request that times out, against a fake broker that answers
 * only when the test says so. Replies carry no request id, so what matters is
 * which waiter a LATE reply lands on.
 */

let dir: string
let server: net.Server
let brokerSide: net.Socket | undefined
let received: ClientMessage[]
let client: BrokerClient | undefined
const previousHome = process.env['AGENT_CHAT_HOME']

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i += 1) await tick()
  expect(predicate()).toBe(true)
}

const inboxSince = (afterId: number): ClientMessage => ({ t: 'inbox_since', name: 'x', afterId, limit: 10 })

const reply = (nextCursor: number): void => {
  brokerSide?.write(encode({ t: 'inbox_since_result', messages: [], nextCursor } as ServerMessage))
}

/** Settles without advancing fake time, so a reply that never lands fails fast instead of hanging. */
async function settled<T>(pending: Promise<T>): Promise<T | Error> {
  let outcome: { value: T | Error } | undefined
  pending.then(
    value => (outcome = { value }),
    (err: Error) => (outcome = { value: err }),
  )
  await until(() => outcome !== undefined)
  return outcome!.value
}

async function connected(): Promise<BrokerClient> {
  const c = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
    autoStart: false,
  })
  await c.connect()
  await until(() => brokerSide !== undefined)
  return c
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac1343-'))
  process.env['AGENT_CHAT_HOME'] = dir
  received = []
  brokerSide = undefined
  server = net.createServer(conn => {
    brokerSide = conn
    conn.on(
      'data',
      lineReader<ClientMessage>(
        msg => received.push(msg),
        () => undefined,
      ),
    )
  })
  await new Promise<void>(resolve => server.listen(path.join(dir, 'chat.sock'), resolve))
})

afterEach(async () => {
  vi.useRealTimers()
  client?.close()
  client = undefined
  brokerSide?.destroy()
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (previousHome === undefined) delete process.env['AGENT_CHAT_HOME']
  else process.env['AGENT_CHAT_HOME'] = previousHome
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('BrokerClient request timeout', () => {
  it('rejects a request past its timeout with a BrokerTimeoutError whose message is unchanged', async () => {
    client = await connected()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const pending = client.request(inboxSince(1), 'inbox_since_result')
    const outcome = pending.catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(15_000)
    const err = await outcome

    expect(err).toBeInstanceOf(BrokerTimeoutError)
    expect((err as Error).name).toBe('BrokerTimeoutError')
    expect((err as Error).message.startsWith('broker did not answer inbox_since_result')).toBe(true)
  })

  it('gives a late reply to the timed-out request, not to the next one of the same type', async () => {
    client = await connected()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const first = client.request(inboxSince(1), 'inbox_since_result').catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await first).toBeInstanceOf(BrokerTimeoutError)

    const second = client.request(inboxSince(2), 'inbox_since_result')
    await until(() => received.length === 2)
    reply(1)
    reply(2)

    expect(await settled(second)).toMatchObject({ t: 'inbox_since_result', nextCursor: 2 })
  })

  it('stops holding a timed-out slot once the hold passes, so a reply that never comes cannot wedge the queue', async () => {
    client = await connected()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const first = client.request(inboxSince(1), 'inbox_since_result').catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(15_000)
    await first
    await vi.advanceTimersByTimeAsync(60_000)

    const second = client.request(inboxSince(2), 'inbox_since_result')
    await until(() => received.length === 2)
    reply(2)

    expect(await settled(second)).toMatchObject({ nextCursor: 2 })
  })

  it('costs one more timeout, not every later request, when a reply is lost while traffic continues', async () => {
    client = await connected()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const lost = client.request(inboxSince(1), 'inbox_since_result').catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(15_000)
    await lost

    const swallowed = client.request(inboxSince(2), 'inbox_since_result').catch((err: unknown) => err)
    await until(() => received.length === 2)
    reply(2)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await swallowed).toBeInstanceOf(BrokerTimeoutError)

    const third = client.request(inboxSince(3), 'inbox_since_result')
    await until(() => received.length === 3)
    reply(3)

    expect(await settled(third)).toMatchObject({ nextCursor: 3 })
  })
})

describe('retryOnBrokerTimeout', () => {
  const noSleep = async (): Promise<void> => undefined

  it('retries a timeout twice and returns the third answer', async () => {
    const call = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new BrokerTimeoutError('inbox_since_result'))
      .mockRejectedValueOnce(new BrokerTimeoutError('inbox_since_result'))
      .mockResolvedValueOnce('answer')

    await expect(retryOnBrokerTimeout(call, [1000, 3000], noSleep)).resolves.toBe('answer')
    expect(call).toHaveBeenCalledTimes(3)
  })

  it('gives up after the last delay with the timeout', async () => {
    const call = vi.fn<() => Promise<string>>().mockRejectedValue(new BrokerTimeoutError('agents_result'))

    await expect(retryOnBrokerTimeout(call, [1000, 3000], noSleep)).rejects.toBeInstanceOf(BrokerTimeoutError)
    expect(call).toHaveBeenCalledTimes(3)
  })

  it('throws any other error after one call', async () => {
    const call = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('broker restarting'))

    await expect(retryOnBrokerTimeout(call, [1000, 3000], noSleep)).rejects.toThrow('broker restarting')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('waits each delay in order between attempts', async () => {
    const slept: number[] = []
    const call = vi.fn<() => Promise<string>>().mockRejectedValue(new BrokerTimeoutError('agents_result'))

    await retryOnBrokerTimeout(call, [1000, 3000], async ms => void slept.push(ms)).catch(() => undefined)

    expect(slept).toEqual([1000, 3000])
  })
})
