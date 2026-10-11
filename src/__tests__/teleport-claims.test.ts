import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { TELEPORT_GAP_MS } from '../broker/teleport-window.js'

/** CC-397: a teleported seat's successor keeps the name, so it keeps the name's claims. */

const SEAT = 'seat'
const TREE = '/repo/.worktrees/seat'

let dir: string
let core: BrokerCore
let sessions = 0

beforeEach(() => {
  vi.useFakeTimers()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-teleport-claims-'))
  process.env.AGENT_CHAT_HOME = dir
  core = new BrokerCore(() => true, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
})

afterEach(() => {
  vi.useRealTimers()
  core.close()
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

const fakeConn = (): Conn => ({}) as unknown as net.Socket

function register(agentId?: string): Conn {
  sessions += 1
  const conn = fakeConn()
  const msg = {
    t: 'register' as const,
    name: SEAT,
    workingOn: 'w',
    cwd: TREE,
    pid: 100 + sessions,
    sessionId: `session-${sessions}`,
    ...(agentId === undefined ? {} : { agentId }),
  }
  expect(core.register(conn, msg).ok).toBe(true)
  return conn
}

function claimFiles(): void {
  expect(core.claims.claim({ owner: SEAT, worktreePath: TREE, patterns: ['src/**'] }).ok).toBe(true)
}

/** The seat writes its handoff and stands down, as `teleport` does; returns the successor's minted id. */
function teleport(predecessor: Conn): string {
  const agentId = core.registry.entryFor(predecessor)?.agentId as string
  const { msgId: successor } = core.append({
    kind: 'agent_spawned',
    actor: SEAT,
    target: SEAT,
    body: 'w',
    meta: { name: SEAT },
  })
  core.append({ kind: 'agent_handoff', actor: SEAT, ref: agentId, body: 'h', meta: { successor } })
  core.append({ kind: 'agent_stood_down', actor: SEAT, ref: agentId })
  return successor
}

const held = (): Array<{ owner: string; patterns: string[] }> =>
  core.claims.list().map(c => ({ owner: c.owner, patterns: c.patterns }))

describe('a teleporting seat holding claims', () => {
  it('leaves its successor the same claim set without a claim call', () => {
    const predecessor = register()
    claimFiles()
    const before = held()
    const successor = teleport(predecessor)

    core.drop(predecessor)
    register(successor)

    expect(held()).toEqual(before)
  })

  it('keeps them past the gap when the successor registered in time', () => {
    const predecessor = register()
    claimFiles()
    const successor = teleport(predecessor)
    core.drop(predecessor)

    register(successor)
    vi.advanceTimersByTime(TELEPORT_GAP_MS)

    expect(held()).toHaveLength(1)
  })

  it('releases them after the gap when the successor never registers', () => {
    const predecessor = register()
    claimFiles()
    teleport(predecessor)
    core.drop(predecessor)
    expect(held()).toHaveLength(1)

    vi.advanceTimersByTime(TELEPORT_GAP_MS)

    expect(held()).toEqual([])
  })

  it('does not lose them to a superseded predecessor closing after the name was taken over', () => {
    const predecessor = register()
    claimFiles()
    const agentId = core.registry.entryFor(predecessor)?.agentId as string
    teleport(predecessor)

    register(agentId)
    core.drop(predecessor)

    expect(held()).toHaveLength(1)
  })
})

describe('a seat that drops without teleporting', () => {
  it('releases its claims at once', () => {
    const conn = register()
    claimFiles()

    core.drop(conn)

    expect(held()).toEqual([])
  })
})
