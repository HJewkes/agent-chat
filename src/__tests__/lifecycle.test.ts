import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { buildHealthPayload } from '../broker/health.js'
import {
  isProcessAlive,
  probeSocket,
  readMeta,
  readPidFile,
  removeStateFiles,
  writeMeta,
  writePidFile,
} from '../broker/lifecycle.js'
import { VERSION } from '../broker/version.js'
import { defaultPort, DEFAULT_PORT, metaPath, pidPath } from '../paths.js'
import { HUMAN } from '../protocol.js'

/**
 * Step 2 of the service plan builds lifecycle and health with no HTTP layer at
 * all, specifically so both are exercisable before a server exists. These tests
 * are that exercise — everything here runs without binding a socket or a port.
 */

let tmpHome: string
const originalHome = process.env.AGENT_CHAT_HOME
const originalPort = process.env.AGENT_CHAT_PORT

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-lifecycle-'))
  process.env.AGENT_CHAT_HOME = tmpHome
  delete process.env.AGENT_CHAT_PORT
})

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.AGENT_CHAT_HOME
  else process.env.AGENT_CHAT_HOME = originalHome
  if (originalPort === undefined) delete process.env.AGENT_CHAT_PORT
  else process.env.AGENT_CHAT_PORT = originalPort
})

const makeCore = (): BrokerCore =>
  new BrokerCore(() => {}, {
    events: new EventLog(path.join(tmpHome, 'events.db')),
    registry: new Registry<Conn>(),
  })

const fakeConn = (): Conn => ({}) as unknown as net.Socket

describe('version', () => {
  /**
   * VERSION is a constant rather than a package.json read, because the relative
   * path to the manifest differs between src/ and dist/. This is the check that
   * makes that safe instead of merely convenient.
   */
  it('matches the version in package.json', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, '../../package.json'), 'utf8'),
    ) as { version: string }
    expect(VERSION).toBe(manifest.version)
  })
})

describe('defaultPort', () => {
  it('falls back to 7600 with no override', () => {
    expect(defaultPort()).toBe(DEFAULT_PORT)
    expect(DEFAULT_PORT).toBe(7600)
  })

  it('honours a valid AGENT_CHAT_PORT override', () => {
    process.env.AGENT_CHAT_PORT = '7999'
    expect(defaultPort()).toBe(7999)
  })

  /** A typo'd override silently binding somewhere unexpected is worse than ignoring it. */
  it('ignores a malformed or out-of-range override rather than binding something random', () => {
    for (const bad of ['not-a-port', '0', '-1', '70000', '']) {
      process.env.AGENT_CHAT_PORT = bad
      expect(defaultPort()).toBe(DEFAULT_PORT)
    }
  })
})

describe('pid and meta state files', () => {
  it('round-trips the pid', () => {
    writePidFile(4242)
    expect(readPidFile()).toBe(4242)
  })

  it('round-trips the meta', () => {
    const meta = { port: 7600, version: VERSION, started: 1_700_000_000_000, pid: 4242 }
    writeMeta(meta)
    expect(readMeta()).toEqual(meta)
  })

  it('reports null rather than throwing when nothing has been written', () => {
    expect(readPidFile()).toBeNull()
    expect(readMeta()).toBeNull()
  })

  /**
   * A hard kill mid-write leaves a truncated file. `service status` must survive
   * that, because the socket probe is what actually answers liveness — the state
   * files are diagnostic and are allowed to give up quietly.
   */
  it('reports null for a corrupt or half-written meta file', () => {
    fs.writeFileSync(metaPath(), '{"port": 7600, "vers')
    expect(readMeta()).toBeNull()

    fs.writeFileSync(metaPath(), JSON.stringify({ port: 7600 }))
    expect(readMeta()).toBeNull()
  })

  it('reports null for a pid file containing garbage', () => {
    fs.writeFileSync(pidPath(), 'not-a-pid\n')
    expect(readPidFile()).toBeNull()
  })

  it('removes both files, and does not mind them already being gone', () => {
    writePidFile(4242)
    writeMeta({ port: null, version: VERSION, started: Date.now(), pid: 4242 })

    removeStateFiles()
    expect(fs.existsSync(pidPath())).toBe(false)
    expect(fs.existsSync(metaPath())).toBe(false)

    expect(() => removeStateFiles()).not.toThrow()
  })
})

describe('isProcessAlive', () => {
  it('is true for this process', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('is false for a pid that cannot exist', () => {
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(0)).toBe(false)
  })
})

describe('probeSocket', () => {
  /**
   * The distinction the whole single-instance guard rests on: a socket FILE left
   * by a killed broker must not read as a running broker. This is why liveness is
   * never answered from the pid file.
   */
  it('is false for a socket path that is only a leftover file', () => {
    const stale = path.join(tmpHome, 'chat.sock')
    fs.writeFileSync(stale, '')
    return expect(probeSocket(stale)).resolves.toBe(false)
  })

  it('is false when nothing is there at all', () => {
    return expect(probeSocket(path.join(tmpHome, 'absent.sock'))).resolves.toBe(false)
  })
})

describe('buildHealthPayload', () => {
  it('reports version, pid, socket and a non-negative uptime', () => {
    const core = makeCore()
    const payload = buildHealthPayload(core, 7600)

    expect(payload).toMatchObject({ ok: true, version: VERSION, pid: process.pid, port: 7600 })
    expect(payload.socket).toBe(path.join(tmpHome, 'chat.sock'))
    expect(payload.uptime_ms).toBeGreaterThanOrEqual(0)
  })

  it('carries a null port, because the HTTP bind is best-effort', () => {
    expect(buildHealthPayload(makeCore(), null).port).toBeNull()
  })

  it('counts live sessions and open queue items', () => {
    const core = makeCore()
    core.registry.register(fakeConn(), { name: 'alpha', workingOn: 'x', cwd: '/tmp', pid: 1 })
    core.registry.register(fakeConn(), { name: 'beta', workingOn: 'y', cwd: '/tmp', pid: 2 })
    const { msgId } = core.append({ kind: 'question', actor: 'alpha', target: HUMAN, body: 'q1' })
    core.append({ kind: 'question', actor: 'beta', target: HUMAN, body: 'q2' })

    expect(buildHealthPayload(core, null)).toMatchObject({ sessions: 2, queue_open: 2 })

    core.dismiss(msgId)
    expect(buildHealthPayload(core, null).queue_open).toBe(1)
  })

  /**
   * uptime_ms is the field that stops a reader treating a post-restart registry
   * as fact: the lease is process lifetime, so `sessions` is legitimately empty
   * for a few seconds while clients climb the reconnect ladder.
   */
  it('reports a fresh core as having near-zero uptime and no sessions', () => {
    const payload = buildHealthPayload(makeCore(), null)
    expect(payload.sessions).toBe(0)
    expect(payload.uptime_ms).toBeLessThan(1000)
  })
})
