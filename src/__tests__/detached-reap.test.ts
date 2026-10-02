import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecord } from '../agents/claude-sessions.js'
import type { ProcessProbe } from '../agents/detached-reap.js'
import { readRuntimeState, writeRuntimeState } from '../agents/launch-files.js'
import { countLiveHeadless } from '../agents/machine-guard.js'
import { startSupervisor, type RestartHarness } from './helpers/restart-harness.js'

/**
 * CC-450: an agent the previous broker launched stayed `detached` forever, so the
 * machine guard counted it as a live headless agent and a reviewer's watcher never
 * saw it exit. The harness's stand-in child has pid 4242.
 */

const PID = 4242
const SETTLE_MS = 1000

let h: RestartHarness
let alive: Set<number>
let argvOf: () => string | undefined
let records: SessionRecord[]
let spawnedId = ''

const probe: ProcessProbe = {
  isAlive: pid => alive.has(pid),
  readArgv: () => argvOf(),
  sessionRecords: () => records,
}

const currentAgentId = (): string => spawnedId
const launcherArgv = (agentId: string): string =>
  `/usr/bin/node /opt/agent-chat/dist/cli.js run-agent ${agentId}`
const exits = (): { meta: Record<string, string> }[] =>
  h.core.events.agentEvents().filter(row => row.kind === 'agent_exited' && row.ref === currentAgentId())

beforeEach(() => {
  vi.useFakeTimers()
  alive = new Set([PID])
  argvOf = () => launcherArgv(spawnedId)
  records = []
})

afterEach(() => {
  h?.close()
  vi.useRealTimers()
})

async function spawnA(): Promise<string> {
  expect((await h.spawnAgent('a')).ok).toBe(true)
  spawnedId = h.core.agents.byName('a')?.agentId ?? ''
  return spawnedId
}

async function spawnThenDetach(): Promise<string> {
  h = startSupervisor({ slots: 5, settleMs: SETTLE_MS, processProbe: probe })
  const agentId = await spawnA()
  h.core.append({ kind: 'agent_detached', actor: 'a', ref: agentId })
  return agentId
}

