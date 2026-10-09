import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { armHelper, runCallerTeleport, type CallerLaunchDeps } from '../server/caller-teleport.js'
import { landSuccessor, waitForGo, type LandDeps, type Placement } from '../server/caller-land.js'
import { PANE_EXIT_TIMEOUT_MS } from '../agents/teleport.js'
import { PassThrough } from 'node:stream'
import type { ClientMessage, RemoteLaunch, ServerMessage } from '../protocol.js'
import type { LaunchPlan } from '../agents/types.js'

/**
 * CC-881: the MCP side of a teleport from a session on another host. The broker hands back a
 * host-neutral spec; this process builds the plan from its own host, arms a helper, and ends the
 * Claude Code that owns it only once the broker accepts the report. CC-913: the helper places
 * the successor in the predecessor's pane after it exits. The filesystem, the surface, the
 * process table and the signal are all fakes.
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
    arm: async (spec, hostPid) => {
      steps.push(`arm ${spec.surface} ${hostPid}`)
      return { go: () => (steps.push('go'), true), abandon: () => void steps.push('abandon') }
    },
    endParent: pid => void steps.push(`end ${pid}`),
    ...over,
  }
  return { steps, written, deps }
}

const reports = (sent: ClientMessage[]) => sent.filter(m => m.t === 'teleport_launched')

describe('a caller-side teleport', () => {
  it('writes the files, arms, reports, and only then releases the helper and ends its parent', async () => {
    const broker = fakeBroker(SPEC)
    const { steps, deps } = recordingDeps()

    await runCallerTeleport(broker, 4321, deps)

    expect(steps).toEqual(['write abcd1234', 'arm iterm-tab 4321', 'go', 'end 4321'])
    expect(reports(broker.sent)).toEqual([{ t: 'teleport_launched', agentId: 'abcd1234', ok: true }])
  })

  it('disarms the successor and keeps its parent when the broker refuses a late report', async () => {
    const broker = fakeBroker(SPEC, { t: 'teleport_launched_result', ok: false, reason: 'released' })
    const { steps, deps } = recordingDeps()

    await runCallerTeleport(broker, 4321, deps)

    expect(steps).toEqual(['write abcd1234', 'arm iterm-tab 4321', 'abandon'])
  })

  it('disarms the successor and keeps its parent when the report cannot be delivered', async () => {
    const broker = fakeBroker(SPEC, new Error('broker did not answer teleport_launched_result'))
    const { steps, deps } = recordingDeps()

    await runCallerTeleport(broker, 4321, deps)

    expect(steps).toEqual(['write abcd1234', 'arm iterm-tab 4321', 'abandon'])
  })

  it('leaves its parent alive and reports why when the helper cannot be armed', async () => {
    const broker = fakeBroker(SPEC)
    const { steps, deps } = recordingDeps({
      arm: async () => {
        throw new Error('spawn EACCES')
      },
    })

    await runCallerTeleport(broker, 4321, deps)

    expect(steps).toEqual(['write abcd1234'])
    expect(reports(broker.sent)).toEqual([
      { t: 'teleport_launched', agentId: 'abcd1234', ok: false, reason: 'spawn EACCES' },
    ])
  })

  it('keeps its parent when the helper died before it could be released', async () => {
    const broker = fakeBroker(SPEC)
    const { steps, deps } = recordingDeps({
      arm: async () => ({ go: () => false, abandon: () => undefined }),
    })

    await runCallerTeleport(broker, 4321, deps)

    expect(steps).toEqual(['write abcd1234'])
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

  // CC-883: the successor argv a coordinator keeps and a worker never gets.
  it.each([
    ['keeps --remote-control for a coordinator', 'coordinator', true],
    ['omits --remote-control for a worker, whatever the broker sent', 'worker', false],
  ] as const)('%s', async (_case, role, expected) => {
    const spec = { ...SPEC, remoteControl: true, profile: { ...SPEC.profile, role } }
    const broker = fakeBroker(spec)
    const { written, deps } = recordingDeps()

    await runCallerTeleport(broker, 4321, deps)

    expect(written[0]?.plan.args.includes('--remote-control')).toBe(expected)
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

const ANCHOR = 'w0t0p0:6F1A2B3C-0000-4000-8000-000000000001'
const PLAN = { agentId: 'abcd1234' } as LaunchPlan

/** A virtual clock and process table: the pid stays alive for `livePolls` checks, or forever. */
function landDeps(opts: { livePolls?: number; fail?: (placement: Placement) => string | undefined } = {}) {
  let clock = 0
  let polls = 0
  const steps: string[] = []
  const deps: LandDeps = {
    pidAlive: () => {
      const alive = opts.livePolls === undefined || polls++ < opts.livePolls
      if (!alive) steps.push('exited')
      return alive
    },
    now: () => clock,
    sleep: async ms => void (clock += ms),
    launch: async (surface, _plan, placement) => {
      steps.push(
        `launch ${surface} ${placement.reuseAnchor === true ? 'in-pane' : 'beside'} ${placement.anchor}`,
      )
      const failure = opts.fail?.(placement)
      if (failure !== undefined) throw new Error(failure)
    },
    failed: async reason => void steps.push(`failed: ${reason}`),
  }
  return { steps, deps }
}

