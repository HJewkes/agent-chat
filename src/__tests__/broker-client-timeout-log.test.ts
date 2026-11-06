import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { BrokerClient } from '../client/broker-client.js'

let home: string
let server: net.Server
const accepted: net.Socket[] = []
let client: BrokerClient
let rotating: BrokerClient | undefined
const originalHome = process.env.AGENT_CHAT_HOME

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc1699-'))
  process.env.AGENT_CHAT_HOME = home
  fs.writeFileSync(path.join(home, 'broker.pid'), '4242\n')
  server = net.createServer(socket => void accepted.push(socket))
  await new Promise<void>(resolve => server.listen(path.join(home, 'chat.sock'), resolve))
  client = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, { autoStart: false })
  await client.connect()
})

afterEach(async () => {
  vi.useRealTimers()
  client.close()
  rotating?.close()
  rotating = undefined
  delete process.env.AGENT_CHAT_BROKER_LOG_MAX_BYTES
  for (const socket of accepted.splice(0)) socket.destroy()
  await new Promise(resolve => server.close(resolve))
  if (originalHome === undefined) delete process.env.AGENT_CHAT_HOME
  else process.env.AGENT_CHAT_HOME = originalHome
  fs.rmSync(home, { recursive: true, force: true })
})

const timeOutList = async (): Promise<unknown> => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const outcome = client.request({ t: 'list' }, 'list_result').then(
    () => undefined,
    (err: Error) => err,
  )
  await vi.advanceTimersByTimeAsync(5000)
  return outcome
}

describe('client request timeout log (CC-1699)', () => {
  it('appends one client_request_timeout line and still rejects with the same message', async () => {
    const err = (await timeOutList()) as Error

    expect(err.message).toBe('broker did not answer list_result')
    const lines = fs.readFileSync(path.join(home, 'broker.log'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const row = JSON.parse(lines[0] ?? '')
    expect(Object.keys(row).sort()).toEqual(['brokerPid', 'caller', 'event', 'kind', 'timeoutMs', 'ts'])
    expect(row).toMatchObject({
      event: 'client_request_timeout',
      caller: null,
      kind: 'list',
      timeoutMs: 5000,
      brokerPid: 4242,
    })
    expect(new Date(row.ts).toISOString()).toBe(row.ts)
  })

  it('records the registered name as caller and null pid when no pid file exists', async () => {
    fs.rmSync(path.join(home, 'broker.pid'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const outcome = client
      .request({ t: 'register', name: 'seat-a', workingOn: 'x', cwd: '/x', pid: 1 }, 'register_result')
      .catch((err: Error) => err)
    await vi.advanceTimersByTimeAsync(5000)
    await outcome

    const row = JSON.parse(fs.readFileSync(path.join(home, 'broker.log'), 'utf8').trim())
    expect(row).toMatchObject({ caller: 'seat-a', kind: 'register', brokerPid: null })
  })

  it('rejects with the original error when the log path is unwritable', async () => {
    fs.mkdirSync(path.join(home, 'broker.log'))

    const err = (await timeOutList()) as Error

    expect(err.message).toBe('broker did not answer list_result')
  })

  it('rotates an oversize broker.log through the shared logger before appending', async () => {
    vi.resetModules()
    process.env.AGENT_CHAT_BROKER_LOG_MAX_BYTES = '100'
    fs.writeFileSync(path.join(home, 'broker.log'), 'x'.repeat(500))
    const fresh = await import('../client/broker-client.js')
    rotating = new fresh.BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
      autoStart: false,
    })
    await rotating.connect()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const outcome = rotating.request({ t: 'list' }, 'list_result').catch((err: Error) => err)
    await vi.advanceTimersByTimeAsync(5000)
    await outcome

    expect(fs.readFileSync(path.join(home, 'broker.log.1'), 'utf8')).toBe('x'.repeat(500))
    expect(JSON.parse(fs.readFileSync(path.join(home, 'broker.log'), 'utf8')).event).toBe(
      'client_request_timeout',
    )
  })
})
