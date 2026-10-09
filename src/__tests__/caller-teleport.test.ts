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
  origin: {
    execPath: '/broker/bin/node',
    cliEntry: '/broker/app/dist/cli.js',
    home: '/broker/home/.agent-chat',
  },
}

const CALLER_PATHS = {
  execPath: '/caller/bin/node',
  cliEntry: '/caller/app/dist/cli.js',
  home: '/caller/.agent-chat',
}

type Ack = Extract<ServerMessage, { t: 'teleport_launched_result' }>

function fakeBroker(
  plan: Extract<ServerMessage, { t: 'teleport_plan' }>,
  ack: Ack = { t: 'teleport_launched_result', ok: true },
) {
  const sent: ClientMessage[] = []
  return {
    sent,
    request: async (message: ClientMessage) => {
      sent.push(message)
      if (message.t === 'teleport_plan_wait') return plan
      return ack as ServerMessage
    },
  }
}

function recordingDeps(over: Partial<CallerLaunchDeps> = {}) {
  const steps: string[] = []
  const deps: CallerLaunchDeps = {
    paths: CALLER_PATHS,
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

  it('leaves its parent alive when the broker refuses the launch report', async () => {
    const broker = fakeBroker(
      { t: 'teleport_plan', ok: true, launch: LAUNCH },
      { t: 'teleport_launched_result', ok: false, reason: 'no teleport launch is awaiting a report' },
    )
    const { steps, deps } = recordingDeps()

    await runCallerTeleport(broker, 4321, deps)

    expect(steps).toEqual(['write succ0001', 'launch iterm-tab'])
  })

  it("writes and launches with its own node, CLI and home rather than the broker host's", async () => {
    const remote: RemoteLaunch = {
      ...LAUNCH,
      plan: {
        ...LAUNCH.plan,
        args: ['--mcp-config', '/broker/home/.agent-chat/agents/succ0001/mcp.json'],
        env: { AGENT_CHAT_HOME: '/broker/home/.agent-chat' },
      },
      mcpConfig: {
        mcpServers: { bus: { command: '/broker/bin/node', args: ['/broker/app/dist/cli.js', 'mcp'] } },
      },
    }
    const broker = fakeBroker({ t: 'teleport_plan', ok: true, launch: remote })
    const written: RemoteLaunch[] = []
    const { deps } = recordingDeps({ writeFiles: launch => void written.push(launch) })

    await runCallerTeleport(broker, 4321, deps)

    expect(written[0]?.plan.args).toEqual(['--mcp-config', '/caller/.agent-chat/agents/succ0001/mcp.json'])
    expect(written[0]?.plan.env).toEqual({ AGENT_CHAT_HOME: '/caller/.agent-chat' })
    expect(written[0]?.mcpConfig).toEqual({
      mcpServers: { bus: { command: '/caller/bin/node', args: ['/caller/app/dist/cli.js', 'mcp'] } },
    })
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