describe("landing a cross-host successor in its predecessor's pane", () => {
  it('waits for the predecessor to exit, then types the successor into its pane', async () => {
    const { steps, deps } = landDeps({ livePolls: 3 })

    await landSuccessor({ surface: 'iterm-tab', plan: PLAN, hostPid: 4321, anchor: ANCHOR }, deps)

    expect(steps).toEqual(['exited', `launch iterm-tab in-pane ${ANCHOR}`])
  })

  it('opens beside the anchor when the pane does not free in time', async () => {
    const { steps, deps } = landDeps()

    await landSuccessor({ surface: 'iterm-tab', plan: PLAN, hostPid: 4321, anchor: ANCHOR }, deps)

    expect(steps).toEqual([`launch iterm-tab beside ${ANCHOR}`])
  })

  it('retries beside the anchor without telling anyone when the in-pane launch throws', async () => {
    const { steps, deps } = landDeps({
      livePolls: 0,
      fail: placement => (placement.reuseAnchor === true ? 'pane refused the command' : undefined),
    })

    await landSuccessor({ surface: 'iterm-tab', plan: PLAN, hostPid: 4321, anchor: ANCHOR }, deps)

    expect(steps).toEqual([
      'exited',
      `launch iterm-tab in-pane ${ANCHOR}`,
      `launch iterm-tab beside ${ANCHOR}`,
    ])
  })

  it('tells the broker once, with both reasons, when the retry beside the anchor fails too', async () => {
    const { steps, deps } = landDeps({ livePolls: 0, fail: () => 'iTerm is not running' })

    await landSuccessor({ surface: 'iterm-tab', plan: PLAN, hostPid: 4321, anchor: ANCHOR }, deps)

    expect(steps.filter(step => step.startsWith('failed'))).toEqual([
      'failed: in its pane: iTerm is not running; beside it: iTerm is not running',
    ])
  })

  it('names the held pane when it gives up waiting and the fallback fails', async () => {
    const { steps, deps } = landDeps({ fail: () => 'no window' })

    await landSuccessor({ surface: 'iterm-tab', plan: PLAN, hostPid: 4321, anchor: ANCHOR }, deps)

    expect(steps.at(-1)).toBe(
      `failed: pid 4321 still held its pane after ${PANE_EXIT_TIMEOUT_MS / 1000}s; beside it: no window`,
    )
  })

  it('launches without an anchor only after the predecessor exits', async () => {
    const { steps, deps } = landDeps({ livePolls: 2 })

    await landSuccessor({ surface: 'headless', plan: PLAN, hostPid: 4321 }, deps)

    expect(steps).toEqual(['exited', 'launch headless beside undefined'])
  })
})

describe("the helper's release", () => {
  it("goes on the caller's go line", async () => {
    const stdin = new PassThrough()
    const go = waitForGo(stdin)

    stdin.write('go\n')

    await expect(go).resolves.toBe(true)
  })

  it('does nothing when the caller closes its stdin without releasing it', async () => {
    const stdin = new PassThrough()
    const go = waitForGo(stdin)

    stdin.end()

    await expect(go).resolves.toBe(false)
  })
})

describe('the armed helper process', () => {
  const RECORDER = [
    "import fs from 'node:fs'",
    "let got = ''",
    "process.stdin.on('data', chunk => (got += chunk))",
    "process.stdin.on('end', () => fs.writeFileSync(process.env.LAND_OUT, JSON.stringify({ argv: process.argv.slice(2), got })))",
  ].join('\n')

  async function armRecorder() {
    fs.mkdirSync(path.join(callerHome, 'agents', SPEC.agentId), { recursive: true })
    const script = path.join(cwd, 'recorder.mjs')
    const out = path.join(cwd, 'out.json')
    fs.writeFileSync(script, RECORDER)
    const armed = await armHelper(
      { cliEntry: script, cwd, env: { ...process.env, LAND_OUT: out } },
      { ...SPEC, anchor: ANCHOR },
      4321,
    )
    return { armed, out }
  }

  async function settle(file: string): Promise<unknown> {
    for (let i = 0; i < 100 && !fs.existsSync(file); i++)
      await new Promise(resolve => setTimeout(resolve, 50))
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined
  }

  it('is told which pane and pid to wait on, and released by one go line', async () => {
    const { armed, out } = await armRecorder()

    expect(armed.go()).toBe(true)

    expect(await settle(out)).toEqual({
      argv: ['teleport-land', SPEC.agentId, '--pid=4321', '--surface=iterm-tab', `--anchor=${ANCHOR}`],
      got: 'go\n',
    })
  })

  it('never hears go once disarmed', async () => {
    const { armed, out } = await armRecorder()

    armed.abandon()
    await new Promise(resolve => setTimeout(resolve, 300))

    expect(fs.existsSync(out)).toBe(false)
  })
})
