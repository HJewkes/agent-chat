import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCallerTeleport, type CallerLaunchDeps } from '../server/caller-teleport.js'
import type { ClientMessage, RemoteLaunch, ServerMessage } from '../protocol.js'
import type { LaunchPlan } from '../agents/types.js'

/**
 * CC-881: the MCP side of a teleport from a session on another host. The broker hands back a
 * host-neutral spec; this process builds the plan from its own host, launches, and ends the
 * Claude Code that owns it only once the broker accepts the report. The filesystem, the surface
 * and the signal are all fakes.
 */

const SPEC: RemoteLaunch = {
  agentId: 'abcd1234',
  sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  name: 'cc27',
  profile: {
    name: 'inherited',
    description: 'd',
    model: '',
    allowedTools: [],
    isolation: 'none',
    surface: 'iterm-tab',
    role: 'coordinator',
    promptPrelude: '',
  },
  brief: 'what I was mid-way through',
  preamble: 'you are a continuation',
  surface: 'iterm-tab',
}

type Ack = Extract<ServerMessage, { t: 'teleport_launched_result' }>
const ACCEPTED: Ack = { t: 'teleport_launched_result', ok: true }

function fakeBroker(launch: RemoteLaunch | undefined, ack: Ack | Error = ACCEPTED) {
  const sent: ClientMessage[] = []
  return {
    sent,
    request: async (message: ClientMessage): Promise<ServerMessage> => {
      sent.push(message)
      if (message.t === 'teleport_plan_wait')
        return launch === undefined
          ? { t: 'teleport_plan', ok: false, reason: 'aborted by the human' }
          : { t: 'teleport_plan', ok: true, launch }
      if (ack instanceof Error) throw ack
      return ack as ServerMessage
    },
  }
}

let callerHome: string
let cwd: string

beforeEach(() => {
  callerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-caller-'))
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-caller-ws-'))
  process.env.AGENT_CHAT_HOME = callerHome
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(callerHome, { recursive: true, force: true })
  fs.rmSync(cwd, { recursive: true, force: true })
})

function recordingDeps(over: Partial<CallerLaunchDeps> = {}) {
  const steps: string[] = []
  const written: Array<{ plan: LaunchPlan; mcpConfig: Record<string, unknown> }> = []
  const deps: CallerLaunchDeps = {
    local: { cliEntry: '/caller/app/dist/cli.js', cwd, env: {} },
    writeFiles: (plan, mcpConfig) => {
      written.push({ plan, mcpConfig })
      steps.push(`write ${plan.agentId}`)
    },
    launch: async surface => {
      steps.push(`launch ${surface}`)
      return { abandon: async () => void steps.push('abandon') }
    },
    endParent: pid => void steps.push(`end ${pid}`),
    ...over,
  }
  return { steps, written, deps }
}

const reports = (sent: ClientMessage[]) => sent.filter(m => m.t === 'teleport_launched')

