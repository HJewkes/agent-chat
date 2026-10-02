import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
let spawnedId = ''

const probe: ProcessProbe = {
  isAlive: pid => alive.has(pid),
  readArgv: () => argvOf(),
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

  it('is not reaped when no pid was recorded, as for a visible agent', async () => {
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
})
