import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { observedPresence, type GitRunner } from '../git.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { ToolHandler } from '../server/tools.js'
import type { BrokerClient } from '../client/broker-client.js'
import { HUMAN, type ClientMessage, type ServerMessage, type SessionInfo } from '../protocol.js'

/**
 * CC-11 — structured session presence. Two classes of field, and the tests are
 * organised by the line that separates them: `observed` is derived from a
 * session's own process and `declared` is whatever its model typed, so what has
 * to hold is that a peer can always tell which it is reading, and that neither
 * can be used to flood everyone else's chat_list.
 *
 * Git is MOCKED throughout. A unit test that shells out to real git is a test of
 * whichever checkout it happens to be standing in, which is exactly the thing
 * this feature reports on and therefore the last thing it should depend on.
 */

/** A git that answers from a table, so a worktree layout is a fixture not a setup script. */
const fakeGit =
  (answers: Record<string, string | null>): GitRunner =>
  async args =>
    answers[args.join(' ')] ?? null

const BRANCH = 'rev-parse --abbrev-ref HEAD'
const TOPLEVEL = 'rev-parse --show-toplevel'
const COMMON = 'rev-parse --path-format=absolute --git-common-dir'
const GITDIR = 'rev-parse --path-format=absolute --git-dir'

describe('observedPresence — derived, never asked of the model', () => {
  it('reads branch and checkout in a main working tree', async () => {
    const git = fakeGit({
      [BRANCH]: 'feat/cc11',
      [TOPLEVEL]: '/repo',
      [COMMON]: '/repo/.git',
      [GITDIR]: '/repo/.git',
    })

    expect(await observedPresence('/repo', git)).toEqual({
      gitBranch: 'feat/cc11',
      worktreePath: '/repo',
      isLinkedWorktree: false,
    })
  })

  /**
   * The case a shared-cwd check cannot see: two sessions on one repository doing
   * genuinely independent work. The common dir points back at the main
   * repository while the git dir is under `.git/worktrees/`, and that
   * disagreement IS the definition of a linked worktree.
   */
  it('marks a linked worktree, where the common dir and the git dir disagree', async () => {
    const git = fakeGit({
      [BRANCH]: 'agent-chat/scout',
      [TOPLEVEL]: '/repo/.worktrees/scout',
      [COMMON]: '/repo/.git',
      [GITDIR]: '/repo/.git/worktrees/scout',
    })

    const observed = await observedPresence('/repo/.worktrees/scout', git)

    expect(observed).toMatchObject({ worktreePath: '/repo/.worktrees/scout', isLinkedWorktree: true })
  })

  it('omits the branch on a detached HEAD rather than reporting the string "HEAD"', async () => {
    const git = fakeGit({
      [BRANCH]: 'HEAD',
      [TOPLEVEL]: '/repo',
      [COMMON]: '/repo/.git',
      [GITDIR]: '/repo/.git',
    })

    const observed = await observedPresence('/repo', git)

    expect(observed?.gitBranch).toBeUndefined()
    expect(observed?.worktreePath).toBe('/repo')
  })

  it('reports nothing at all outside a repository, so `observed` stays absent', async () => {
    expect(await observedPresence('/tmp', fakeGit({}))).toBeUndefined()
  })
})

/** Captures the frame a tool handler put on the wire, which is what is under test. */
function recordingBroker(reply: ServerMessage): { broker: BrokerClient; sent: ClientMessage[] } {
  const sent: ClientMessage[] = []
  const broker = {
    request: async (message: ClientMessage) => {
      sent.push(message)
      return reply
    },
  } as unknown as BrokerClient
  return { broker, sent }
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]!.text