describe('an agent the current broker did not launch', () => {
  it('is recorded exited, inferred, when it detaches after a reattach and its launcher is gone', async () => {
    h = startSupervisor({ slots: 5, settleMs: SETTLE_MS, processProbe: probe })
    await spawnA()
    h.restart()
    h.reattach(['a'])
    alive.delete(PID)

    h.core.append({ kind: 'agent_detached', actor: 'a', ref: currentAgentId() })
    vi.advanceTimersByTime(SETTLE_MS - 1)
    expect(exits()).toHaveLength(0)
    vi.advanceTimersByTime(1)

    expect(exits()).toHaveLength(1)
    expect(exits()[0]?.meta.inferred).toBe('true')
    expect(h.core.agents.byName('a')?.state).toBe('exited')
    expect(countLiveHeadless(h.core.agents.roster())).toBe(0)
    expect(h.semaphore.inUse).toBe(0)
  })

  it('is reaped on broker start when it was left detached with a dead launcher pid', async () => {
    await spawnThenDetach()
    alive.delete(PID)

    h.restart()

    expect(exits()).toHaveLength(1)
    expect(exits()[0]?.meta).toMatchObject({ inferred: 'true', pid: String(PID) })
    expect(countLiveHeadless(h.core.agents.roster())).toBe(0)
  })

  it('is not reaped while its launcher pid still runs its own run-agent', async () => {
    await spawnThenDetach()

    h.restart()
    h.reattach(['a'])
    h.core.append({ kind: 'agent_detached', actor: 'a', ref: currentAgentId() })
    vi.advanceTimersByTime(SETTLE_MS * 5)

    expect(exits()).toHaveLength(0)
    expect(h.core.agents.byName('a')?.state).toBe('detached')
    expect(countLiveHeadless(h.core.agents.roster())).toBe(1)
  })

  it('is reaped when its pid now belongs to another process', async () => {
    await spawnThenDetach()
    argvOf = () => '/bin/zsh -l'

    h.restart()

    expect(exits()).toHaveLength(1)
    expect(exits()[0]?.meta.inferred).toBe('true')
  })

  it('is not reaped when its pid is alive and its command line cannot be read', async () => {
    await spawnThenDetach()
    argvOf = () => undefined

    h.restart()

    expect(exits()).toHaveLength(0)
  })

  it('is not reaped when no pid was recorded and no session records can be read', async () => {
    const agentId = await spawnThenDetach()
    const state = readRuntimeState(agentId)
    if (state === undefined) throw new Error('spawn wrote no runtime state')
    writeRuntimeState(agentId, { ...state, handle: { surface: 'iterm-pane' } })
    alive.clear()

    h.restart()

    expect(exits()).toHaveLength(0)
  })

  it('keeps its row when it reattaches inside the settle window', async () => {
    h = startSupervisor({ slots: 5, settleMs: SETTLE_MS, processProbe: probe })
    await spawnA()
    h.restart()
    h.reattach(['a'])
    h.core.append({ kind: 'agent_detached', actor: 'a', ref: currentAgentId() })
    vi.advanceTimersByTime(SETTLE_MS / 2)
    h.reattach(['a'])
    alive.delete(PID)

    vi.advanceTimersByTime(SETTLE_MS * 5)

    expect(exits()).toHaveLength(0)
    expect(h.core.agents.byName('a')?.state).toBe('live')
  })

  it('is not recorded exited twice when a detach lands after its exit', async () => {
    h = startSupervisor({ slots: 5, settleMs: SETTLE_MS, processProbe: probe })
    await spawnA()
    h.restart()
    const agentId = currentAgentId()
    h.core.append({ kind: 'agent_exited', actor: 'a', ref: agentId, meta: { code: '0' } })
    h.core.append({ kind: 'agent_detached', actor: 'a', ref: agentId })
    alive.delete(PID)

    vi.advanceTimersByTime(SETTLE_MS)
    h.restart()

    expect(exits()).toHaveLength(1)
    expect(exits()[0]?.meta.code).toBe('0')
  })
  it('records its real exit once after a false reap and a reattach', async () => {
    await spawnThenDetach()
    alive.delete(PID)
    h.restart()
    expect(exits()).toHaveLength(1)

    h.reattach(['a'])
    expect(h.core.agents.byName('a')?.state).toBe('live')
    h.core.append({ kind: 'agent_detached', actor: 'a', ref: currentAgentId() })
    vi.advanceTimersByTime(SETTLE_MS)

    expect(exits()).toHaveLength(2)
    expect(exits()[1]?.meta.inferred).toBe('true')
    expect(h.core.agents.byName('a')?.state).toBe('exited')
    vi.advanceTimersByTime(SETTLE_MS * 5)
    expect(exits()).toHaveLength(2)
  })

  it('keeps exitedAt when it attaches after a real exit', async () => {
    h = startSupervisor({ slots: 5, settleMs: SETTLE_MS, processProbe: probe })
    await spawnA()
    h.core.append({ kind: 'agent_exited', actor: 'a', ref: currentAgentId(), meta: { code: '0' } })
    const exitedAt = h.core.agents.byName('a')?.exitedAt

    h.reattach(['a'])

    expect(exitedAt).toBeDefined()
    expect(h.core.agents.byName('a')?.exitedAt).toBe(exitedAt)
    expect(h.core.agents.byName('a')?.exit?.code).toBe(0)
  })
})

