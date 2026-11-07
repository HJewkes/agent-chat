import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn(() => ({ unref: () => undefined })))
vi.mock('node:child_process', async orig => ({ ...(await orig<object>()), spawn: spawnMock }))

import { BrokerClient } from '../client/broker-client.js'
import { BrokerUnavailableError, withBroker } from '../cli/client.js'
import { resolveAutoStart } from '../config.js'
import { configPath, socketPath } from '../paths.js'
import { waitForBroker } from '../server/broker-wait.js'

/** BS-48: a host served by a remote broker never starts its own when the forwarded socket is down. */

let home: string
let server: net.Server | undefined
let client: BrokerClient | undefined

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-bs48-'))
  process.env.AGENT_CHAT_HOME = home
  spawnMock.mockClear()
})
afterEach(async () => {
  client?.close()
  client = undefined
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
  delete process.env.AGENT_CHAT_HOME
  delete process.env.AGENT_CHAT_NO_AUTOSTART
  fs.rmSync(home, { recursive: true, force: true })
})

const writeConfig = (config: object): void => fs.writeFileSync(configPath(), JSON.stringify(config))

const listen = (): Promise<void> =>
  new Promise(resolve => {
    server = net.createServer(() => undefined)
    server.listen(socketPath(), () => resolve())
  })

const sessionClient = (): BrokerClient =>
  new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
    autoStart: resolveAutoStart(),
  })

describe('resolveAutoStart', () => {
  it('allows autostart by default', () => {
    expect(resolveAutoStart()).toBe(true)
  })

  it('forbids it when AGENT_CHAT_NO_AUTOSTART=1', () => {
    expect(resolveAutoStart({ AGENT_CHAT_NO_AUTOSTART: '1' })).toBe(false)
  })

  it('forbids it on a host whose config names a remote broker', () => {
    writeConfig({ remoteBroker: true })
    expect(resolveAutoStart({})).toBe(false)
  })

  it('keeps autostart for remoteBroker false or a non-boolean value', () => {
    writeConfig({ remoteBroker: false })
    expect(resolveAutoStart({})).toBe(true)
    writeConfig({ remoteBroker: 'yes' })
    expect(resolveAutoStart({})).toBe(true)
  })
})

describe('session client with the forwarded socket down', () => {
  it('does not spawn a broker and attaches once the socket appears', async () => {
    process.env.AGENT_CHAT_NO_AUTOSTART = '1'
    client = sessionClient()
    const connecting = client.connect()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(spawnMock).not.toHaveBeenCalled()

    await listen()
    await connecting

    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('reports why it is offline when asked to send before the broker appears', async () => {
    writeConfig({ remoteBroker: true })
    client = sessionClient()

    const err = await client.request({ t: 'list' }, 'list_result').catch((e: unknown) => e)

    expect((err as Error).message).toMatch(/autostart is off/)
    expect((err as Error).message).toContain(socketPath())
  })

  it('still spawns a broker by default', async () => {
    client = sessionClient()
    void client.connect().catch(() => undefined)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
  })
})

describe('CLI on a remoteBroker host', () => {
  it('fails as broker-unavailable without spawning', async () => {
    writeConfig({ remoteBroker: true })
    const err = await withBroker(async () => 'ran').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrokerUnavailableError)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

describe('waitForBroker', () => {
  it('retries with capped backoff until the broker answers', async () => {
    const answers = [false, false, false, true]
    const pauses: number[] = []

    const reached = await waitForBroker({
      reach: async () => answers.shift() ?? false,
      pause: async ms => void pauses.push(ms),
      delays: [10, 20],
    })

    expect(reached).toBe(true)
    expect(pauses).toEqual([10, 20, 20, 20])
  })

  it('stops when the session ends', async () => {
    let ended = false
    const reach = vi.fn(async () => {
      ended = true
      return false
    })

    const reached = await waitForBroker({ reach, pause: async () => undefined, stopped: () => ended })

    expect(reached).toBe(false)
    expect(reach).toHaveBeenCalledTimes(1)
  })
})
