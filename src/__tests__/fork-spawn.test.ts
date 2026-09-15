import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { autoAttach } from './broker-harness.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { readLaunchPlan } from '../agents/launch-files.js'
import { projectSlug } from '../agents/transcript.js'
import type { SpawnFn } from '../agents/surfaces/options.js'

/**
 * CC-44 at the SPAWN PATH: who may fork, and what argv a fork produces.
 *
 * What this file does NOT prove, and cannot: that the child actually inherits
 * the conversation. `--fork-session` appearing in an argv is a claim about a
 * flag, not about Claude Code's behaviour — exactly the kind of assertion that
 * passed on the broken code in `live-toolset.test.ts`. The inheritance itself is
 * proved in `live-fork.test.ts`, against a real `claude`.
 *
 * What is worth proving here is the refusal, because the refusal is the security
 * property: a fork hands a whole conversation to a new process, so a request to
 * fork anyone but yourself must be turned down rather than quietly aimed at your
 * own transcript.
 */

const tmpDirs: string[] = []
let core: BrokerCore
let supervisor: Supervisor
let stopAutoAttach: () => void

/** Launches nothing: these tests are about the plan, not about starting claude. */
const noLaunch: SpawnFn = () => ({ pid: 4242, unref: () => undefined, once: () => undefined })

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function makeCore(): BrokerCore {
  const dir = tmpDir('agent-chat-fork-')
  process.env.AGENT_CHAT_HOME = dir
  return new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
}

const fakeConn = (): Conn => ({}) as unknown as net.Socket

/** A transcript where Claude Code would really have written one, for `cwd`. */
function writeTranscript(cwd: string, sessionId: string): string {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR as string, 'projects', projectSlug(cwd))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${sessionId}.jsonl`)
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user' } })}\n`)
  return file
}

let sessions = 0

/** A registered session with a Claude Code session id — the only thing that can fork. */
function session(name: string): { cwd: string; sessionId: string } {
  const cwd = tmpDir('agent-chat-ws-')
  const id = `11111111-1111-4111-8111-${String(++sessions).padStart(12, '0')}`
  core.register(fakeConn(), { t: 'register', name, workingOn: '', cwd, pid: 1, sessionId: id })
  return { cwd, sessionId: id }
}

const spawnReq = (over: Record<string, unknown> = {}) => ({
  name: 'twin',
  profile: 'explorer',
  brief: 'carry on from where I am',
  requestedBy: 'coordinator',
  isolation: 'none' as const,
  surface: 'headless' as const,
  ...over,
})

beforeEach(() => {
  core = makeCore()
  process.env.CLAUDE_CONFIG_DIR = tmpDir('agent-chat-cfg-')
  // `noLaunch` starts a child that never registers, and a spawn is not reported
  // until one does (CC-95). Without the stand-in registration every `ok` below
  // waits out the full attach window.
  stopAutoAttach = autoAttach(core)
  supervisor = new Supervisor(core, { surface: { platform: 'linux', spawn: noLaunch } })
})

afterEach(() => {
  stopAutoAttach()
  supervisor?.close()
  delete process.env.AGENT_CHAT_HOME
  delete process.env.CLAUDE_CONFIG_DIR
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * By agent id, because registering a session ADOPTS it — every `session()` call
 * writes an `agent_spawned` row of its own, and matching on kind alone finds the
 * requester's adoption rather than the spawn under test.
 */
const spawnRow = (agentId: string) =>
  core.events.agentEvents().find(r => r.kind === 'agent_spawned' && r.msgId === agentId)

/**
 * From `history`, not `agentEvents`: a refusal never creates an identity, so the
 * agent read model deliberately does not fold it (see `event-log.ts`).
 */
const refusals = (): string[] =>
  core.events
    .history(50)
    .filter(r => r.kind === 'agent_spawn_refused')
    .map(r => r.text)

describe('a session forking itself', () => {
  it('mints a new conversation from its own transcript, leaving the original alone', async () => {
    const me = session('coordinator')
    const transcript = writeTranscript(me.cwd, me.sessionId)

    const result = await supervisor.spawn(spawnReq({ cwd: me.cwd, inherit: 'context' }))

    expect(result.reason).toBeUndefined()
    const args = readLaunchPlan(result.agentId as string).args
    // All three, in one argv: a NEW id to write under, the parent's transcript as
    // a path (which is what lets the child live in another cwd), and the flag
    // that makes the second a copy rather than a reattachment.
    expect(args).toContain('--fork-session')
    expect(args[args.indexOf('--resume') + 1]).toBe(transcript)
    expect(args[args.indexOf('--session-id') + 1]).not.toBe(me.sessionId)

    const row = spawnRow(result.agentId as string)
    expect(row?.meta.inherit).toBe('context')
    expect(row?.meta.fork_from).toBe(me.sessionId)
  })

  it('starts empty when nothing asked to inherit — the control for the argv above', async () => {
    const me = session('coordinator')
    writeTranscript(me.cwd, me.sessionId)

    const result = await supervisor.spawn(spawnReq({ cwd: me.cwd }))

    const args = readLaunchPlan(result.agentId as string).args
    expect(args).not.toContain('--fork-session')
    expect(args).not.toContain('--resume')
    expect(spawnRow(result.agentId as string)?.meta.inherit).toBeUndefined()
  })
})

describe('a fork aimed at someone else', () => {
  it('is refused by session id, rather than quietly redirected to your own', async () => {
    const me = session('coordinator')
    const peer = session('peer')
    writeTranscript(me.cwd, me.sessionId)
    writeTranscript(peer.cwd, peer.sessionId)

    const result = await supervisor.spawn(
      spawnReq({ cwd: me.cwd, inherit: 'context', forkFrom: peer.sessionId }),
    )

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/it is not yours/)
    // The refusal, not a spawn: the tempting failure mode is falling back to the
    // requester's own transcript, which would report success for the wrong thing.
    expect(core.events.agentEvents().some(r => r.kind === 'agent_spawned' && r.target === 'twin')).toBe(false)
    expect(refusals().join(' ')).toMatch(peer.sessionId)
  })

  it('refuses a requester with no conversation of its own, the human at the CLI included', async () => {
    const dir = tmpDir('agent-chat-ws-')

    const result = await supervisor.spawn(spawnReq({ requestedBy: 'human', cwd: dir, inherit: 'context' }))

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no Claude Code session id for you/)
  })

  it('refuses when the requester has not written a transcript yet', async () => {
    const me = session('coordinator')

    const result = await supervisor.spawn(spawnReq({ cwd: me.cwd, inherit: 'context' }))

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/nothing to inherit/)
  })
})
