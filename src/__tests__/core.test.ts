import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { HUMAN, type DeliveredMessage } from '../protocol.js'

/**
 * Unit tests for the single write path. These reach past the socket on purpose:
 * `routing.test.ts` already drives the real MCP protocol end to end, so what is
 * left to prove here is the part that has no transport — that fan-out cannot
 * drift from the log, and that a verdict on an already-closed item is refused
 * the same way whichever caller asks.
 */

const tmpDirs: string[] = []

function makeCore(): { core: BrokerCore; delivered: Array<{ conn: Conn; message: DeliveredMessage }> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-core-'))
  tmpDirs.push(dir)
  const delivered: Array<{ conn: Conn; message: DeliveredMessage }> = []
  const core = new BrokerCore(
    (conn, message) => {
      delivered.push({ conn, message })
    },
    { events: new EventLog(path.join(dir, 'events.db')), registry: new Registry<Conn>() },
  )
  return { core, delivered }
}

/** A stand-in for a socket. The core only ever uses it as an identity token. */
const fakeConn = (): Conn => ({}) as unknown as net.Socket

function registerSession(core: BrokerCore, name: string): Conn {
  const conn = fakeConn()
  core.registry.register(conn, { name, workingOn: 'testing', cwd: '/tmp', pid: 1 })
  return conn
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('core.append fan-out', () => {
  it('notifies every subscriber with the id of the row it just wrote', () => {
    const { core } = makeCore()
    const frames: Array<{ event: string; data: string }> = []
    core.hub.subscribe(frame => {
      frames.push(frame)
    })

    const written = core.append({ kind: 'notice', actor: 'alpha', target: HUMAN, body: 'hello' })

    expect(frames).toHaveLength(1)
    const payload = JSON.parse(frames[0]!.data) as { id: number; msgId: string; kind: string; actor: string }
    expect(payload).toMatchObject({ id: written.id, msgId: written.msgId, kind: 'notice', actor: 'alpha' })
  })

  /**
   * The reason append() is the only writer: a subscriber that sees N frames must
   * be able to conclude N rows exist. A second write path would break that
   * silently, and the drift would only show up in the dashboard much later.
   */
  it('emits exactly one frame per row, and the row is really in the log', () => {
    const { core } = makeCore()
    let frameCount = 0
    core.hub.subscribe(() => {
      frameCount += 1
    })

    core.append({ kind: 'notice', actor: 'alpha', target: HUMAN, body: 'one' })
    core.append({ kind: 'notice', actor: 'alpha', target: HUMAN, body: 'two' })

    expect(frameCount).toBe(2)
    expect(core.events.history(10)).toHaveLength(2)
  })

  it('keeps writing to the log when a subscriber throws, and drops that subscriber', () => {
    const { core } = makeCore()
    core.hub.subscribe(() => {
      throw new Error('subscriber exploded')
    })

    expect(() => core.append({ kind: 'notice', actor: 'alpha', body: 'still written' })).not.toThrow()
    expect(core.events.history(10)).toHaveLength(1)
    expect(core.hub.size).toBe(0)
  })
})

describe('core.register — CC-9 workingOn collision notice', () => {
  it('notices the human when two sessions in the same cwd register identical workingOn text', () => {
    const { core } = makeCore()
    core.register(fakeConn(), {
      t: 'register',
      name: 'alpha',
      workingOn: 'fixing CC-9',
      cwd: '/repo',
      pid: 1,
    })
    core.register(fakeConn(), { t: 'register', name: 'beta', workingOn: 'fixing CC-9', cwd: '/repo', pid: 2 })

    const notices = core.events.history(10).filter(row => row.kind === 'notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ from: 'agent-chat', meta: { target: HUMAN } })
    expect(notices[0]!.text).toContain('beta')
    expect(notices[0]!.text).toContain('alpha')
    expect(notices[0]!.text).toContain('/repo')
  })

  it('does not notice when workingOn differs', () => {
    const { core } = makeCore()
    core.register(fakeConn(), {
      t: 'register',
      name: 'alpha',
      workingOn: 'fixing CC-9',
      cwd: '/repo',
      pid: 1,
    })
    core.register(fakeConn(), {
      t: 'register',
      name: 'beta',
      workingOn: 'fixing CC-10',
      cwd: '/repo',
      pid: 2,
    })

    expect(core.events.history(10).filter(row => row.kind === 'notice')).toHaveLength(0)
  })

  it('does not notice when cwd differs', () => {
    const { core } = makeCore()
    core.register(fakeConn(), {
      t: 'register',
      name: 'alpha',
      workingOn: 'fixing CC-9',
      cwd: '/repo-a',
      pid: 1,
    })
    core.register(fakeConn(), {
      t: 'register',
      name: 'beta',
      workingOn: 'fixing CC-9',
      cwd: '/repo-b',
      pid: 2,
    })

    expect(core.events.history(10).filter(row => row.kind === 'notice')).toHaveLength(0)
  })

  it('does not notice a re-register of the same session against its own prior entry', () => {
    const { core } = makeCore()
    const conn = fakeConn()
    core.register(conn, { t: 'register', name: 'alpha', workingOn: 'fixing CC-9', cwd: '/repo', pid: 1 })
    core.register(conn, { t: 'register', name: 'alpha', workingOn: 'fixing CC-9', cwd: '/repo', pid: 1 })

    expect(core.events.history(10).filter(row => row.kind === 'notice')).toHaveLength(0)
  })
})

describe('core.answer', () => {
  it('delivers live to an author that is still connected', () => {
    const { core, delivered } = makeCore()
    const conn = registerSession(core, 'alpha')
    const { msgId } = core.append({ kind: 'question', actor: 'alpha', target: HUMAN, body: 'which branch?' })

    const result = core.answer(msgId, 'the feature one')

    expect(result).toEqual({ ok: true })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.conn).toBe(conn)
    expect(delivered[0]!.message).toMatchObject({ from: HUMAN, text: 'the feature one', inReplyTo: msgId })
  })

  /**
   * Offline is a success, not a failure: the answer is in the log and the inbox
   * is a query over the log, so it is waiting when that session comes back. The
   * reason string exists to stop a caller reporting it as delivered.
   */
  it('records the answer for an offline author and says so without failing', () => {
    const { core, delivered } = makeCore()
    const conn = registerSession(core, 'alpha')
    const { msgId } = core.append({ kind: 'question', actor: 'alpha', target: HUMAN, body: 'which branch?' })
    core.registry.drop(conn)

    const result = core.answer(msgId, 'the feature one')

    expect(result.ok).toBe(true)
    expect(result.reason).toMatch(/alpha is offline/)
    expect(delivered).toHaveLength(0)
    expect(core.events.inboxFor('alpha', 10)).toHaveLength(1)
  })

  it('refuses an item that has already been answered', () => {
    const { core } = makeCore()
    registerSession(core, 'alpha')
    const { msgId } = core.append({ kind: 'question', actor: 'alpha', target: HUMAN, body: 'which branch?' })
    core.answer(msgId, 'first')

    const second = core.answer(msgId, 'second')

    expect(second.ok).toBe(false)
    expect(second.reason).toMatch(/not an open item/)
  })

  it('refuses an item that has already been dismissed', () => {
    const { core } = makeCore()
    registerSession(core, 'alpha')
    const { msgId } = core.append({ kind: 'question', actor: 'alpha', target: HUMAN, body: 'which branch?' })
    core.dismiss(msgId)

    expect(core.answer(msgId, 'too late').ok).toBe(false)
  })

  it('refuses a msg_id that was never written', () => {
    const { core } = makeCore()
    const result = core.answer('deadbeef', 'into the void')
    expect(result).toEqual({ ok: false, reason: 'deadbeef is not an open item' })
  })
})

describe('core.dismiss', () => {
  it('closes an open item and refuses to close it twice', () => {
    const { core } = makeCore()
    registerSession(core, 'alpha')
    const { msgId } = core.append({ kind: 'question', actor: 'alpha', target: HUMAN, body: 'which branch?' })

    expect(core.dismiss(msgId)).toEqual({ ok: true })
    expect(core.events.humanQueue()).toHaveLength(0)
    expect(core.dismiss(msgId).ok).toBe(false)
  })

  /** Resolution is an event, so dismissing adds a row rather than removing one. */
  it('records the dismissal instead of deleting the item', () => {
    const { core } = makeCore()
    registerSession(core, 'alpha')
    const { msgId } = core.append({ kind: 'question', actor: 'alpha', target: HUMAN, body: 'which branch?' })
    core.dismiss(msgId)

    const history = core.events.history(10)
    expect(history).toHaveLength(2)
    expect(history.map(item => item.kind)).toContain('resolution')
  })
})
