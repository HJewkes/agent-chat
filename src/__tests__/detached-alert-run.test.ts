import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_DETACHED_ALERT, type DetachedAlertConfig } from '../agents/seats/detached-alert.js'
import { brokerRoster, runDetachedAlert, type DetachedPorts } from '../agents/seats/detached-alert-run.js'
import type { Notified } from '../agents/seats/notified-state.js'
import type { AgentIdentity } from '../protocol.js'
import { MAC_HOST, agentRows, at } from './helpers/detached-rows.js'

const NOW = at('11:40:00')
const MINUTE = 60_000

const macDrop = (): AgentIdentity[] =>
  ['agent-a', 'agent-b', 'agent-c', 'agent-d'].map(name =>
    agentRows({ name, host: MAC_HOST, detachedAt: at('11:20:00'), exit: 'remote-inferred' }),
  )

function spyPorts(roster: AgentIdentity[], over: Partial<DetachedPorts> = {}) {
  let state: Notified = {}
  const ports = {
    rules: DEFAULT_DETACHED_ALERT,
    roster: vi.fn(async () => roster),
    probe: vi.fn<DetachedPorts['probe']>(() => ({ dead: false, reason: 'session pid 7 is running' })),
    loadState: vi.fn(() => state),
    saveState: vi.fn((next: Notified) => {
      state = next
    }),
    notify: vi.fn<DetachedPorts['notify']>(async () => ({ ok: true, detail: 'notice n-1' })),
    log: vi.fn(),
    ...over,
  }
  return { ports, state: () => state }
}

const live = { dryRun: false, nowMs: NOW }

describe('the detached sub-pass', () => {
  it('files one notice for a Mac drop, nothing on the next tick, and again after renotifyMinutes', async () => {
    const { ports, state } = spyPorts(macDrop())

    await runDetachedAlert(ports, live)
    await runDetachedAlert(ports, { dryRun: false, nowMs: NOW + 15 * MINUTE })
    await runDetachedAlert(ports, { dryRun: false, nowMs: NOW + 120 * MINUTE })

    expect(ports.notify).toHaveBeenCalledTimes(2)
    expect(ports.notify).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('agent-a 20m, agent-b 20m, agent-c 20m, agent-d 20m'),
    )
    expect(Object.keys(state())).toHaveLength(4)
  })

  it('pages nothing and saves no key for a local row whose process is gone', async () => {
    const { ports, state } = spyPorts([agentRows({ name: 'agent-a', detachedAt: at('11:00:00') })], {
      probe: vi.fn(() => ({ dead: true as const, reason: 'session pid 7 is gone' })),
    })

    await runDetachedAlert(ports, live)

    expect(ports.notify).not.toHaveBeenCalled()
    expect(state()).toEqual({})
  })

  it('pages a local row whose process is alive', async () => {
    const { ports } = spyPorts([agentRows({ name: 'agent-a', detachedAt: at('11:00:00') })])

    await runDetachedAlert(ports, live)

    expect(ports.notify).toHaveBeenCalledWith(expect.stringContaining('agent-a 40m (process alive)'))
  })

  it('keeps the state when the notice fails, so the next pass retries', async () => {
    const { ports } = spyPorts(macDrop(), { notify: vi.fn(async () => ({ ok: false, detail: 'refused' })) })

    const lines = await runDetachedAlert(ports, live)

    expect(ports.saveState).not.toHaveBeenCalled()
    expect(lines).toEqual(['detached: notice failed: refused; state kept for the next pass'])
  })

  it('lists every candidate on a dry run and neither sends nor saves', async () => {
    const lone = agentRows({
      name: 'agent-e',
      host: 'host-other.local',
      detachedAt: at('11:00:00'),
      exit: 'remote-inferred',
    })
    const { ports } = spyPorts([...macDrop(), lone])

    const lines = await runDetachedAlert(ports, { dryRun: true, nowMs: NOW })

    expect(ports.notify).not.toHaveBeenCalled()
    expect(ports.saveState).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('would notify: Detached over 15 min')
    expect(lines.join('\n')).toContain(
      'listed, not paged: detached >15m: agent-e 40m (host host-other.local, unverified)',
    )
  })

  it('calls no port but its rules when disabled', async () => {
    const rules: DetachedAlertConfig = { ...DEFAULT_DETACHED_ALERT, enabled: false }
    const { ports } = spyPorts(macDrop(), { rules })

    const lines = await runDetachedAlert(ports, live)

    expect(lines).toEqual(['detached: detachedAlert.enabled is false; nothing done'])
    for (const port of [ports.roster, ports.probe, ports.loadState, ports.saveState, ports.notify, ports.log])
      expect(port).not.toHaveBeenCalled()
  })

  it('sends the broker only the read-only agents frame', async () => {
    const request = vi.fn(async () => ({ t: 'agents_result' as const, agents: macDrop() }))
    const { ports } = spyPorts([], { roster: brokerRoster({ request } as never) })

    await runDetachedAlert(ports, live)

    expect(request.mock.calls.map(call => (call as unknown[])[0])).toEqual([{ t: 'agents' }])
    expect(ports.notify).toHaveBeenCalledTimes(1)
  })
})
