import { describe, expect, it } from 'vitest'
import { runCallerTeleport, type CallerLaunchDeps } from '../server/caller-teleport.js'
import type { ClientMessage, RemoteLaunch, ServerMessage } from '../protocol.js'

/**
 * CC-881: the MCP side of a teleport from a session on another host. The broker hands back the
 * relaunch plan; this process writes the launch files, opens the successor and only then ends
 * the Claude Code that owns it. The filesystem, the surface and the signal are all fakes.
 */

const LAUNCH: RemoteLaunch = {
  agentId: 'succ0001',
  plan: {
    agentId: 'succ0001',
    bin: 'claude',
    args: ['--session-id', 'x'],
    cwd: '/work',
    env: {},
    title: 'cc27',
    surface: 'iterm-tab',
  },
  mcpConfig: { mcpServers: {} },
  surface: 'iterm-tab',
}

function fakeBroker(plan: Extract<ServerMessage, { t: 'teleport_plan' }>) {
  const sent: ClientMessage[] = []
  return {
    sent,
    request: async (message: ClientMessage) => {
      sent.push(message)
      if (message.t === 'teleport_plan_wait') return plan
      return { t: 'teleport_launched_result', ok: true } as ServerMessage
    },
  }
}

function recordingDeps(over: Partial<CallerLaunchDeps> = {}) {
  const steps: string[] = []
  const deps: CallerLaunchDeps = {
    writeFiles: launch => void steps.push(`write ${launch.agentId}`),
    launch: async launch => void steps.push(`launch ${launch.surface}`),
    endParent: pid => void steps.push(`end ${pid}`),
    ...over,
  }
  return { steps, deps }
}

const reports = (sent: ClientMessage[]) => sent.filter(m => m.t === 'teleport_launched')

describe('a caller-side teleport', () => {
  it('writes the files, launches, reports, and only then ends its parent', async () => {
    const broker = fakeBroker({ t: 'teleport_plan', ok: true, launch: LAUNCH })
    const { steps, deps } = recordingDeps()

    await runCallerTeleport(broker, 4321, deps)

    expect(steps).toEqual(['write succ0001', 'launch iterm-tab', 'end 4321'])
    expect(reports(broker.sent)).toEqual([{ t: 'teleport_launched', ok: true }])
  })

  it('leaves its parent alive and reports why when the launch fails', async () => {
    const broker = fakeBroker({ t: 'teleport_plan', ok: true, launch: LAUNCH })
    const { steps, deps } = recordingDeps({
      launch: async () => {
        throw new Error('iTerm is not running')
      },
    })

    await runCallerTeleport(broker, 4321, deps)

    expect(steps).toEqual(['write succ0001'])
    expect(reports(broker.sent)).toEqual([
      { t: 'teleport_launched', ok: false, reason: 'iTerm is not running' },
    ])
  })

  it('does not launch when the launch files cannot be written', async () => {
    const broker = fakeBroker({ t: 'teleport_plan', ok: true, launch: LAUNCH })
    const { steps, deps } = recordingDeps({
      writeFiles: () => {
        throw new Error('EACCES')
      },
    })

    await runCallerTeleport(broker, 4321, deps)

    expect(steps).toEqual([])
    expect(reports(broker.sent)).toEqual([{ t: 'teleport_launched', ok: false, reason: 'EACCES' }])
  })

  it('does nothing when the broker has no plan to run', async () => {
    const broker = fakeBroker({ t: 'teleport_plan', ok: false, reason: 'aborted by the human' })
    const { steps, deps } = recordingDeps()

    await runCallerTeleport(broker, 4321, deps)

    expect(steps).toEqual([])
    expect(reports(broker.sent)).toEqual([])
  })

  it('refuses to launch when it does not know which process to end', async () => {
    const broker = fakeBroker({ t: 'teleport_plan', ok: true, launch: LAUNCH })
    const { steps, deps } = recordingDeps()

    await runCallerTeleport(broker, undefined, deps)

    expect(steps).toEqual([])
    expect(reports(broker.sent)[0]).toMatchObject({ ok: false })
  })
})
