import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { readLaunchPlan } from '../agents/launch-files.js'
import { readBudget } from '../agents/budget.js'
import { transcriptLine, projectSlug } from '../agents/transcript.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-100 — which Claude ACCOUNT a spawned agent spends.
 *
 * `run-agent` builds the child's environment from the BROKER's, and the broker is
 * a detached daemon autostarted by whichever session connected first. So every
 * agent inherited that session's `CLAUDE_CONFIG_DIR` — usually none — and four
 * agents spawned from a `workout` session wrote their transcripts under
 * `~/.claude/projects/` and then died on that account's spend limit.
 *
 * `config-dir.test.ts` pins the precedence rule in isolation. This file proves the
 * rule is actually WIRED: the resolved dir reaches the child's environment, lands
 * on the agent's own spawn row, and comes back out of the log for the readers that
 * go looking for a transcript or a budget.
 *
 * `HOME` is redirected rather than mocked because `os.homedir()` reads `$HOME`
 * first on POSIX — which is what lets the containment rule ("under the user's
 * home") be exercised without writing into the developer's real home.
 */

const tmpDirs: string[] = []
let core: BrokerCore
let supervisor: Supervisor
let stopAutoAttach: () => void
let realHome: string | undefined

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const fakeConn = (): Conn => ({}) as unknown as net.Socket

/** Launches nothing: a non-macOS platform refuses iTerm, and the spawn is stubbed. */
const liveChild = () => ({ pid: 4242, unref: () => undefined, once: () => undefined })

beforeEach(() => {
  realHome = process.env.HOME
  process.env.HOME = tmp('agent-chat-home-')
  const home = tmp('agent-chat-bus-')
  process.env.AGENT_CHAT_HOME = home
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  stopAutoAttach = autoAttach(core)
  supervisor = new Supervisor(core, { surface: { platform: 'linux', spawn: liveChild } })
})

afterEach(() => {
  stopAutoAttach()
  supervisor?.close()
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  delete process.env.AGENT_CHAT_HOME
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.AGENT_CHAT_ACTIVE_WORK_ROOT
  delete process.env.AGENT_CHAT_STATUS_CACHE
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** An existing config dir under the (redirected) home, which is what the rule requires. */
function account(name: string): string {
  const dir = path.join(process.env.HOME as string, '.claude-profiles', name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const spawnReq = (over: Record<string, unknown> = {}) => ({
  name: 'scout',
  profile: 'explorer',
  brief: 'read the log',
  requestedBy: 'human',
  cwd: tmp('agent-chat-ws-'),
  isolation: 'none' as const,
  surface: 'headless' as const,
  ...over,
})

const spawnRow = (agentId: string) =>
  core.events.agentEvents().find(row => row.kind === 'agent_spawned' && row.msgId === agentId)

describe('the account a spawn resolves', () => {
  it('forwards the spawner’s own dir into the child’s environment', async () => {
    const workout = account('workout')
    const result = await supervisor.spawn(spawnReq({ spawnerConfigDir: workout }))

    expect(result.ok).toBe(true)
    // `plan.env` and not the allowlisted copy of the broker's env: that copy is
    // exactly what carried the wrong account in the first place.
    expect(readLaunchPlan(result.agentId as string).env.CLAUDE_CONFIG_DIR).toBe(workout)
  })

  it('lets an explicit config_dir outrank the spawner', async () => {
    const result = await supervisor.spawn(
      spawnReq({ configDir: account('billing'), spawnerConfigDir: account('workout') }),
    )

    expect(readLaunchPlan(result.agentId as string).env.CLAUDE_CONFIG_DIR).toBe(account('billing'))
    expect(spawnRow(result.agentId as string)?.meta.config_dir_source).toBe('explicit')
  })

  /**
   * The explicit step is the one that refuses. Falling back would run the agent on
   * an account nobody asked for while reporting success — CC-100's failure with a
   * new cause.
   */
  it('refuses a config_dir outside the home rather than falling back to one', async () => {
    const result = await supervisor.spawn(spawnReq({ configDir: '/etc' }))

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('under your home directory')
    expect(core.events.agentEvents().some(row => row.kind === 'agent_spawned')).toBe(false)
    expect(core.events.history(10).some(row => row.kind === 'agent_spawn_refused')).toBe(true)
  })

  it('records the resolved dir on the agent’s own row, and reads it back off the log', async () => {
    const workout = account('workout')
    const result = await supervisor.spawn(spawnReq({ spawnerConfigDir: workout }))

    expect(spawnRow(result.agentId as string)?.meta.config_dir).toBe(workout)
    // The round trip that every later reader depends on: a different process asks
    // the log which account an agent is on, because its own env cannot tell it.
    expect(core.agents.get(result.agentId as string)?.configDir).toBe(workout)
  })

  it('falls back to the broker’s own dir when nothing else names one', async () => {
    process.env.CLAUDE_CONFIG_DIR = account('broker')
    const result = await supervisor.spawn(spawnReq())

    expect(readLaunchPlan(result.agentId as string).env.CLAUDE_CONFIG_DIR).toBe(account('broker'))
    expect(spawnRow(result.agentId as string)?.meta.config_dir_source).toBe('broker')
  })
})

describe('an active-work initiative that declares a profile', () => {
  /** A minimal initiative whose brief.md frontmatter names an account. */
  function initiative(slug: string, profile: string | undefined): void {
    const root = tmp('agent-chat-aw-')
    fs.mkdirSync(path.join(root, slug), { recursive: true })
    const frontmatter = ['---', 'title: Widgets', ...(profile ? [`profile: ${profile}`] : []), '---'].join(
      '\n',
    )
    fs.writeFileSync(path.join(root, slug, 'brief.md'), `${frontmatter}\n# Widgets\n\nWhy: to prove it.\n`)
    process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = root
  }

  it('runs the agent on that account when nobody closer named one', async () => {
    initiative('widgets', 'agents')
    const agents = account('agents')

    const result = await supervisor.spawn(spawnReq({ briefing: 'widgets' }))

    expect(readLaunchPlan(result.agentId as string).env.CLAUDE_CONFIG_DIR).toBe(agents)
    expect(spawnRow(result.agentId as string)?.meta.config_dir_source).toBe('profile')
  })

  it('does not outrank the spawner’s own account', async () => {
    initiative('widgets', 'agents')
    account('agents')
    const workout = account('workout')

    const result = await supervisor.spawn(spawnReq({ briefing: 'widgets', spawnerConfigDir: workout }))

    expect(readLaunchPlan(result.agentId as string).env.CLAUDE_CONFIG_DIR).toBe(workout)
  })

  it('warns in the spawn result when the declared profile dir does not exist', async () => {
    initiative('widgets', 'ghost')

    const result = await supervisor.spawn(spawnReq({ briefing: 'widgets' }))

    expect(result.ok).toBe(true)
    expect(result.warnings?.join('\n')).toContain('.claude-profiles/ghost')
    expect(result.warnings?.join('\n')).toContain('does not exist')
    // Spawned anyway, on the account that IS available: orientation and accounts
    // are both improvements to a spawn, never preconditions for one.
    expect(readLaunchPlan(result.agentId as string).env.CLAUDE_CONFIG_DIR).toBe(
      path.join(process.env.HOME as string, '.claude'),
    )
  })
})

describe('reading an agent’s telemetry back', () => {
  it('finds a transcript under the agent’s recorded dir, not the broker’s', async () => {
    const workout = account('workout')
    const cwd = tmp('agent-chat-ws-')
    const result = await supervisor.spawn(spawnReq({ cwd, spawnerConfigDir: workout }))
    const agent = core.agents.get(result.agentId as string)

    // Where Claude Code would write it, for an agent on that account.
    const projects = path.join(workout, 'projects', projectSlug(cwd))
    fs.mkdirSync(projects, { recursive: true })
    fs.writeFileSync(path.join(projects, `${agent?.sessionId}.jsonl`), '{}\n')

    expect(transcriptLine(cwd, agent?.sessionId as string, agent?.configDir)).not.toContain('not written yet')
    // The same lookup without the record is the bug: it reports "not written yet"
    // forever for an agent whose transcript is right there on disk.
    expect(transcriptLine(cwd, agent?.sessionId as string)).toContain('not written yet')
  })

  it('finds a budget reading under the agent’s recorded dir', async () => {
    const workout = account('workout')
    const result = await supervisor.spawn(spawnReq({ spawnerConfigDir: workout }))
    const agent = core.agents.get(result.agentId as string)
    const sessionId = agent?.sessionId as string

    const cache = path.join(workout, 'status-cache', 'sessions')
    fs.mkdirSync(cache, { recursive: true })
    fs.writeFileSync(
      path.join(cache, `${sessionId}.json`),
      JSON.stringify({ session_id: sessionId, written_at: Math.round(Date.now() / 1000) }),
    )

    expect(readBudget(sessionId, Date.now(), agent?.configDir).found).toBe(true)
    expect(readBudget(sessionId).found).toBe(false)
  })
})