describe('declared — validated at the tool boundary, because it is model-supplied', () => {
  const ok: ServerMessage = { t: 'register_result', ok: true }

  it('carries a well-formed bag through to the register frame', async () => {
    const { broker, sent } = recordingBroker(ok)
    const handler = new ToolHandler(broker)

    await handler.handle('chat_register', {
      name: 'cc-relay',
      working_on: 'narrowing broadcast fanout',
      declared: { role: 'implementer', initiative: 'claude-channels', task: 'CC-11' },
    })

    expect(sent[0]).toMatchObject({
      t: 'register',
      declared: { role: 'implementer', initiative: 'claude-channels', task: 'CC-11' },
    })
  })

  /**
   * CC-8's lesson applied to an open bag: model-supplied structure is narrowed,
   * never cast. A nested object would otherwise render as "[object Object]" in
   * every peer's chat_list, which reads as a fact rather than as a bad claim.
   */
  it('refuses a non-string value', async () => {
    const handler = new ToolHandler(recordingBroker(ok).broker)

    await expect(
      handler.handle('chat_register', { name: 'cc-relay', declared: { role: { deep: 'no' } } }),
    ).rejects.toThrow(/declared.role must be a string/)
  })

  it('refuses an array, which is not a bag of labels', async () => {
    const handler = new ToolHandler(recordingBroker(ok).broker)

    await expect(
      handler.handle('chat_register', { name: 'cc-relay', declared: ['role', 'implementer'] }),
    ).rejects.toThrow(/must be an object/)
  })

  it('refuses too many keys', async () => {
    const handler = new ToolHandler(recordingBroker(ok).broker)
    const declared = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 'v']))

    await expect(handler.handle('chat_register', { name: 'cc-relay', declared })).rejects.toThrow(
      /at most 8 keys/,
    )
  })

  it('refuses a value longer than the per-value cap', async () => {
    const handler = new ToolHandler(recordingBroker(ok).broker)

    await expect(
      handler.handle('chat_register', { name: 'cc-relay', declared: { note: 'x'.repeat(200) } }),
    ).rejects.toThrow(/at most 64 characters/)
  })

  /**
   * Eight keys can each be under the per-value cap and still add up to a
   * paragraph in everyone else's context, which is why the total is its own
   * budget rather than an inference from the other two.
   */
  it('refuses a bag that is over the total size budget despite legal keys and values', async () => {
    const handler = new ToolHandler(recordingBroker(ok).broker)
    const declared = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`key${i}`, 'x'.repeat(64)]))

    await expect(handler.handle('chat_register', { name: 'cc-relay', declared })).rejects.toThrow(
      /over the 512-byte budget/,
    )
  })

  it('lets chat_status re-declare without re-registering', async () => {
    const { broker, sent } = recordingBroker({ t: 'status_result', ok: true })
    const handler = new ToolHandler(broker)

    await handler.handle('chat_status', { status: 'working', declared: { task: 'CC-13' } })

    expect(sent[0]).toMatchObject({ t: 'status', status: 'working', declared: { task: 'CC-13' } })
  })
})

describe('the registry clamps declared, because a raw socket client passes no tool', () => {
  const fakeConn = (): Conn => ({}) as unknown as net.Socket

  it('drops non-string values, extra keys and over-long text rather than storing them', () => {
    const registry = new Registry<Conn>()
    const declared = {
      role: 'implementer',
      note: 'x'.repeat(500),
      bad: 42 as unknown as string,
      ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'v'])),
    }

    registry.register(fakeConn(), { name: 'raw', workingOn: 'w', cwd: '/repo', pid: 1, declared })

    const stored = registry.list()[0]?.declared ?? {}
    expect(Object.keys(stored).length).toBeLessThanOrEqual(8)
    expect(stored.bad).toBeUndefined()
    expect(stored.note?.length ?? 0).toBeLessThanOrEqual(64)
  })

  it('re-declares presence on register and carries it when a re-register omits it', () => {
    const registry = new Registry<Conn>()
    const conn = fakeConn()
    const base = { name: 'cc-relay', workingOn: 'w', cwd: '/repo', pid: 1 }

    registry.register(conn, { ...base, declared: { task: 'CC-11' }, observed: { gitBranch: 'main' } })
    registry.register(conn, base)

    expect(registry.list()[0]).toMatchObject({ declared: { task: 'CC-11' }, observed: { gitBranch: 'main' } })
  })

  it('replaces rather than merges on chat_status, so a claim can be retracted', () => {
    const registry = new Registry<Conn>()
    const conn = fakeConn()

    registry.register(conn, {
      name: 'cc-relay',
      workingOn: 'w',
      cwd: '/repo',
      pid: 1,
      declared: { task: 'CC-11', role: 'implementer' },
    })
    registry.setStatus(conn, 'working', undefined, undefined, { task: 'CC-13' })

    expect(registry.list()[0]?.declared).toEqual({ task: 'CC-13' })
  })
})

