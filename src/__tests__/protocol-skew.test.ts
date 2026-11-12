import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { SocketServer } from '../broker/socket.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'
import { MIN_CLIENT_PROTOCOL, PROTOCOL_VERSION } from '../protocol-version.js'

/**
 * CC-1728: a client built far behind the broker failed to register with reasons
 * that named some other cause ("held by another session", "not registered").
 * The broker now names the skew: a stated protocol below its minimum is refused
 * with a rebuild instruction, and a client that states none gets the same advice
 * appended to its registration failures.
 */

const tmpDirs: string[] = []

interface Wire {
  conn: Conn
  frames: ServerMessage[]
}

function makeServer(): { server: SocketServer; wire: () => Wire } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-cc1728-'))
  tmpDirs.push(dir)
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
  const wire = (): Wire => {
    const frames: ServerMessage[] = []
    const conn = {
      write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
    } as unknown as Conn
    return { conn, frames }
  }
  return { server: new SocketServer(core), wire }
}

const registration = (name: string, extra: Partial<Extract<ClientMessage, { t: 'register' }>> = {}) =>
  ({ t: 'register', name, workingOn: 'testing', cwd: '/tmp', pid: 1, ...extra }) as const

const registerResult = (frames: ServerMessage[]) =>
  frames.find((f): f is Extract<ServerMessage, { t: 'register_result' }> => f.t === 'register_result')

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('a client older than the broker protocol', () => {
  it('is refused by name, with its build, the broker protocol and the host to rebuild on', () => {
    const { server, wire } = makeServer()
    const { conn, frames } = wire()
    const old = { protocol: MIN_CLIENT_PROTOCOL - 1, build: '/opt/old/dist/cli.js', host: 'Mac' }

    server.handleMessage(conn, registration('stale', old))

    const result = registerResult(frames)
    expect(result).toMatchObject({ ok: false, code: 'protocol_too_old' })
    expect(result?.reason).toContain(`speaks protocol ${MIN_CLIENT_PROTOCOL - 1}`)
    expect(result?.reason).toContain(`minimum protocol ${MIN_CLIENT_PROTOCOL}`)
    expect(result?.reason).toContain('/opt/old/dist/cli.js')
    expect(result?.reason).toContain('rebuild agent-chat on Mac')
  })

  it('is refused on readopt too, before the broker looks the session up', () => {
    const { server, wire } = makeServer()
    const { conn, frames } = wire()

    server.handleMessage(conn, { t: 'readopt', sessionId: 's1', cwd: '/tmp', pid: 1, protocol: 0 })

    expect(registerResult(frames)).toMatchObject({ ok: false, code: 'protocol_too_old' })
  })

  it('leaves a current client unaffected', () => {
    const { server, wire } = makeServer()
    const { conn, frames } = wire()

    server.handleMessage(conn, registration('fresh', { protocol: PROTOCOL_VERSION }))

    expect(registerResult(frames)).toEqual({ t: 'register_result', ok: true })
  })
})

describe('a client that sends no protocol', () => {
  it('still registers, so sessions started before a deploy keep working', () => {
    const { server, wire } = makeServer()
    const { conn, frames } = wire()

    server.handleMessage(conn, registration('legacy'))

    expect(registerResult(frames)).toEqual({ t: 'register_result', ok: true })
  })

  it('hears that a failed registration may be build skew', () => {
    const { server, wire } = makeServer()
    server.handleMessage(wire().conn, registration('taken', { protocol: PROTOCOL_VERSION }))
    const { conn, frames } = wire()

    server.handleMessage(conn, registration('taken', { build: '/opt/old/dist/cli.js', host: 'Mac' }))

    const reason = registerResult(frames)?.reason
    expect(reason).toContain('held by another session')
    expect(reason).toContain('sends no protocol version')
    expect(reason).toContain('rebuild agent-chat on Mac')
  })

  it('hears it again when a send is refused for want of a registration', () => {
    const { server, wire } = makeServer()
    server.handleMessage(wire().conn, registration('taken', { protocol: PROTOCOL_VERSION }))
    const { conn, frames } = wire()
    server.handleMessage(conn, registration('taken', { host: 'Mac' }))

    server.handleMessage(conn, { t: 'send', to: 'taken', text: 'hello' })

    const sent = frames.find(f => f.t === 'send_result')
    expect(sent).toMatchObject({ ok: false })
    expect(sent && 'reason' in sent ? sent.reason : '').toContain('sends no protocol version')
  })

  it('a current client failing the same way gets no skew advice', () => {
    const { server, wire } = makeServer()
    server.handleMessage(wire().conn, registration('taken', { protocol: PROTOCOL_VERSION }))
    const { conn, frames } = wire()

    server.handleMessage(conn, registration('taken', { protocol: PROTOCOL_VERSION }))

    expect(registerResult(frames)?.reason).not.toContain('protocol')
  })
})
