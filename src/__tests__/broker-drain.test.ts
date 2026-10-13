import fs from 'node:fs'
import type net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Conn } from '../broker/core.js'
import { DrainState } from '../broker/drain.js'
import { guardRestart, restartBlockers, type BlockerSource } from '../cli/restart-guard.js'
import { startSupervisor, type RestartHarness } from './helpers/restart-harness.js'

/** CC-1179: while the broker drains for a restart, new spawns and resumes wait and in-flight ones finish. */

const fakeConn = (): Conn => ({}) as unknown as net.Socket

describe('the drain state', () => {
  it('holds until its expiry and lapses at it', () => {
    const drain = new DrainState()
    drain.enter(1_000)

    expect(drain.active(999)).toEqual({ until: 1_000 })
    expect(drain.active(1_000)).toBeUndefined()
  })

  it('refuses with the time left until it lifts, in the reason too', () => {
    const drain = new DrainState()
    drain.enter(61_000)

    expect(drain.refusal(1_000)).toEqual({
      reason: 'the broker is draining for a restart; retry in ~60s',
      retryAfterMs: 60_000,
    })
  })

  it('refuses nothing once left', () => {
    const drain = new DrainState()
    drain.enter(61_000)
    drain.leave()

    expect(drain.refusal(1_000)).toBeUndefined()
  })
})

describe('a supervisor under drain', () => {
  let h: RestartHarness | undefined
  let peerCwd: string | undefined

  afterEach(() => {
    vi.useRealTimers()
    h?.close()
    h = undefined
    if (peerCwd) fs.rmSync(peerCwd, { recursive: true, force: true })
    peerCwd = undefined
  })

  /** A non-human requester, so the rate budget applies to its spawns. */
  const startWithPeer = (
    attach: boolean,
  ): { harness: RestartHarness; spawnAsPeer: (name: string) => ReturnType<RestartHarness['spawnAgent']> } => {
    const harness = startSupervisor({ attach, settleMs: 0 })
    h = harness
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-drain-peer-'))
    peerCwd = cwd
    harness.core.register(fakeConn(), { t: 'register', name: 'peer', workingOn: '', cwd, pid: 1 })
    return { harness, spawnAsPeer: name => harness.spawnAgent(name, { requestedBy: 'peer', cwd }) }
  }

  const sourceOf = (harness: RestartHarness): BlockerSource => ({
    agents: async () => harness.core.agents.roster(),
  })

  it('refuses a 10-spawn burst as retryable while the pre-drain spawn attaches, and the restart then goes ahead', async () => {
    const { harness, spawnAsPeer } = startWithPeer(false)
    const inFlight = harness.spawnAgent('first')
    await vi.waitFor(() => expect(harness.core.agents.byName('first')?.state).toBe('spawning'))

    harness.supervisor.drain(true, 60_000)
    const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => spawnAsPeer(`burst-${i}`)))

    for (const outcome of burst)
      expect(outcome).toMatchObject({ ok: false, code: 'broker_draining', retryable: true })
    expect(burst.every(outcome => (outcome.retryAfterMs ?? 0) > 0)).toBe(true)
    const now = Date.now()
    expect(restartBlockers(harness.core.agents.roster(), now).spawning).toEqual(['first'])

    harness.reattach(['first'])
    expect(await inFlight).toMatchObject({ ok: true, name: 'first' })
    expect(restartBlockers(harness.core.agents.roster(), Date.now()).spawning).toEqual([])
    expect(await guardRestart('restart', sourceOf(harness))).toBeNull()
  })

  it('spends no rate budget on drained spawns', async () => {
    const { harness, spawnAsPeer } = startWithPeer(true)
    harness.supervisor.drain(true, 60_000)
    for (let i = 0; i < 10; i++) await spawnAsPeer(`burst-${i}`)

    harness.supervisor.drain(false)
    const after = await spawnAsPeer('after')

    expect(after).toMatchObject({ ok: true, name: 'after' })
  })

  it('refuses a resume with the same retryable code', async () => {
    const { harness } = startWithPeer(true)
    await harness.spawnAgent('scout')
    harness.supervisor.drain(true, 60_000)

    const outcome = await harness.supervisor.resume('scout')

    expect(outcome).toMatchObject({ ok: false, code: 'broker_draining', retryable: true })
    expect(outcome.retryAfterMs).toBeGreaterThan(0)
  })

  it('lifts the drain at its ttl, so a killed restarter never leaves spawns refused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { harness, spawnAsPeer } = startWithPeer(true)
    harness.supervisor.drain(true, 60_000)
    expect(harness.supervisor.draining()).toEqual({ until: Date.now() + 60_000 })

    vi.setSystemTime(Date.now() + 60_000)
    const outcome = await spawnAsPeer('late')

    expect(harness.supervisor.draining()).toBeUndefined()
    expect(outcome).toMatchObject({ ok: true, name: 'late' })
  })
})
