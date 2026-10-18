import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentProfile } from '../agents/types.js'
import type { ClientMessage, RemoteLaunch, ServerMessage } from '../protocol.js'
import { requestSpawn } from '../server/caller-spawn.js'
import type { SpawnHost } from '../server/remote-launch.js'

/**
 * CC-1059 c2: the requester's half of a spawn the broker hands back to launch on the requester's
 * own host. The broker is a scripted fake and the host's writer, surface and discard are fakes that
 * log into one ordered trail, so the order of check, write, report, ack and launch is observable.
 */

let root: string
let homeDir: string
let workspace: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-spawn-remote-')))
  homeDir = path.join(root, 'home')
  workspace = path.join(homeDir, 'projects', 'proj-a')
  fs.mkdirSync(workspace, { recursive: true })
  process.env.AGENT_CHAT_HOME = path.join(root, 'agent-chat')
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(root, { recursive: true, force: true })
})

const AGENT_ID = 'abcd1234'

const launch = (over: Partial<RemoteLaunch> = {}): RemoteLaunch => ({
  agentId: AGENT_ID,
  sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  name: 'ff-planner',
  profile: {
    name: 'bd-planner',
    description: 'd',
    model: 'opus',
    allowedTools: [],
    isolation: 'none',
    surface: 'headless',
    promptPrelude: '',
  },
  brief: 'plan the draft',
  preamble: '',
  surface: 'iterm-tab',
  cwd: workspace,
  configDirUnset: true,
  ...over,
})

const LOCAL_PROFILE: AgentProfile = {
  name: 'bd-planner',
  description: 'local copy',
  model: 'opus',
  allowedTools: [],
  isolation: 'none',
  surface: 'headless',
  promptPrelude: '',
}

type Replies = Partial<Record<ClientMessage['t'], ServerMessage | Error>>

function fakeBroker(trail: string[], replies: Replies) {
  return {
    request: async (frame: ClientMessage) => {
      trail.push('ok' in frame ? `${frame.t} ${String(frame.ok)}` : frame.t)
      const reply = replies[frame.t]
      if (reply === undefined) throw new Error(`no reply scripted for ${frame.t}`)
      if (reply instanceof Error) throw reply
      return reply
    },
  }
}

function fakeHost(trail: string[], over: Partial<SpawnHost> = {}): SpawnHost {
  return {
    cliEntry: '/mac/agent-chat/dist/cli.js',
    homeDir,
    loadProfile: () => LOCAL_PROFILE,
    writeFiles: () => void trail.push('write'),
    launch: async surface => void trail.push(`launch ${surface}`),
    discard: () => void trail.push('discard'),
    ...over,
  }
}

const SPAWN: Extract<ClientMessage, { t: 'spawn' }> = {
  t: 'spawn',
  name: 'ff-planner',
  profile: 'bd-planner',
  brief: 'plan the draft',
  launchesHere: true,
}

const pending = (spec: RemoteLaunch = launch()): ServerMessage => ({
  t: 'spawn_result',
  ok: true,
  agentId: AGENT_ID,
  name: 'ff-planner',
  host: 'mac',
  launch: spec,
  warnings: ['dist is older than src'],
})

const placed: ServerMessage = { t: 'spawn_placed_result', ok: true, agentId: AGENT_ID, name: 'ff-planner' }

describe('a spawn the broker hands back to launch on this host', () => {
  it('writes, reports ready, launches only after the ack, then reports placed', async () => {
    const trail: string[] = []
    const broker = fakeBroker(trail, {
      spawn: pending(),
      spawn_launched: { t: 'spawn_launched_result', ok: true },
      spawn_placed: placed,
    })

    const res = await requestSpawn(broker, SPAWN, fakeHost(trail))

    expect(trail).toEqual(['spawn', 'write', 'spawn_launched true', 'launch iterm-tab', 'spawn_placed true'])
    expect(res).toMatchObject({
      ok: true,
      agentId: AGENT_ID,
      host: 'mac',
      warnings: ['dist is older than src'],
    })
    expect(res).not.toHaveProperty('launch')
  })

  it('never opens the surface when the broker refuses the ready report, and removes the files', async () => {
    const trail: string[] = []
    const broker = fakeBroker(trail, {
      spawn: pending(),
      spawn_launched: { t: 'spawn_launched_result', ok: false, reason: 'report window passed' },
    })

    const res = await requestSpawn(broker, SPAWN, fakeHost(trail))

    expect(trail).toEqual(['spawn', 'write', 'spawn_launched true', 'discard'])
    expect(res).toMatchObject({ ok: false })
    expect(res.reason).toContain('report window passed')
  })

  it('treats a lost ready report as refused, launching nothing', async () => {
    const trail: string[] = []
    const broker = fakeBroker(trail, { spawn: pending(), spawn_launched: new Error('broker went away') })

    const res = await requestSpawn(broker, SPAWN, fakeHost(trail))

    expect(trail).not.toContain('launch iterm-tab')
    expect(res.ok).toBe(false)
  })

  it('reports a failed placement and answers Not spawned rather than Spawned', async () => {
    const trail: string[] = []
    const broker = fakeBroker(trail, {
      spawn: pending(),
      spawn_launched: { t: 'spawn_launched_result', ok: true },
      spawn_placed: {
        t: 'spawn_placed_result',
        ok: false,
        agentId: AGENT_ID,
        reason: 'iTerm2 is not running',
      },
    })
    const host = fakeHost(trail, {
      launch: async () => {
        throw new Error('iTerm2 is not running')
      },
    })
    const sent: ClientMessage[] = []
    const recording = {
      request: async (frame: ClientMessage) => (sent.push(frame), broker.request(frame)),
    }

    const res = await requestSpawn(recording, SPAWN, host)

    expect(sent.find(f => f.t === 'spawn_placed')).toMatchObject({
      ok: false,
      reason: 'iTerm2 is not running',
    })
    expect(res).toMatchObject({ ok: false, reason: 'iTerm2 is not running' })
  })

  it('reports a local check refusal as not ready and writes nothing', async () => {
    const trail: string[] = []
    const broker = fakeBroker(trail, {
      spawn: pending(launch({ cwd: path.join(homeDir, 'projects', 'not-here') })),
      spawn_launched: { t: 'spawn_launched_result', ok: false, reason: 'refused on the requester' },
    })

    const res = await requestSpawn(broker, SPAWN, fakeHost(trail))

    expect(trail).toEqual(['spawn', 'spawn_launched false'])
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('cwd does not exist')
  })

  it('answers a broker-site spawn as the broker did, launching nothing here', async () => {
    const trail: string[] = []
    const done: ServerMessage = { t: 'spawn_result', ok: true, agentId: AGENT_ID, name: 'ff-planner' }

    const res = await requestSpawn(fakeBroker(trail, { spawn: done }), SPAWN, fakeHost(trail))

    expect(trail).toEqual(['spawn'])
    expect(res).toEqual(done)
  })
})
