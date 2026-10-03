import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import {
  appendixFacts,
  declaredQueueFile,
  renderAppendix,
  reportsSinceWrap,
} from '../agents/teleport-appendix.js'

/** CC-524: the broker's own section of a teleport successor's first turn. Every name and path is synthetic. */

const SESSION = '11111111-2222-4333-8444-555555555555'

let dir: string
let root: string
let activeWork: string
let core: BrokerCore

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-appendix-'))
  root = path.join(dir, 'autonomy')
  activeWork = path.join(dir, 'active-work')
  fs.mkdirSync(path.join(root, 'seats'), { recursive: true })
  process.env.AGENT_CHAT_HOME = dir
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

/** A spawn row as the supervisor writes one, then the rows that move it to `state`. */
function spawned(spawner: string, name: string, state: 'live' | 'exited' | 'retired' | 'spawning'): void {
  const { msgId } = core.append({
    kind: 'agent_spawned',
    actor: spawner,
    target: name,
    body: 'a brief',
    meta: { name, profile: 'implementer' },
  })
  if (state === 'spawning') return
  core.append({ kind: 'agent_attached', actor: name, ref: msgId })
  if (state === 'exited') core.append({ kind: 'agent_exited', actor: name, ref: msgId })
  if (state === 'retired')
    core.append({ kind: 'agent_retired', actor: 'agent-chat', target: name, ref: msgId })
}

const facts = (name = 'lead', since = 0) =>
  appendixFacts(core.agents, core.events, {
    name,
    since,
    sessionId: SESSION,
    autonomyRoot: root,
    activeWorkRoot: activeWork,
  })

const fakeConn = (): Conn => ({}) as unknown as net.Socket

describe('the agents a predecessor left behind', () => {
  it('lists the running ones it spawned with profile and state', () => {
    spawned('lead', 'lead-a', 'live')
    spawned('lead', 'lead-b', 'spawning')
    spawned('someone-else', 'other-a', 'live')

    const text = renderAppendix(facts())

    expect(text).toContain('Agents spawned by lead that are still running (2):')
    expect(text).toContain('- lead-a (profile implementer, live)')
    expect(text).toContain('- lead-b (profile implementer, spawning)')
    expect(text).not.toContain('other-a')
  })

  it('leaves out retired agents and counts the exited ones nobody retired', () => {
    spawned('lead', 'lead-done', 'exited')
    spawned('lead', 'lead-gone', 'retired')

    const text = renderAppendix(facts())

    expect(text).toContain('Agents spawned by lead that are still running: none.')
    expect(text).toContain('1 more exited and are not retired')
    expect(text).not.toContain('lead-gone')
    expect(text).not.toContain('lead-done')
  })

  it('does not list the name’s own earlier generation as an agent it spawned', () => {
    spawned('lead', 'lead', 'live')

    expect(facts().running).toEqual([])
  })
})

describe('the inbox and the human queue', () => {
  it('counts what arrived since the session began, and says nothing tracks what was read', () => {
    core.append({ kind: 'message', actor: 'lead-a', target: 'lead', body: 'Status: DONE' })
    core.append({ kind: 'message', actor: 'lead-b', target: 'lead', body: 'Status: BLOCKED' })
    core.append({ kind: 'message', actor: 'lead-a', target: 'someone-else', body: 'hello' })

    const text = renderAppendix(facts())

    expect(text).toContain('Inbox: 2 message(s) arrived for lead')
    expect(text).toContain('chat_inbox')
  })

  it('counts nothing that arrived before the session began', () => {
    core.append({ kind: 'message', actor: 'lead-a', target: 'lead', body: 'old news' })

    const text = renderAppendix(facts('lead', Date.now() + 60_000))

    expect(text).toContain('Inbox: no message arrived for lead')
  })

  it('lists an open chat_ask question by id, and drops it once answered', () => {
    const conn = fakeConn()
    core.register(conn, { t: 'register', name: 'lead', workingOn: 'w', cwd: dir, pid: 1 })
    const { msgId } = core.append({
      kind: 'question',
      actor: 'lead',
      target: 'human',
      body: 'Merge the\nrelease now?',
    })

    expect(renderAppendix(facts())).toContain(`- ${msgId}: Merge the release now?`)

    core.append({ kind: 'answer', actor: 'human', target: 'lead', ref: msgId, body: 'yes' })
    expect(renderAppendix(facts())).toContain('Open chat_ask questions: none.')
  })
})

