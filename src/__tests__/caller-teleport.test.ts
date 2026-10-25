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
  landToken: 'c0ffee00-0000-4000-8000-00000000beef',
}

type Ack = Extract<ServerMessage, { t: 'teleport_launched_result' }>
const ACCEPTED: Ack = { t: 'teleport_launched_result', ok: true }

type LandAnswer = Extract<ServerMessage, { t: 'teleport_land_failed_result' }>

type Plan = Extract<ServerMessage, { t: 'teleport_plan' }>
const END_SELF: Plan = { t: 'teleport_plan', ok: true, endSelf: true }

/** `later` answers each plan wait after the first, in order (CC-951). */
function fakeBroker(
  launch: RemoteLaunch | undefined,
  ack: Ack | Error = ACCEPTED,
  land?: LandAnswer | Error,
  later: Plan[] = [],
) {
  const sent: ClientMessage[] = []
  let waits = 0
  return {
    sent,
    request: async (message: ClientMessage): Promise<ServerMessage> => {
      sent.push(message)
      if (message.t === 'teleport_plan_wait' && waits++ > 0)
        return later.shift() ?? { t: 'teleport_plan', ok: false, reason: 'no further plan' }
      if (message.t === 'teleport_plan_wait')
        return launch === undefined
          ? { t: 'teleport_plan', ok: false, reason: 'aborted by the human' }
          : { t: 'teleport_plan', ok: true, launch }
      const answer = message.t === 'teleport_land_failed' ? land : ack
      if (answer === undefined) throw new Error(`unexpected ${message.t}`)
      if (answer instanceof Error) throw answer
      return answer as ServerMessage
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
      return { go: token => (steps.push(`go ${token}`), true), abandon: () => void steps.push('abandon') }
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

    expect(steps).toEqual(['write abcd1234', 'arm iterm-tab 4321', `go ${SPEC.landToken}`, 'end 4321'])
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

  describe('when the helper died before it could be released', () => {
    const deadHelper = { arm: async () => ({ go: () => false, abandon: () => undefined }) }
    const unplaced = (sent: ClientMessage[]) => sent.filter(m => m.t === 'teleport_land_failed')

    it('reports the successor unplaced with the landing token, and stays live only because the broker kept it', async () => {
      const broker = fakeBroker(SPEC, ACCEPTED, {
        t: 'teleport_land_failed_result',
        ok: true,
        predecessorLive: true,
      })
      const { steps, deps } = recordingDeps(deadHelper)

      await runCallerTeleport(broker, 4321, deps)

      expect(unplaced(broker.sent)).toEqual([
        {
          t: 'teleport_land_failed',
          agentId: 'abcd1234',
          token: SPEC.landToken,
          reason: 'its helper exited before it was released',
        },
      ])
      expect(steps).toEqual(['write abcd1234'])
    })

    it('ends its parent when the broker had already retired this session', async () => {
      const broker = fakeBroker(SPEC, ACCEPTED, {
        t: 'teleport_land_failed_result',
        ok: true,
        predecessorLive: false,
      })
      const { steps, deps } = recordingDeps(deadHelper)

      await runCallerTeleport(broker, 4321, deps)

      expect(steps).toEqual(['write abcd1234', 'end 4321'])
    })

    it('claims nothing when the broker does not confirm', async () => {
      const broker = fakeBroker(
        SPEC,
        ACCEPTED,
        new Error('broker did not answer teleport_land_failed_result'),
      )
      const { steps, deps } = recordingDeps(deadHelper)

      await runCallerTeleport(broker, 4321, deps)

      expect(unplaced(broker.sent)).toHaveLength(1)
      expect(steps).toEqual(['write abcd1234'])
    })
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

  // CC-951 f: the broker launched the successor on its own host, and it attached.
  it('ends its parent once on endSelf, and writes no launch files', async () => {
    const sent: ClientMessage[] = []
    const broker = { request: async (message: ClientMessage) => (sent.push(message), END_SELF) }
    const { steps, written, deps } = recordingDeps()

    await runCallerTeleport(broker, 4321, deps)

    expect(steps).toEqual(['end 4321'])
    expect(written).toEqual([])
    expect(fs.readdirSync(callerHome)).toEqual([])
    expect(sent.map(m => m.t)).toEqual(['teleport_plan_wait'])
  })

  describe('opening a new surface successor first (CC-951)', () => {
    const FIRST: RemoteLaunch = { ...SPEC, surface: 'iterm-window', successorFirst: true }

    it('launches, then ends its parent only on the endSelf that follows the attach', async () => {
      const broker = fakeBroker(FIRST, ACCEPTED, undefined, [END_SELF])
      const { steps, deps } = recordingDeps()

      await runCallerTeleport(broker, 4321, deps)

      expect(steps).toEqual(['write abcd1234', 'arm iterm-window 4321', `go ${SPEC.landToken}`, 'end 4321'])
      expect(broker.sent.map(m => m.t)).toEqual([
        'teleport_plan_wait',
        'teleport_launched',
        'teleport_plan_wait',
      ])
    })

    it('stays live when its successor never attaches', async () => {
      const refused: Plan = { t: 'teleport_plan', ok: false, reason: 'its successor did not register' }
      const broker = fakeBroker(FIRST, ACCEPTED, undefined, [refused])
      const { steps, deps } = recordingDeps()

      await runCallerTeleport(broker, 4321, deps)

      expect(steps).not.toContain('end 4321')
    })
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
    ['a carried channel that reads as a flag', { channels: ['-x'] }],
    ['a carried permission mode outside the allowlist', { permissionMode: 'bypassPermissions' }],
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

  it('carries the channels and permission mode the broker sent into the argv', async () => {
    const spec = { ...SPEC, channels: ['plugin:voltras-channel@x'], permissionMode: 'auto' }
    const broker = fakeBroker(spec)
    const { written, deps } = recordingDeps()

    await runCallerTeleport(broker, 4321, deps)

    const args = written[0]?.plan.args ?? []
    expect(args).toContain('plugin:voltras-channel@x')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('auto')
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

  // CC-1059: the spawn executor reads cwd and account from the spec; a teleport carries neither.
  it("runs a spec with no cwd or account in this process's own cwd and account", async () => {
    const broker = fakeBroker(SPEC)
    const { written, deps } = recordingDeps({
      local: { cliEntry: '/caller/app/dist/cli.js', cwd, env: { CLAUDE_CONFIG_DIR: '/caller/.claude-x' } },
    })

    await runCallerTeleport(broker, 4321, deps)

    expect(written[0]?.plan.cwd).toBe(cwd)
    expect(written[0]?.plan.env.CLAUDE_CONFIG_DIR).toBe('/caller/.claude-x')
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

  it('opens a successor-first surface at once, never in the pane or after an exit (CC-951)', async () => {
    const { steps, deps } = landDeps({ livePolls: 0 })

    await landSuccessor(
      { surface: 'iterm-window', plan: PLAN, hostPid: 4321, anchor: ANCHOR, now: true },
      deps,
    )

    expect(steps).toEqual([`launch iterm-window beside ${ANCHOR}`])
  })

  it('launches without an anchor only after the predecessor exits', async () => {
    const { steps, deps } = landDeps({ livePolls: 2 })

    await landSuccessor({ surface: 'headless', plan: PLAN, hostPid: 4321 }, deps)

    expect(steps).toEqual(['exited', 'launch headless beside undefined'])
  })
})

describe("the helper's release", () => {
  it("goes on the caller's go line, with the landing token it carries", async () => {
    const stdin = new PassThrough()
    const go = waitForGo(stdin)

    stdin.write('go tok-123\n')

    await expect(go).resolves.toBe('tok-123')
  })

  it('does nothing when the caller closes its stdin without releasing it', async () => {
    const stdin = new PassThrough()
    const go = waitForGo(stdin)

    stdin.end()

    await expect(go).resolves.toBeUndefined()
  })
})

describe('the armed helper process', () => {
  const RECORDER = [
    "import fs from 'node:fs'",
    "let got = ''",
    "process.stdin.on('data', chunk => (got += chunk))",
    "process.stdin.on('end', () => fs.writeFileSync(process.env.LAND_OUT, JSON.stringify({ argv: process.argv.slice(2), got })))",
  ].join('\n')

  async function armRecorder(over: Partial<RemoteLaunch> = {}) {
    fs.mkdirSync(path.join(callerHome, 'agents', SPEC.agentId), { recursive: true })
    const script = path.join(cwd, 'recorder.mjs')
    const out = path.join(cwd, 'out.json')
    fs.writeFileSync(script, RECORDER)
    const armed = await armHelper(
      { cliEntry: script, cwd, env: { ...process.env, LAND_OUT: out } },
      { ...SPEC, anchor: ANCHOR, ...over },
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

    expect(armed.go('tok-123')).toBe(true)

    expect(await settle(out)).toEqual({
      argv: ['teleport-land', SPEC.agentId, '--pid=4321', '--surface=iterm-tab', `--anchor=${ANCHOR}`],
      got: 'go tok-123\n',
    })
  })

  it('is told to launch at once for a successor-first spec (CC-951)', async () => {
    const { armed, out } = await armRecorder({ successorFirst: true })

    armed.go('tok-123')

    expect(await settle(out)).toMatchObject({ argv: expect.arrayContaining(['--now']) })
  })

  it('never hears go once disarmed', async () => {
    const { armed, out } = await armRecorder()

    armed.abandon()
    await new Promise(resolve => setTimeout(resolve, 300))

    expect(fs.existsSync(out)).toBe(false)
  })
})

describe('arming the helper when its inputs have gone missing (CC-1051)', () => {
  const CWD_PROBE = [
    "import fs from 'node:fs'",
    'fs.writeFileSync(process.env.LAND_OUT, process.cwd())',
  ].join('\n')

  function probeLocal(over: Partial<Parameters<typeof armHelper>[0]> = {}) {
    fs.mkdirSync(path.join(callerHome, 'agents', SPEC.agentId), { recursive: true })
    const script = path.join(cwd, 'probe.mjs')
    const out = path.join(cwd, 'cwd-out.txt')
    fs.writeFileSync(script, CWD_PROBE)
    return { out, local: { cliEntry: script, cwd, env: { ...process.env, LAND_OUT: out }, ...over } }
  }

  const landLog = () => fs.readFileSync(path.join(callerHome, 'agents', SPEC.agentId, 'land.log'), 'utf8')

  it('falls back to the home dir and says which cwd was missing', async () => {
    const gone = path.join(cwd, 'renamed-away')
    const { out, local } = probeLocal({ cwd: gone })

    const armed = await armHelper(local, SPEC, 4321)
    armed.go('tok')
    await new Promise(resolve => setTimeout(resolve, 500))

    expect(fs.realpathSync(fs.readFileSync(out, 'utf8'))).toBe(fs.realpathSync(os.homedir()))
    expect(landLog()).toContain(`cwd ${gone}`)
  })

  it('names the command when the node binary is missing, instead of a bare ENOENT', async () => {
    const node = path.join(cwd, 'no-such-node')
    const { local } = probeLocal({ node })

    await expect(armHelper(local, SPEC, 4321)).rejects.toThrow(`command ${node}`)
  })

  it('names the entry script when it is missing', async () => {
    const entry = path.join(cwd, 'no-such-entry.mjs')
    const { local } = probeLocal({ cliEntry: entry })

    await expect(armHelper(local, SPEC, 4321)).rejects.toThrow(`command ${entry}`)
  })

  it('runs in the caller cwd and writes no note when both are present', async () => {
    const { out, local } = probeLocal()

    const armed = await armHelper(local, SPEC, 4321)
    armed.go('tok')
    await new Promise(resolve => setTimeout(resolve, 500))

    expect(fs.realpathSync(fs.readFileSync(out, 'utf8'))).toBe(fs.realpathSync(cwd))
    expect(landLog()).toBe('')
  })
})
