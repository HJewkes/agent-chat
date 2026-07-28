import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventLog, type AgentEventRow } from '../broker/event-log.js'
import { AgentLog, foldAgent, pairPresence } from '../agents/identity.js'
import type { AgentIdentity, AgentLifecycle, EventKind } from '../protocol.js'

const dirs: string[] = []

function freshLog(): EventLog {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-agents-'))
  dirs.push(dir)
  return new EventLog(path.join(dir, 'events.db'))
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

// Synthetic rows: the fold takes no database, no clock and no process, so the
// whole of §2.4 is exercised without any of them.
let clock = 1_000

const row = (kind: EventKind, over: Partial<AgentEventRow> = {}): AgentEventRow => ({
  kind,
  ts: (clock += 10),
  actor: 'scout',
  target: null,
  msgId: null,
  ref: 'a1',
  body: null,
  meta: {},
  ...over,
})

const spawned = (over: Partial<AgentEventRow> = {}): AgentEventRow =>
  row('agent_spawned', {
    actor: 'human',
    target: 'scout',
    msgId: 'a1',
    ref: null,
    body: 'go read the log',
    meta: {
      profile: 'reader',
      cwd: '/tmp/wt',
      isolation: 'worktree',
      surface: 'headless',
      session_id: 'sess-1',
    },
    ...over,
  })

const stateAfter = (...rows: AgentEventRow[]): AgentLifecycle | undefined =>
  foldAgent([spawned(), ...rows])?.state

describe('the lifecycle fold', () => {
  it('carries the spawn payload onto the identity', () => {
    const agent = foldAgent([spawned()])

    expect(agent).toMatchObject({
      agentId: 'a1',
      name: 'scout',
      profile: 'reader',
      spawnedBy: 'human',
      brief: 'go read the log',
      cwd: '/tmp/wt',
      isolation: 'worktree',
      surface: 'headless',
      sessionId: 'sess-1',
      state: 'spawning',
    })
  })

  it('walks every transition in the table', () => {
    expect(stateAfter()).toBe('spawning')
    expect(stateAfter(row('agent_attached'))).toBe('live')
    expect(stateAfter(row('agent_attached'), row('agent_detached'))).toBe('detached')
    expect(stateAfter(row('agent_attached'), row('agent_exited'))).toBe('exited')
    expect(stateAfter(row('agent_attached'), row('agent_retired'))).toBe('retired')
  })

  it('sends a resumed agent back to spawning, then live on the next attach', () => {
    expect(stateAfter(row('agent_attached'), row('agent_detached'), row('agent_resumed'))).toBe('spawning')
    expect(
      stateAfter(row('agent_attached'), row('agent_detached'), row('agent_resumed'), row('agent_attached')),
    ).toBe('live')
  })

  it('treats retired as terminal, because the name is already free to reclaim', () => {
    expect(stateAfter(row('agent_retired'), row('agent_attached'))).toBe('retired')
  })

  it('records the exit payload on the event that learned it', () => {
    const agent = foldAgent([
      spawned(),
      row('agent_attached'),
      row('agent_exited', { body: 'read 40 files', meta: { code: '0', cost_usd: '0.42' } }),
    ])

    expect(agent?.exit).toEqual({ code: 0, summary: 'read 40 files', costUsd: 0.42 })
  })

  it('reports a null exit code for a signal death rather than pretending it was 0', () => {
    const agent = foldAgent([spawned(), row('agent_exited', { meta: {} })])

    expect(agent?.exit).toEqual({ code: null, summary: '' })
  })

  it('ignores rows citing an id that was never spawned', () => {
    expect(foldAgent([row('agent_attached'), row('agent_exited')])).toBeUndefined()
  })

  it('reads a row with no origin marker as a supervisor spawn', () => {
    // Every row written before adoption existed is one, so the default decides
    // how the whole existing log folds.
    expect(foldAgent([spawned()])?.origin).toBe('spawned')
  })

  it('marks an adopted identity, so a self-chosen name is not read as an assigned one', () => {
    const adopted = spawned({ meta: { origin: 'adopted', session_id: 'sess-9' } })

    expect(foldAgent([adopted])?.origin).toBe('adopted')
  })

  it('lets an adopted name follow the session, since the session chose it', () => {
    const adopted = spawned({ meta: { origin: 'adopted' } })
    const agent = foldAgent([adopted, row('agent_attached', { actor: 'scout-renamed' })])

    expect(agent?.name).toBe('scout-renamed')
  })

  it('pins a spawned name, because peers were told it before the agent had a turn', () => {
    const agent = foldAgent([spawned(), row('agent_attached', { actor: 'impostor' })])

    expect(agent?.name).toBe('scout')
  })

  it('advances lastEventAt without letting isolation rows change lifecycle', () => {
    const attached = row('agent_attached')
    const allocated = row('isolation_allocated', { meta: { branch: 'agent/scout' } })
    const agent = foldAgent([spawned(), attached, allocated])

    expect(agent?.state).toBe('live')
    expect(agent?.lastEventAt).toBe(allocated.ts)
  })
})

describe('pairing identity with presence', () => {
  const at = (state: AgentLifecycle): AgentIdentity => ({
    agentId: 'a1',
    name: 'scout',
    profile: 'reader',
    state,
    origin: 'spawned',
    spawnedBy: 'human',
    spawnedAt: 1,
    brief: '',
    cwd: '',
    isolation: '',
    surface: '',
    sessionId: '',
    lastEventAt: 1,
  })

  it('renders the normal cases from the table', () => {
    expect(pairPresence(at('live'), { connected: true }).status).toBe('running')
    expect(pairPresence(at('live'), { connected: false }).status).toBe('reconnecting')
    expect(pairPresence(at('detached'), { connected: false }).status).toBe('detached')
    expect(pairPresence(at('exited'), { connected: false }).status).toBe('finished')
    expect(pairPresence(at('spawning'), { connected: false }).status).toBe('starting')
    expect(pairPresence(at('retired'), { connected: false }).status).toBe('retired')
  })

  it('derives blocked from an open approval rather than storing it', () => {
    expect(pairPresence(at('live'), { connected: true, blocked: true }).status).toBe('blocked')
  })

  it('only reports a stall when the caller supplied a threshold', () => {
    expect(pairPresence(at('live'), { connected: true, idleMs: 900_000 }).status).toBe('running')
    expect(
      pairPresence(at('live'), { connected: true, idleMs: 900_000, stalledAfterMs: 600_000 }).status,
    ).toBe('stalled?')
  })

  it('trusts presence over a detached lifecycle, and says so', () => {
    const paired = pairPresence(at('detached'), { connected: true })

    expect(paired.status).toBe('running')
    expect(paired.anomaly).toMatch(/detached identity holds a live connection/)
  })

  it('trusts presence over an exited lifecycle, and says so', () => {
    const paired = pairPresence(at('exited'), { connected: true })

    expect(paired.status).toBe('running')
    expect(paired.anomaly).toMatch(/exited identity holds a live connection/)
  })

  it('leaves the normal cases free of anomalies', () => {
    expect(pairPresence(at('live'), { connected: true }).anomaly).toBeUndefined()
    expect(pairPresence(at('detached'), { connected: false }).anomaly).toBeUndefined()
  })

  it('keeps a durable agent on the roster while the broker bounces', () => {
    // Service plan §8 item 4: the registry empties on restart and every presence
    // view lies for up to ~8.85s. The agent must change presence, not vanish.
    expect(pairPresence(at('live'), { connected: false }).status).toBe('reconnecting')
  })
})

describe('AgentLog over a real event log', () => {
  const spawn = (log: EventLog, id: string, name: string) =>
    log.append({
      kind: 'agent_spawned',
      actor: 'human',
      target: name,
      msgId: id,
      body: `brief for ${name}`,
      meta: { profile: 'reader' },
    })

  it('folds independent agents without crossing their rows', () => {
    const log = freshLog()
    spawn(log, 'a1', 'scout')
    spawn(log, 'a2', 'runner')
    log.append({ kind: 'agent_attached', actor: 'scout', ref: 'a1' })

    expect(log.agentEvents()).toHaveLength(3)
    const agents = new AgentLog(log)
    expect(agents.get('a1')?.state).toBe('live')
    expect(agents.get('a2')?.state).toBe('spawning')
  })

  it('ignores rows that are not agent rows at all', () => {
    const log = freshLog()
    log.append({ kind: 'message', actor: 'alice', target: 'bob', body: 'unrelated' })
    spawn(log, 'a1', 'scout')

    expect(new AgentLog(log).roster()).toHaveLength(1)
  })

  it('hides retired agents from the roster unless asked', () => {
    const log = freshLog()
    spawn(log, 'a1', 'scout')
    log.append({ kind: 'agent_retired', actor: 'human', target: 'scout', ref: 'a1' })

    const agents = new AgentLog(log)
    expect(agents.roster()).toHaveLength(0)
    expect(agents.roster({ includeRetired: true })).toHaveLength(1)
  })

  it('holds a name claimed until the identity retires, not until it exits', () => {
    const log = freshLog()
    spawn(log, 'a1', 'scout')
    const agents = new AgentLog(log)
    expect(agents.nameIsClaimed('scout')).toBe(true)

    log.append({ kind: 'agent_exited', actor: 'scout', ref: 'a1' })
    expect(agents.nameIsClaimed('scout')).toBe(true)

    log.append({ kind: 'agent_retired', actor: 'human', target: 'scout', ref: 'a1' })
    expect(agents.nameIsClaimed('scout')).toBe(false)
  })

  it('does not claim a name nothing ever held', () => {
    expect(new AgentLog(freshLog()).nameIsClaimed('nobody')).toBe(false)
  })

  it('resolves a reused name to the identity that currently holds it', () => {
    const log = freshLog()
    spawn(log, 'a1', 'scout')
    log.append({ kind: 'agent_retired', actor: 'human', target: 'scout', ref: 'a1' })
    spawn(log, 'a2', 'scout')

    expect(new AgentLog(log).byName('scout')?.agentId).toBe('a2')
  })

  const adopt = (log: EventLog, id: string, name: string, sessionId: string) =>
    log.append({
      kind: 'agent_spawned',
      actor: 'human',
      target: name,
      msgId: id,
      meta: { origin: 'adopted', session_id: sessionId },
    })

  it('finds an adopted identity by the Claude Code session it belongs to', () => {
    const log = freshLog()
    adopt(log, 'a1', 'scout', 'sess-1')

    expect(new AgentLog(log).bySession('sess-1')?.agentId).toBe('a1')
  })

  it('refuses to hand a spawned identity to anyone quoting its session id', () => {
    // The id is in the log where every session on the machine can read it, so
    // matching on it would make adoption a way to claim someone else's agent.
    const log = freshLog()
    log.append({
      kind: 'agent_spawned',
      actor: 'human',
      target: 'scout',
      msgId: 'a1',
      meta: { session_id: 'sess-1' },
    })

    expect(new AgentLog(log).bySession('sess-1')).toBeUndefined()
  })

  it('matches no identity for a session id it has never seen, and none for none', () => {
    const log = freshLog()
    adopt(log, 'a1', 'scout', 'sess-1')
    const agents = new AgentLog(log)

    expect(agents.bySession('sess-2')).toBeUndefined()
    expect(agents.bySession('')).toBeUndefined()
  })

  it('keeps adopted identities out of retire and resume, which cannot act on them', () => {
    // byName is what those two resolve through, and an adopted identity has no
    // launch plan to relaunch and no isolation to release.
    const log = freshLog()
    adopt(log, 'a1', 'scout', 'sess-1')

    expect(new AgentLog(log).byName('scout')).toBeUndefined()
  })

  it('does not let a human session lease a name a later agent may need', () => {
    const log = freshLog()
    adopt(log, 'a1', 'scout', 'sess-1')

    expect(new AgentLog(log).nameIsClaimed('scout')).toBe(false)
  })

  it('still lists an adopted identity on the roster', () => {
    const log = freshLog()
    adopt(log, 'a1', 'scout', 'sess-1')

    expect(new AgentLog(log).roster().map(a => a.agentId)).toEqual(['a1'])
  })

  it('re-reads the log on every call, so it cannot drift from it', () => {
    const log = freshLog()
    spawn(log, 'a1', 'scout')
    const agents = new AgentLog(log)
    expect(agents.get('a1')?.state).toBe('spawning')

    log.append({ kind: 'agent_attached', actor: 'scout', ref: 'a1' })
    expect(agents.get('a1')?.state).toBe('live')
  })

  it('survives a broker restart, because identity is a query not a buffer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-agents-'))
    dirs.push(dir)
    const file = path.join(dir, 'events.db')

    const first = new EventLog(file)
    spawn(first, 'a1', 'scout')
    first.append({ kind: 'agent_attached', actor: 'scout', ref: 'a1' })
    first.close()

    expect(new AgentLog(new EventLog(file)).get('a1')?.state).toBe('live')
  })
})