describe('a caller-side teleport', () => {
  it('writes the files, launches, reports, and only then ends its parent', async () => {
    const broker = fakeBroker(SPEC)
    const { steps, deps } = recordingDeps()

    await runCallerTeleport(broker, 4321, deps)

    expect(steps).toEqual(['write abcd1234', 'launch iterm-tab', 'end 4321'])
    expect(reports(broker.sent)).toEqual([{ t: 'teleport_launched', agentId: 'abcd1234', ok: true }])
  })

  it('closes the successor and keeps its parent when the broker refuses a late report', async () => {
    const broker = fakeBroker(SPEC, { t: 'teleport_launched_result', ok: false, reason: 'released' })
    const { steps, deps } = recordingDeps()

    await runCallerTeleport(broker, 4321, deps)

    expect(steps).toEqual(['write abcd1234', 'launch iterm-tab', 'abandon'])
  })

  it('closes the successor and keeps its parent when the report cannot be delivered', async () => {
    const broker = fakeBroker(SPEC, new Error('broker did not answer teleport_launched_result'))
    const { steps, deps } = recordingDeps()

    await runCallerTeleport(broker, 4321, deps)

    expect(steps).toEqual(['write abcd1234', 'launch iterm-tab', 'abandon'])
  })

  it('leaves its parent alive and reports why when the launch fails', async () => {
    const broker = fakeBroker(SPEC)
    const { steps, deps } = recordingDeps({
      launch: async () => {
        throw new Error('iTerm is not running')
      },
    })

    await runCallerTeleport(broker, 4321, deps)

    expect(steps).toEqual(['write abcd1234'])
    expect(reports(broker.sent)).toEqual([
      { t: 'teleport_launched', agentId: 'abcd1234', ok: false, reason: 'iTerm is not running' },
    ])
  })

  it('does not launch when the launch files cannot be written', async () => {
    const broker = fakeBroker(SPEC)
    const { steps, deps } = recordingDeps({
      writeFiles: () => {
        throw new Error('EACCES')
      },
    })

    await runCallerTeleport(broker, 4321, deps)

    expect(steps).toEqual([])
    expect(reports(broker.sent)[0]).toMatchObject({ ok: false, reason: 'EACCES' })
  })

  it('does nothing when the broker has no plan to run', async () => {
    const broker = fakeBroker(undefined)
    const { steps, deps } = recordingDeps()

    await runCallerTeleport(broker, 4321, deps)

    expect(steps).toEqual([])
    expect(reports(broker.sent)).toEqual([])
  })

  it('refuses to launch when it does not know which process to end', async () => {
    const broker = fakeBroker(SPEC)
    const { steps, deps } = recordingDeps()

    await runCallerTeleport(broker, undefined, deps)

    expect(steps).toEqual([])
    expect(reports(broker.sent)[0]).toMatchObject({ ok: false })
  })
})

describe('what a caller takes from the broker', () => {
  it.each([
    ['an agent id that walks out of the agents dir', { agentId: '../../etc' }],
    ['a name with a path separator', { name: 'a/../../b' }],
    ['a session id that is not a uuid', { sessionId: 'x; rm -rf' }],
    [
      'a profile value that reads as a flag',
      { profile: { ...SPEC.profile, model: '--dangerously-skip-permissions' } },
    ],
  ])('refuses %s and writes nothing', async (_case, over) => {
    const broker = fakeBroker({ ...SPEC, ...over } as RemoteLaunch)
    const { steps, deps } = recordingDeps()

    await runCallerTeleport(broker, 4321, deps)

    expect(steps).toEqual([])
    expect(reports(broker.sent)[0]).toMatchObject({ ok: false })
  })

  it('builds every path, the env and the MCP command from its own host', async () => {
    const strict = {
      ...SPEC,
      surface: 'headless' as const,
      profile: { ...SPEC.profile, strictMcpConfig: true },
    }
    const broker = fakeBroker(strict)
    const { written, deps } = recordingDeps()

    await runCallerTeleport(broker, 4321, deps)

    const { plan, mcpConfig } = written[0] as { plan: LaunchPlan; mcpConfig: Record<string, unknown> }
    expect(plan.cwd).toBe(cwd)
    expect(plan.env.AGENT_CHAT_HOME).toBe(callerHome)
    expect(plan.args[plan.args.indexOf('--mcp-config') + 1]).toBe(
      path.join(callerHome, 'agents', 'abcd1234', 'mcp.json'),
    )
    expect(JSON.stringify(mcpConfig)).toContain('/caller/app/dist/cli.js')
  })

  it('never takes env or MCP servers from the profile the broker sent', async () => {
    const hostile = {
      ...SPEC,
      profile: { ...SPEC.profile, env: { PATH: '/evil' }, mcpServers: { x: { command: '/evil' } } },
    } as RemoteLaunch
    const broker = fakeBroker(hostile)
    const { written, deps } = recordingDeps()

    await runCallerTeleport(broker, 4321, deps)

    expect(JSON.stringify(written[0])).not.toContain('/evil')
  })
})