describe('chat_list rendering keeps a fact and a claim visually apart', () => {
  const session = (over: Partial<SessionInfo>): SessionInfo => ({
    name: 'cc-relay',
    workingOn: 'narrowing broadcast fanout',
    cwd: '/repo',
    status: 'working',
    dnd: false,
    idleMs: 12_000,
    registeredAt: 0,
    ...over,
  })

  const render = async (sessions: SessionInfo[]): Promise<string> => {
    const handler = new ToolHandler(recordingBroker({ t: 'list_result', sessions }).broker)
    return textOf(await handler.handle('chat_list', {}))
  }

  it('marks declared labels as self-reported and renders observed facts unmarked', async () => {
    const out = await render([
      session({
        declared: { role: 'implementer', initiative: 'claude-channels' },
        observed: { gitBranch: 'main', worktreePath: '/repo', isLinkedWorktree: false },
      }),
    ])

    expect(out).toContain('declared: role=implementer, initiative=claude-channels   (self-reported)')
    expect(out).toContain('/repo  ·  main  ·  main checkout')
    // The marker belongs to the claim only: a branch is not self-reported, and
    // labelling it so would teach a reader to discount the one line it can trust.
    expect(out.split('\n').find(line => line.includes('main checkout'))).not.toContain('self-reported')
  })

  it('distinguishes two sessions on the same initiative by what can be observed', async () => {
    const out = await render([
      session({
        name: 'cc-relay',
        declared: { task: 'CC-11' },
        observed: { gitBranch: 'feat/cc11', worktreePath: '/repo', isLinkedWorktree: false },
      }),
      session({
        name: 'cc-scout',
        declared: { task: 'CC-13' },
        observed: {
          gitBranch: 'agent-chat/scout',
          worktreePath: '/repo/.worktrees/scout',
          isLinkedWorktree: true,
        },
      }),
    ])

    expect(out).toContain('task=CC-11')
    expect(out).toContain('task=CC-13')
    expect(out).toContain('linked worktree')
    expect(out).toContain('main checkout')
  })

  it('renders a session that declared nothing exactly as it did before CC-11', async () => {
    const out = await render([session({})])

    expect(out).not.toContain('declared:')
    expect(out).toContain('- cc-relay [working, idle 12s] — narrowing broadcast fanout\n    /repo')
  })
})

describe('the CC-9 notice, extended to a shared worktree', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  function makeCore(): BrokerCore {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-presence-'))
    tmpDirs.push(dir)
    return new BrokerCore(() => undefined, {
      events: new EventLog(path.join(dir, 'events.db')),
      registry: new Registry<Conn>(),
    })
  }

  const fakeConn = (): Conn => ({}) as unknown as net.Socket

  const notices = (core: BrokerCore) => core.events.history(10).filter(row => row.kind === 'notice')

  /**
   * The gap CC-9 could not close: two sessions in one checkout that described
   * their work differently collided on files just as hard, and the text
   * comparison saw nothing at all.
   */
  it('fires on a shared worktree even when the workingOn text differs', () => {
    const core = makeCore()
    const observed = { worktreePath: '/repo', gitBranch: 'main', isLinkedWorktree: false }
    core.register(fakeConn(), {
      t: 'register',
      name: 'alpha',
      workingOn: 'fixing CC-11',
      cwd: '/repo/src',
      pid: 1,
      observed,
    })
    core.register(fakeConn(), {
      t: 'register',
      name: 'beta',
      workingOn: 'reviewing the docs',
      cwd: '/repo/docs',
      pid: 2,
      observed,
    })

    const notice = notices(core)[0]
    expect(notice).toMatchObject({ from: 'agent-chat', meta: { target: HUMAN } })
    expect(notice!.text).toContain('beta')
    expect(notice!.text).toContain('alpha')
    expect(notice!.text).toContain('/repo')
    expect(notice!.text).toContain('branch main')
  })

  it('stays quiet when each session has a worktree of its own', () => {
    const core = makeCore()
    core.register(fakeConn(), {
      t: 'register',
      name: 'alpha',
      workingOn: 'fixing CC-11',
      cwd: '/repo',
      pid: 1,
      observed: { worktreePath: '/repo', isLinkedWorktree: false },
    })
    core.register(fakeConn(), {
      t: 'register',
      name: 'beta',
      workingOn: 'reviewing the docs',
      cwd: '/repo/.worktrees/beta',
      pid: 2,
      observed: { worktreePath: '/repo/.worktrees/beta', isLinkedWorktree: true },
    })

    expect(notices(core)).toHaveLength(0)
  })

  it('names a session once when both halves of the check fire', () => {
    const core = makeCore()
    const observed = { worktreePath: '/repo' }
    core.register(fakeConn(), {
      t: 'register',
      name: 'alpha',
      workingOn: 'fixing CC-11',
      cwd: '/repo',
      pid: 1,
      observed,
    })
    core.register(fakeConn(), {
      t: 'register',
      name: 'beta',
      workingOn: 'fixing CC-11',
      cwd: '/repo',
      pid: 2,
      observed,
    })

    const notice = notices(core)[0]
    expect(notices(core)).toHaveLength(1)
    expect(notice!.text.match(/alpha/g)).toHaveLength(1)
  })
})