describe('the queue file', () => {
  const writeSeat = (name: string, frontmatter: string): void =>
    fs.writeFileSync(path.join(root, 'seats', `${name}.md`), `---\n${frontmatter}\n---\nprose\n`)

  it('is the path the seat file declares, resolved against the autonomy root', () => {
    writeSeat('lead', 'prefix: ld\npool: p\nqueue: queues/lead.md')

    expect(declaredQueueFile('lead', root)).toBe(path.join(root, 'queues', 'lead.md'))
    expect(renderAppendix(facts())).toContain(`Queue file: ${path.join(root, 'queues', 'lead.md')}`)
  })

  it('is absent for a seat that declares none, and for a name with no seat file', () => {
    writeSeat('lead', 'prefix: ld\npool: p')

    expect(declaredQueueFile('lead', root)).toBeUndefined()
    expect(declaredQueueFile('nobody', root)).toBeUndefined()
    expect(renderAppendix(facts())).not.toContain('Queue file')
  })

  it('never reads a path built from a name that is not a plain slug', () => {
    writeSeat('lead', 'prefix: ld\npool: p\nqueue: queues/lead.md')

    expect(declaredQueueFile('../seats/lead', root)).toBeUndefined()
  })
})

describe('agent reports after the last wrap', () => {
  /** A session record as `active-work wrap` names one, last written `agoMs` before now. */
  function wrapped(agoMs: number, sessionId = SESSION): number {
    const sessions = path.join(activeWork, 'init-a', 'sessions')
    fs.mkdirSync(sessions, { recursive: true })
    fs.writeFileSync(path.join(activeWork, 'init-a', 'brief.md'), '# init-a\n')
    const file = path.join(sessions, `2026-01-01-0000-${sessionId}.md`)
    fs.writeFileSync(file, 'what the session knew\n')
    const at = new Date(Date.now() - agoMs)
    fs.utimesSync(file, at, at)
    return at.getTime()
  }

  const gap = () =>
    reportsSinceWrap(core.agents, core.events, {
      name: 'lead',
      sessionId: SESSION,
      activeWorkRoot: activeWork,
    })

  it('counts a spawned agent’s report that arrived after the wrap', () => {
    spawned('lead', 'lead-a', 'live')
    const wrapAt = wrapped(60_000)
    core.append({ kind: 'message', actor: 'lead-a', target: 'lead', body: 'Status: DONE' })

    expect(gap()).toEqual({ wrapAt, reports: 1 })
    expect(renderAppendix(facts())).toContain(
      `Wrap: 1 agent report(s) arrived after your predecessor's last active-work wrap (${new Date(wrapAt).toISOString()})`,
    )
  })

  it('counts nothing when the wrap is newer than every report', () => {
    spawned('lead', 'lead-a', 'live')
    core.append({ kind: 'message', actor: 'lead-a', target: 'lead', body: 'Status: DONE' })
    wrapped(-60_000)

    expect(gap()).toBeUndefined()
    expect(renderAppendix(facts())).not.toContain('Wrap:')
  })

  it('does not count a message from a peer the name did not spawn', () => {
    spawned('someone-else', 'other-a', 'live')
    wrapped(60_000)
    core.append({ kind: 'message', actor: 'other-a', target: 'lead', body: 'hello' })

    expect(gap()).toBeUndefined()
  })

  it('still counts a report from an agent that has since been retired', () => {
    spawned('lead', 'lead-gone', 'retired')
    wrapped(60_000)
    core.append({ kind: 'message', actor: 'lead-gone', target: 'lead', body: 'Status: DONE' })

    expect(gap()?.reports).toBe(1)
  })

  it('says nothing for a session that never wrapped', () => {
    spawned('lead', 'lead-a', 'live')
    wrapped(60_000, '99999999-0000-4000-8000-000000000000')
    core.append({ kind: 'message', actor: 'lead-a', target: 'lead', body: 'Status: DONE' })

    expect(gap()).toBeUndefined()
  })
})

describe('the section itself', () => {
  it('says the broker wrote it, not the predecessor', () => {
    const text = renderAppendix(facts())

    expect(text.startsWith('---\n\n## Broker appendix')).toBe(true)
    expect(text).toContain('Your predecessor did not write this section.')
  })
})
