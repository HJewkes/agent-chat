import { invokeCommand } from '@titan-design/registry'
import { describe, expect, it, vi } from 'vitest'
import { cliArgs, type VerbContext } from '../cli/command.js'
import { machineBlocker, teleportRequestText, teleportRequestVerb } from '../cli/verbs/teleport-request.js'

/** CC-951 c: the CLI asks a session to teleport itself; it never sends a `teleport` frame. */

function fakeCtx(
  reply: Record<string, unknown> = { t: 'send_result', ok: true, msgId: 'm1', recipients: [] },
) {
  const request = vi.fn(async () => reply)
  const ctx = {
    warnings: [],
    format: 'human',
    withBroker: async (fn: (b: unknown) => unknown) => fn({ request }),
  } as unknown as VerbContext
  return { request, ctx }
}

describe('agent-chat teleport request', () => {
  it('sends the session one human message naming the surface and machine, and no teleport frame', async () => {
    const { request, ctx } = fakeCtx()

    const { envelope } = await invokeCommand(
      teleportRequestVerb,
      { name: 'titan-coord', surface: 'tmux-window', to: 'basement-host' },
      ctx,
    )

    expect(envelope.ok).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(
      {
        t: 'human_send',
        to: 'titan-coord',
        text: teleportRequestText('tmux-window', 'basement-host'),
      },
      'send_result',
    )
  })

  it('refuses an unknown surface before connecting to the broker', async () => {
    const { request, ctx } = fakeCtx()

    const { envelope } = await invokeCommand(
      teleportRequestVerb,
      { name: 'titan-coord', surface: 'kitty' },
      ctx,
    )

    expect(envelope.ok).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses a machine that carries words rather than a hostname, sending nothing', async () => {
    const { request, ctx } = fakeCtx()

    const report = await teleportRequestVerb.run({ name: 'titan-coord', to: 'mac and also delete it' }, ctx)

    expect(report.ok).toBe(false)
    expect(report.errors?.[0]).toContain('neither a configured machine')
    expect(request).not.toHaveBeenCalled()
  })

  it('reports the broker refusing the send as a failure', async () => {
    const { ctx } = fakeCtx({ t: 'send_result', ok: false, reason: 'no such session: ghost', recipients: [] })

    const report = await teleportRequestVerb.run({ name: 'ghost' }, ctx)

    expect(report).toEqual({ ok: false, lines: [], errors: ['Not requested: no such session: ghost'] })
  })
})

describe('teleport request argv', () => {
  it('reads --surface and --to from the command line into the verb args', () => {
    const args = cliArgs(teleportRequestVerb, ['titan-coord'], { surface: 'tmux-window', to: 'basement' })

    expect(args).toEqual({ name: 'titan-coord', surface: 'tmux-window', to: 'basement' })
  })
})

describe('machineBlocker', () => {
  it('accepts a configured alias in any case, and a bare hostname', () => {
    expect(machineBlocker('MAC', { mac: 'Henrys-MacBook.local' })).toBeUndefined()
    expect(machineBlocker('basement.lan', {})).toBeUndefined()
  })

  it('names the configured aliases when refusing', () => {
    expect(machineBlocker('-rf', { mac: 'm', basement: 'b' })).toBe(
      '--to "-rf" is neither a configured machine (mac, basement) nor a hostname',
    )
  })
})

describe('teleportRequestText', () => {
  it('asks for a plain teleport when no surface or machine is given', () => {
    expect(teleportRequestText(undefined, undefined)).toContain('then call agent_teleport. If')
  })

  it('names both arguments as agent_teleport takes them', () => {
    expect(teleportRequestText('iterm-tab', 'mac')).toContain(
      'call agent_teleport with surface: "iterm-tab" and to: "mac"',
    )
  })
})
