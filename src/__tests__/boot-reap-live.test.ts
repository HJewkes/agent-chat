import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type net from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conn } from '../broker/core.js'
import type { SessionRecord } from '../agents/claude-sessions.js'
import type { ProcessProbe } from '../agents/detached-reap.js'
import { readRuntimeState, runtimeStatePath, writeRuntimeState } from '../agents/launch-files.js'
import { worktreeStrategy } from '../agents/isolation/worktree.js'
import { gather } from '../agents/ledger/verifier.js'
import { classify } from '../agents/ledger/verify.js'
import { transcriptPath } from '../agents/transcript.js'
import { startSupervisor, type RestartHarness } from './helpers/restart-harness.js'

/**
 * CC-489: a broker that dies writes no `agent_detached` for its open connections, so a
 * session that died with it stayed `live` forever: resume refused it and only retire,
 * which drops the tree, got it off the roster. A broker start now probes those rows
 * as it probes detached ones. The harness's stand-in child has pid 4242.
 */

const PID = 4242
const SETTLE_MS = 1000
const SESSION = '00000000-0000-4000-8000-0000000000aa'
const otherSession: SessionRecord = { pid: 6161, sessionId: '00000000-0000-4000-8000-0000000000bb' }

let h: RestartHarness
let alive: Set<number>
let argvOf: (pid: number) => string | undefined
let records: SessionRecord[]
let recordReads = 0
const tmpDirs: string[] = []

const probe: ProcessProbe = {
  isAlive: pid => alive.has(pid),
  readArgv: pid => argvOf(pid),
  sessionRecords: () => {
    recordReads += 1
    return records
  },
}

const fakeConn = (): Conn => ({}) as unknown as net.Socket
const exitsOf = (agentId: string): { body: string | null; meta: Record<string, string> }[] =>
  h.core.events.agentEvents().filter(row => row.kind === 'agent_exited' && row.ref === agentId)
const stateOf = (agentId: string): string | undefined => h.core.agents.get(agentId)?.state

function tmpDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

beforeEach(() => {
  alive = new Set()
  argvOf = () => undefined
  records = []
  recordReads = 0
  vi.stubEnv('CLAUDE_CONFIG_DIR', tmpDir('boot-reap-claude-'))
})

