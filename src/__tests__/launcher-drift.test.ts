import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { LauncherDrift } from '../broker/launcher-drift.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import { BUILD_COMMIT_FILE, readBuildCommit } from '../build-commit.js'
import { logPath } from '../paths.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/**
 * CC-1728: a remote machine's launcher announces the commit its dist was built from, and the broker
 * tells the human once when that differs from its own, so a stale remote checkout is seen before
 * its sessions fail to register.
 */

const BROKER = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0'
const STALE = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'

vi.mock('../build-commit.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../build-commit.js')>()),
  ownBuildCommit: () => BROKER,
}))

function drift(brokerCommit: string | undefined) {
  const notices: string[] = []
  const logged: Record<string, unknown>[] = []
  const tracker = new LauncherDrift(brokerCommit, { notify: b => notices.push(b), log: d => logged.push(d) })
  return { tracker, notices, logged }
}

describe('a launcher hello checked against the broker build', () => {
  it('raises one notice naming the host and both builds when they differ', () => {
    const { tracker, notices, logged } = drift(BROKER)

    tracker.hello('mac', STALE)

    expect(notices).toEqual([
      'host mac runs agent-chat a1a1a1a1a1a1, broker b0b0b0b0b0b0; rebuild agent-chat there at ' +
        'b0b0b0b0b0b0, or its sessions may fail to register.',
    ])
    expect(logged).toEqual([{ host: 'mac', launcher: STALE, broker: BROKER }])
  })

  it('raises none when they match', () => {
    const { tracker, notices } = drift(BROKER)

    tracker.hello('mac', BROKER)

    expect(notices).toEqual([])
  })

  it('does not re-notify when the same host says hello again', () => {
    const { tracker, notices } = drift(BROKER)

    tracker.hello('mac', STALE)
    tracker.hello('Mac', STALE)

    expect(notices).toHaveLength(1)
  })

  it('treats a launcher that announces no commit as a drift', () => {
    const { tracker, notices } = drift(BROKER)

    tracker.hello('mac', undefined)

    expect(notices[0]).toContain('runs agent-chat an unstamped build')
  })

  it('stays quiet when the broker itself is unstamped', () => {
    const { tracker, notices } = drift(undefined)

    tracker.hello('mac', STALE)

    expect(notices).toEqual([])
  })
})

describe('the build stamp', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-stamp-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('reads the commit a build wrote', () => {
    fs.writeFileSync(path.join(dir, BUILD_COMMIT_FILE), `${STALE}\n`)

    expect(readBuildCommit(dir)).toBe(STALE)
  })

  it('reads a missing or garbled stamp as unstamped', () => {
    expect(readBuildCommit(dir)).toBeUndefined()
    fs.writeFileSync(path.join(dir, BUILD_COMMIT_FILE), 'not a commit')
    expect(readBuildCommit(dir)).toBeUndefined()
  })
})

describe('a launcher hello over the socket', () => {
  let home: string
  let core: BrokerCore
  let server: SocketServer
  let notices: string[]

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-drift-'))
    process.env.AGENT_CHAT_HOME = home
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ hostProof: 'off' }))
    core = new BrokerCore(() => undefined, {
      events: new EventLog(path.join(home, 'events.db')),
      registry: new Registry<Conn>(),
    })
    notices = []
    core.onAppend(row => {
      if (row.kind === 'notice' && row.actor === 'agent-chat') notices.push(row.body ?? '')
    })
    server = new SocketServer(core)
  })

  afterEach(() => {
    delete process.env.AGENT_CHAT_HOME
    fs.rmSync(home, { recursive: true, force: true })
  })

  function hello(commit?: string): ServerMessage[] {
    const frames: ServerMessage[] = []
    const conn = {
      write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
    } as unknown as Conn
    const msg: ClientMessage = {
      t: 'host_hello',
      host: 'mac',
      platform: 'darwin',
      surfaces: ['headless'],
      ...(commit === undefined ? {} : { commit }),
    }
    server.handleMessage(conn, msg)
    return frames
  }

  it('tells the human once, logs it, and answers with the broker build', () => {
    const frames = hello(STALE)
    hello(STALE)

    expect(frames.find(f => f.t === 'host_hello_result')).toMatchObject({ ok: true, brokerCommit: BROKER })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('host mac runs agent-chat a1a1a1a1a1a1')
    expect(fs.readFileSync(logPath(), 'utf8')).toContain('"event":"host_build_mismatch"')
  })

  it('tells the human nothing for a launcher on the broker build', () => {
    hello(BROKER)

    expect(notices).toEqual([])
  })
})
