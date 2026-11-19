import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentLog } from '../agents/identity.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import type { AgentIdentity } from '../protocol.js'
import { EventLog } from '../broker/event-log.js'
import { returningSession } from '../broker/handoff-recovery.js'
import { Registry } from '../broker/registry.js'

/** CC-601: a register's session lookup reads the session's own spawns, never the whole agent log. */

let dir: string
let events: EventLog
let agents: AgentLog
let clock = 1_700_000_000_000

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-session-lookup-'))
  events = new EventLog(path.join(dir, 'events.db'))
  agents = new AgentLog(events)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(clock)
})

afterEach(() => {
  vi.useRealTimers()
  events.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** A spawn row at `at`; `origin: 'adopted'` is a hand-started session, anything else a broker spawn. */
function spawn(name: string, sessionId: string, at: number, origin?: 'adopted'): string {
  vi.setSystemTime(at)
  const meta = { session_id: sessionId, cwd: '/tmp/x', ...(origin ? { origin } : {}) }
  return events.append({ kind: 'agent_spawned', actor: 'human', target: name, meta }).msgId
}

function retire(agentId: string): void {
  events.append({ kind: 'agent_retired', actor: 'human', ref: agentId })
}

/** What `bySession` returned before CC-601: a scan of the full fold. */
const fullScan = (sessionId: string): AgentIdentity | undefined =>
  agents
    .roster({ includeRetired: true })
    .find(a => a.origin === 'adopted' && a.sessionId === sessionId && a.state !== 'retired')

/** One log covering every branch the scan filtered on. */
function seed(): void {
  const old = spawn('alpha', 'session-a', clock, 'adopted')
  retire(old)
  spawn('alpha', 'session-a', clock + 10, 'adopted')
  spawn('alpha-dup', 'session-a', clock + 10, 'adopted')
  spawn('beta', 'session-a', clock + 5, 'adopted')
  spawn('worker', 'session-w', clock + 20)
  retire(spawn('gone', 'session-g', clock + 30, 'adopted'))
  spawn('other', 'session-o', clock + 40, 'adopted')
}

describe('AgentLog.bySession', () => {
  beforeEach(seed)

  it.each(['session-a', 'session-w', 'session-g', 'session-o', 'session-none', ''])(
    'finds what the full scan finds for %j',
    sessionId => {
      const expected = fullScan(sessionId)

      const found = agents.bySession(sessionId)

      expect(found?.agentId).toBe(expected?.agentId)
      expect(found).toEqual(expected)
    },
  )

  it('picks the newest live adopted spawn, and the earlier of two spawned in the same ms', () => {
    expect(agents.bySession('session-a')?.name).toBe('alpha')
  })

  it('never reads the whole agent log', () => {
    const read = vi.spyOn(events, 'agentEvents')

    for (const id of ['session-a', 'session-w', 'session-none']) agents.bySession(id)

    expect(read).not.toHaveBeenCalled()
  })

  it('answers from the spawn-session index', () => {
    const plan = events['db']
      .prepare(
        `EXPLAIN QUERY PLAN SELECT msg_id FROM events WHERE kind = 'agent_spawned'
           AND json_extract(meta, '$.session_id') = ? AND msg_id IS NOT NULL ORDER BY id ASC`,
      )
      .all('session-a') as { detail: string }[]

    expect(plan.map(row => row.detail).join('\n')).toContain('events_spawn_session')
  })
})

describe('a register', () => {
  let core: BrokerCore

  beforeEach(() => {
    core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  })

  const message = (name: string, sessionId: string, agentId?: string) => ({
    t: 'register' as const,
    name,
    workingOn: 'w',
    cwd: '/tmp/x',
    pid: 4242,
    sessionId,
    ...(agentId === undefined ? {} : { agentId }),
  })

  it('asks whether its session is returning without reading the agent log', () => {
    core.register({} as unknown as net.Socket, message('first', 'session-r'))
    const read = vi.spyOn(events, 'agentEvents')

    const returning = returningSession(core, message('first', 'session-r'))

    expect(returning).toBe(true)
    expect(read).not.toHaveBeenCalled()
  })

  it('reads no agent log to tell a spawned agent it is not returning', () => {
    const agentId = spawn('spawned', 'session-s', clock)
    const read = vi.spyOn(events, 'agentEvents')

    const returning = returningSession(core, message('spawned', 'session-s', agentId))

    expect(returning).toBe(false)
    expect(read).not.toHaveBeenCalled()
  })
})