afterEach(() => {
  h?.close()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A headless agent, attached, that the old broker never saw detach. */
async function liveHeadless(name = 'scout'): Promise<string> {
  h = startSupervisor({ slots: 5, settleMs: SETTLE_MS, processProbe: probe })
  expect((await h.spawnAgent(name)).ok).toBe(true)
  const agentId = h.core.agents.byName(name)?.agentId ?? ''
  expect(stateOf(agentId)).toBe('live')
  return agentId
}

/** An adopted session row: no runtime.json, so only Claude Code's session records speak for it. */
function adoptLive(name: string, sessionId = SESSION): string {
  const agentId = h.core.append({
    kind: 'agent_spawned',
    actor: 'human',
    target: name,
    meta: { origin: 'adopted', name, cwd: '/tmp/synthetic', session_id: sessionId, depth: '0' },
  }).msgId
  h.core.append({ kind: 'agent_attached', actor: name, ref: agentId })
  return agentId
}

function liveAdopted(): string {
  vi.useFakeTimers()
  h = startSupervisor({ slots: 5, settleMs: SETTLE_MS, processProbe: probe })
  return adoptLive('desk')
}

function writeTranscriptFor(agentId: string): void {
  const agent = h.core.agents.get(agentId)
  if (agent === undefined) throw new Error('no identity to write a transcript for')
  const file = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{}\n')
}

function makeRepo(): string {
  const dir = tmpDir('boot-reap-repo-')
  const git = (args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git(['init', '-b', 'main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])
  git(['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n')
  git(['add', '.'])
  git(['commit', '-m', 'seed'])
  return dir
}

async function ledgerOnlyDetached(agentId: string, bootAt: number): Promise<boolean> {
  const db = new DatabaseSync(path.join(h.home, 'events.db'), { readOnly: true })
  try {
    const broker = { liveIds: () => h.supervisor.liveIds(), slotIds: () => h.supervisor.slotIds(), bootAt }
    const { input } = await gather({ db, events: h.core.events, broker, list: () => Promise.resolve(null) })
    const executions = new Set(
      input.ledgerActive.filter(row => row.agentId === agentId).map(r => r.executionId),
    )
    return classify(input).some(item => item.class === 'ledger_only_detached' && executions.has(item.id))
  } finally {
    db.close()
  }
}

describe('a broker start over a live row whose launcher pid is recorded', () => {
  it('marks a headless agent the old broker left live exited when its run-agent is gone', async () => {
    const agentId = await liveHeadless()

    h.restart()

    const [exit] = exitsOf(agentId)
    expect(exitsOf(agentId)).toHaveLength(1)
    expect(exit?.meta).toMatchObject({ inferred: 'true', pid: String(PID) })
    expect(exit?.body).toMatch(/at broker start.*launcher pid 4242 is gone/)
    expect(stateOf(agentId)).toBe('exited')
  })

  it('marks a live row exited when its recorded pid now runs another program', async () => {
    const agentId = await liveHeadless()
    alive.add(PID)
    argvOf = () => '/usr/libexec/audiomxd'

    h.restart()

    expect(exitsOf(agentId)[0]?.body).toMatch(/pid 4242 was reused by another process/)
    expect(stateOf(agentId)).toBe('exited')
  })

  it('leaves a live row live while its run-agent still runs', async () => {
    const agentId = await liveHeadless()
    alive.add(PID)
    argvOf = () => `/usr/bin/node /opt/agent-chat/dist/cli.js run-agent ${agentId}`

    h.restart()

    expect(exitsOf(agentId)).toHaveLength(0)
    expect(stateOf(agentId)).toBe('live')
  })

  it('leaves a live row live when the recorded pid is alive and its argv is unreadable', async () => {
    const agentId = await liveHeadless()
    alive.add(PID)

    h.restart()

    expect(exitsOf(agentId)).toHaveLength(0)
    expect(stateOf(agentId)).toBe('live')
  })

  it('marks a spawning row from the old broker exited when its process is gone', async () => {
    const agentId = await liveHeadless()
    h.core.append({ kind: 'agent_resumed', actor: 'scout', ref: agentId })
    expect(stateOf(agentId)).toBe('spawning')

    h.restart()

    expect(exitsOf(agentId)).toHaveLength(1)
    expect(stateOf(agentId)).toBe('exited')
  })
})

describe('a broker start over a live row with no launcher pid', () => {
  it('waits one settle window, then marks it exited when no session holds it', () => {
    const agentId = liveAdopted()
    records = [otherSession]

    h.restart()
    vi.advanceTimersByTime(SETTLE_MS - 1)
    expect(exitsOf(agentId)).toHaveLength(0)
    vi.advanceTimersByTime(1)

    expect(exitsOf(agentId)).toHaveLength(1)
    expect(exitsOf(agentId)[0]?.body).toMatch(/no running Claude Code process holds session/)
    expect(stateOf(agentId)).toBe('exited')
  })

  it('spares a row that reconnects inside the settle window', () => {
    const agentId = liveAdopted()
    records = [otherSession]

    h.restart()
    vi.advanceTimersByTime(SETTLE_MS / 2)
    h.core.append({ kind: 'agent_attached', actor: 'desk', ref: agentId })
    vi.advanceTimersByTime(SETTLE_MS * 2)

    expect(exitsOf(agentId)).toHaveLength(0)
    expect(stateOf(agentId)).toBe('live')
  })

  it('leaves it alone when no session records can be read', () => {
    const agentId = liveAdopted()

    h.restart()
    vi.advanceTimersByTime(SETTLE_MS * 2)

    expect(
      h.core.events
        .agentEvents()
        .filter(row => row.ref === agentId)
        .map(row => row.kind),
    ).toEqual(['agent_attached'])
    expect(stateOf(agentId)).toBe('live')
  })

  it('leaves it alone while a Claude Code process still holds its session', () => {
    const agentId = liveAdopted()
    records = [{ pid: 5151, sessionId: SESSION }]
    alive.add(5151)
    argvOf = () => '/usr/local/bin/claude --resume x'

    h.restart()
    vi.advanceTimersByTime(SETTLE_MS * 2)

    expect(exitsOf(agentId)).toHaveLength(0)
    expect(stateOf(agentId)).toBe('live')
  })

  it('spares a row whose name holds a connection when its probe runs', () => {
    const agentId = liveAdopted()
    records = [otherSession]

    h.restart()
    h.core.registry.register(fakeConn(), { name: 'desk', workingOn: '', cwd: '/tmp', pid: 1 })
    vi.advanceTimersByTime(SETTLE_MS * 2)

    expect(exitsOf(agentId)).toHaveLength(0)
    expect(stateOf(agentId)).toBe('live')
  })

  it('drains a boot backlog of live rows in batches', () => {
    vi.useFakeTimers()
    h = startSupervisor({ slots: 5, settleMs: SETTLE_MS, processProbe: probe })
    const ids = Array.from({ length: 300 }, (_, i) => adoptLive(`gone-${i}`, `session-${i}`))
    records = [otherSession]

    h.restart()
    recordReads = 0
    vi.advanceTimersByTime(SETTLE_MS * 20)

    expect(ids.filter(id => stateOf(id) === 'exited')).toHaveLength(300)
    expect(recordReads).toBeLessThanOrEqual(Math.ceil(300 / 25) + 1)
  })
})

describe('after a boot reap', () => {
  it('closes the shadow ledger row, so doctor no longer reports ledger_only_detached', async () => {
    const agentId = await liveHeadless()
    alive.add(PID)
    h.restart()
    const bootAt = Date.now()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(await ledgerOnlyDetached(agentId, bootAt)).toBe(true)

    alive.clear()
    h.restart()
    await new Promise(resolve => setTimeout(resolve, 5))

    expect(stateOf(agentId)).toBe('exited')
    expect(await ledgerOnlyDetached(agentId, bootAt)).toBe(false)
  })

  it('keeps the dirty worktree and resumes into it with no retire', async () => {
    const agentId = await liveHeadless()
    const allocation = await worktreeStrategy.allocate({ agentId, agentName: 'scout', baseCwd: makeRepo() })
    writeRuntimeState(agentId, {
      handle: { surface: 'headless', pid: PID },
      allocation,
      isolation: 'worktree',
    })
    fs.writeFileSync(path.join(allocation.cwd, 'wip.ts'), 'unsaved\n')
    writeTranscriptFor(agentId)

    h.restart()
    expect(stateOf(agentId)).toBe('exited')
    const result = await h.supervisor.resume('scout')

    expect(result.reason).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(fs.existsSync(path.join(allocation.cwd, 'wip.ts'))).toBe(true)
    expect(fs.existsSync(runtimeStatePath(agentId))).toBe(true)
    expect(readRuntimeState(agentId)?.allocation?.cwd).toBe(allocation.cwd)
    const kinds = h.core.events
      .agentEvents()
      .filter(row => row.ref === agentId)
      .map(row => row.kind)
    expect(kinds).not.toContain('isolation_released')
    expect(kinds).not.toContain('agent_retired')
  })

  it('returns a row that reattaches to live', async () => {
    const agentId = await liveHeadless()
    h.restart()
    expect(stateOf(agentId)).toBe('exited')

    h.reattach(['scout'])

    expect(stateOf(agentId)).toBe('live')
    expect(h.core.agents.get(agentId)?.exitedAt).toBeUndefined()
  })
})