describe('a detached row with no launcher pid', () => {
  const SESSION = '00000000-0000-4000-8000-0000000000aa'
  const CLAUDE_PID = 5151
  const otherSession: SessionRecord = { pid: 6161, sessionId: '00000000-0000-4000-8000-0000000000bb' }
  let adoptedId = ''

  const exitsOf = (agentId: string): { meta: Record<string, string> }[] =>
    h.core.events.agentEvents().filter(row => row.kind === 'agent_exited' && row.ref === agentId)

  function adoptThenDetach(): void {
    h = startSupervisor({ slots: 5, settleMs: SETTLE_MS, processProbe: probe })
    adoptedId = h.core.append({
      kind: 'agent_spawned',
      actor: 'human',
      target: 'desk',
      meta: { origin: 'adopted', name: 'desk', cwd: '/tmp/desk', session_id: SESSION, depth: '0' },
    }).msgId
    h.core.append({ kind: 'agent_attached', actor: 'desk', ref: adoptedId })
    h.core.append({ kind: 'agent_detached', actor: 'desk', ref: adoptedId })
  }

  async function spawnWithoutPid(): Promise<string> {
    const agentId = await spawnThenDetach()
    const state = readRuntimeState(agentId)
    if (state === undefined) throw new Error('spawn wrote no runtime state')
    writeRuntimeState(agentId, { ...state, handle: { surface: 'headless' } })
    return agentId
  }

  it('is reaped one settle window after broker start when an adopted session is gone', () => {
    adoptThenDetach()
    records = [otherSession]

    h.restart()
    vi.advanceTimersByTime(SETTLE_MS - 1)
    expect(exitsOf(adoptedId)).toHaveLength(0)
    vi.advanceTimersByTime(1)

    expect(exitsOf(adoptedId)).toHaveLength(1)
    expect(exitsOf(adoptedId)[0]?.meta.inferred).toBe('true')
    expect(h.core.agents.get(adoptedId)?.state).toBe('exited')
  })

  it('is kept while a claude process still holds the adopted session', () => {
    adoptThenDetach()
    records = [otherSession, { pid: CLAUDE_PID, sessionId: SESSION }]
    alive.add(CLAUDE_PID)
    argvOf = () => '/usr/local/bin/claude --model opus'

    h.restart()
    vi.advanceTimersByTime(SETTLE_MS * 5)

    expect(exitsOf(adoptedId)).toHaveLength(0)
    expect(h.core.agents.get(adoptedId)?.state).toBe('detached')
  })

  it('is reaped when the session pid now runs another program', () => {
    adoptThenDetach()
    records = [{ pid: CLAUDE_PID, sessionId: SESSION }]
    alive.add(CLAUDE_PID)
    argvOf = () => '/bin/zsh -l'

    h.restart()
    vi.advanceTimersByTime(SETTLE_MS)

    expect(exitsOf(adoptedId)[0]?.meta).toMatchObject({ inferred: 'true', pid: String(CLAUDE_PID) })
  })

  it('is kept when the adopted session reconnects inside the settle window', () => {
    adoptThenDetach()
    records = [otherSession]

    h.restart()
    vi.advanceTimersByTime(SETTLE_MS / 2)
    h.core.append({ kind: 'agent_attached', actor: 'desk', ref: adoptedId })
    vi.advanceTimersByTime(SETTLE_MS * 5)

    expect(exitsOf(adoptedId)).toHaveLength(0)
    expect(h.core.agents.get(adoptedId)?.state).toBe('live')
  })

  it('is reaped after the settle window when a headless agent has no pid and its session is gone', async () => {
    const agentId = await spawnWithoutPid()
    records = [otherSession]

    h.restart()
    expect(exitsOf(agentId)).toHaveLength(0)
    vi.advanceTimersByTime(SETTLE_MS)

    expect(exitsOf(agentId)).toHaveLength(1)
    expect(h.core.agents.get(agentId)?.state).toBe('exited')
    expect(countLiveHeadless(h.core.agents.roster())).toBe(0)
  })

  it('is reaped when it registered after its start was declared failed and then left', async () => {
    h = startSupervisor({ slots: 5, settleMs: SETTLE_MS, processProbe: probe })
    const agentId = await spawnA()
    const state = readRuntimeState(agentId)
    if (state === undefined) throw new Error('spawn wrote no runtime state')
    writeRuntimeState(agentId, { ...state, handle: { surface: 'headless' } })
    h.core.append({ kind: 'agent_exited', actor: 'a', ref: agentId, meta: { failed: 'true' } })
    h.core.append({ kind: 'agent_attached', actor: 'a', ref: agentId })
    h.core.append({ kind: 'agent_detached', actor: 'a', ref: agentId })
    records = [otherSession]

    h.restart()
    vi.advanceTimersByTime(SETTLE_MS)

    expect(exitsOf(agentId)).toHaveLength(2)
    expect(exitsOf(agentId)[1]?.meta.inferred).toBe('true')
    expect(h.core.agents.get(agentId)?.state).toBe('exited')
  })

  it('reads as exited, not detached, when its connection closes after a real exit', async () => {
    h = startSupervisor({ slots: 5, settleMs: SETTLE_MS, processProbe: probe })
    const agentId = await spawnA()
    h.core.append({ kind: 'agent_exited', actor: 'a', ref: agentId, meta: { code: '0' } })
    h.core.append({ kind: 'agent_detached', actor: 'a', ref: agentId })

    expect(h.core.agents.get(agentId)?.state).toBe('exited')
    expect(countLiveHeadless(h.core.agents.roster())).toBe(0)
  })
})
