import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { CWD_GRACE_MS, RECOVERY_MAX_AGE_MS, recoverHandoff } from '../broker/handoff-recovery.js'
import { Registry } from '../broker/registry.js'

/** CC-524: a handoff whose successor never registered reaches the next session that could act on it. */

const HANDOFF = 'mid-way through the migration; step 3 failed twice'
const SETTLED = CWD_GRACE_MS + 1_000

let dir: string
let seatDir: string
let core: BrokerCore
let delivered: Array<{ conn: Conn; text: string }>
let sessions = 0

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-recover-'))
  seatDir = path.join(dir, 'seat')
  process.env.AGENT_CHAT_HOME = dir
  delivered = []
  core = new BrokerCore((conn, message) => delivered.push({ conn, text: message.text }), {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

const fakeConn = (): Conn => ({}) as unknown as net.Socket

/** An ordinary session registering, the way the socket layer hands one to the core. */
function register(name: string, cwd: string, agentId?: string) {
  sessions += 1
  const msg = {
    t: 'register' as const,
    name,
    workingOn: 'w',
    cwd,
    pid: 100 + sessions,
    sessionId: `session-${sessions}`,
    ...(agentId === undefined ? {} : { agentId }),
  }
  const conn = fakeConn()
  expect(core.register(conn, msg).ok).toBe(true)
  return { conn, msg }
}

interface Orphan {
  standDown?: boolean
  text?: string
}

/** `name` ran in `seatDir`, wrote a handoff and (unless told otherwise) stood down; its successor never attaches. */
function orphaned(name: string, { standDown = true, text = HANDOFF }: Orphan = {}): string {
  const { conn } = register(name, seatDir)
  const agentId = core.registry.entryFor(conn)?.agentId as string
  const successor = `succ-${agentId}`
  core.append({ kind: 'agent_handoff', actor: name, ref: agentId, body: text, meta: { successor } })
  if (standDown) core.append({ kind: 'agent_stood_down', actor: name, ref: agentId })
  core.drop(conn)
  return successor
}

const shownTo = (conn: Conn): string[] => delivered.filter(d => d.conn === conn).map(d => d.text)

describe('the next session to register the name', () => {
  it('is shown the stored handoff, with who wrote it and why it is seeing it', () => {
    orphaned('lead')

    const { conn, msg } = register('lead', path.join(dir, 'elsewhere'))
    expect(recoverHandoff(core, msg)).toBe(true)

    const [text] = shownTo(conn)
    expect(text).toContain(HANDOFF)
    expect(text).toContain('its successor never registered')
    expect(text).toContain('you registered the name lead')
    expect(text).toContain('agent-chat handoff last lead')
    expect(core.events.inboxFor('lead', 10).some(m => m.text.includes(HANDOFF))).toBe(true)
  })

  it('is shown it once: a later registration gets nothing', () => {
    orphaned('lead')
    const first = register('lead', seatDir)
    recoverHandoff(core, first.msg)
    core.drop(first.conn)

    const second = register('lead', seatDir)

    expect(recoverHandoff(core, second.msg)).toBe(false)
    expect(shownTo(second.conn)).toEqual([])
  })
})

describe('the next session to start in the directory', () => {
  it('is shown the handoff under its own name once the successor has had time to register', () => {
    orphaned('lead')

    const { conn, msg } = register('passer-by', seatDir)
    expect(recoverHandoff(core, msg, Date.now() + SETTLED)).toBe(true)

    expect(shownTo(conn)[0]).toContain(HANDOFF)
    expect(shownTo(conn)[0]).toContain("you started in lead's working directory")
  })

  it('is shown nothing while the successor may still be starting', () => {
    orphaned('lead')

    const { conn, msg } = register('passer-by', seatDir)

    expect(recoverHandoff(core, msg)).toBe(false)
    expect(shownTo(conn)).toEqual([])
  })

  it('is shown nothing in a different directory', () => {
    orphaned('lead')

    const { msg } = register('passer-by', path.join(dir, 'elsewhere'))

    expect(recoverHandoff(core, msg, Date.now() + SETTLED)).toBe(false)
  })

  it('is shown nothing when it is a broker-spawned agent, which has a brief of its own', () => {
    orphaned('lead')
    const { msgId: worker } = core.append({
      kind: 'agent_spawned',
      actor: 'someone',
      target: 'worker-a',
      body: 'a brief',
      meta: { name: 'worker-a', cwd: seatDir },
    })

    const { msg } = register('worker-a', seatDir, worker)

    expect(recoverHandoff(core, msg, Date.now() + SETTLED)).toBe(false)
  })
})

describe('a handoff that is not undelivered', () => {
  it('is not shown when its successor registered', () => {
    const successor = orphaned('lead')
    core.append({ kind: 'agent_attached', actor: 'lead', ref: successor })

    const { msg } = register('lead', seatDir)

    expect(recoverHandoff(core, msg)).toBe(false)
  })

  it('is not shown when the teleport was aborted before the predecessor stood down', () => {
    orphaned('lead', { standDown: false })

    const { msg } = register('lead', seatDir)

    expect(recoverHandoff(core, msg)).toBe(false)
  })

  it('is not shown once it is older than the recovery window', () => {
    orphaned('lead')

    const { msg } = register('lead', seatDir)

    expect(recoverHandoff(core, msg, Date.now() + RECOVERY_MAX_AGE_MS + 1_000)).toBe(false)
  })
})

describe('an aborted attempt followed by a teleport that went through', () => {
  it('shows only the handoff the predecessor stood down on', () => {
    const { conn } = register('lead', seatDir)
    const agentId = core.registry.entryFor(conn)?.agentId as string
    const handoff = (body: string, successor: string) =>
      core.append({ kind: 'agent_handoff', actor: 'lead', ref: agentId, body, meta: { successor } })
    handoff('first attempt, aborted', 'succ-1')
    handoff('second attempt', 'succ-2')
    core.append({ kind: 'agent_stood_down', actor: 'lead', ref: agentId })
    core.drop(conn)

    const next = register('lead', seatDir)
    recoverHandoff(core, next.msg)
    core.drop(next.conn)
    const later = register('lead', seatDir)

    expect(shownTo(next.conn)[0]).toContain('second attempt')
    expect(recoverHandoff(core, later.msg)).toBe(false)
  })
})
