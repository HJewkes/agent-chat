import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpawnFn } from '@titan-design/agent-surface'
import { autoAttach } from './broker-harness.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import type { LaunchIntegrity, LaunchLineage } from '../agents/launch-files.js'
import { RELAUNCH_RETRY_MS, Supervisor } from '../agents/supervisor.js'
import type { Mismatch } from '../leak-guard/integrity/record.js'

/**
 * TP-4256 A3: the broker refuses to start a quarantined launch itself, rather than trusting the
 * agent-writable relaunch script to call run-agent's check. Paths and names are synthetic.
 */

const tmpDirs: string[] = []
let core: BrokerCore
let stopAutoAttach: () => void
let supervisor: Supervisor | undefined
let spawned: number

const countingSpawn: SpawnFn = () => {
  spawned += 1
  return { pid: 4242, unref: () => undefined, once: () => undefined }
}

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** A port whose every launch reads as quarantined once `quarantine` is set. */
function port(quarantine: Mismatch | undefined): LaunchIntegrity {
  return { retire: () => undefined, register: () => undefined, quarantineOf: () => quarantine }
}

beforeEach(() => {
  spawned = 0
  const dir = tmpDir('agent-chat-quarantined-')
  process.env.AGENT_CHAT_HOME = dir
  process.env.CLAUDE_CONFIG_DIR = tmpDir('agent-chat-cfg-')
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
  core.register({} as unknown as net.Socket, {
    t: 'register',
    name: 'coordinator',
    workingOn: '',
    cwd: dir,
    pid: 1,
  })
  stopAutoAttach = autoAttach(core)
})

afterEach(() => {
  stopAutoAttach()
  supervisor?.close()
  delete process.env.AGENT_CHAT_HOME
  delete process.env.CLAUDE_CONFIG_DIR
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const spawnWith = (integrity: LaunchIntegrity) => {
  supervisor = new Supervisor(core, { surface: { platform: 'linux', spawn: countingSpawn }, integrity })
  return supervisor.spawn({
    name: 'scout',
    profile: 'explorer',
    brief: 'find every caller of foo()',
    requestedBy: 'coordinator',
    isolation: 'none',
    surface: 'headless',
    cwd: tmpDir('agent-chat-ws-'),
  })
}

describe('a launch the broker holds as quarantined', () => {
  it('is never handed to a surface', async () => {
    const result = await spawnWith(port({ file: '/state/agents/a/relaunch', field: 'sha256' }))

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/this launch is quarantined: \/state\/agents\/a\/relaunch changed/)
    expect(spawned).toBe(0)
  })

  it('starts as before when the launch is not quarantined', async () => {
    const result = await spawnWith(port(undefined))

    expect(result.reason).toBeUndefined()
    expect(spawned).toBe(1)
  })
})

const MISMATCH: Mismatch = { file: '/state/rc/.zshrc', field: 'sha256' }

/** The broker's carry-forward rule, in memory: a launch whose lineage is quarantined is registered quarantined. */
function carryingPort(quarantined: string[]) {
  const held = new Map<string, Mismatch>(quarantined.map(id => [id, MISMATCH]))
  const lineages: Record<string, LaunchLineage> = {}
  const port: LaunchIntegrity = {
    retire: () => undefined,
    register: (_nonce, agentId, _startup, _files, lineage) => {
      lineages[agentId] = lineage
      const inherited = lineage.humanResume ? undefined : [agentId, ...lineage.from].find(id => held.has(id))
      if (inherited === undefined) held.delete(agentId)
      else held.set(agentId, MISMATCH)
    },
    quarantineOf: agentId => held.get(agentId),
  }
  return { port, lineages }
}

const successor = (meta: Record<string, string>): Parameters<Supervisor['relaunch']>[0] => ({
  agentId: 'agsucc01',
  name: 'scout',
  profile: {
    name: 'inherited',
    description: '',
    model: '',
    allowedTools: [],
    isolation: 'none',
    surface: 'headless',
    promptPrelude: '',
  },
  brief: 'carry on',
  cwd: tmpDir('agent-chat-succ-'),
  surface: 'headless',
  preamble: 'you are the continuation',
  meta,
})

describe('the lineage each broker launch registers with', () => {
  it('names the spawning agent on a spawn', async () => {
    const { port, lineages } = carryingPort([])
    supervisor = new Supervisor(core, {
      surface: { platform: 'linux', spawn: countingSpawn },
      integrity: port,
    })

    const result = await supervisor.spawn({
      name: 'scout',
      profile: 'explorer',
      brief: 'find every caller of foo()',
      requestedBy: 'human',
      parentAgentId: 'agparent',
      isolation: 'none',
      surface: 'headless',
      cwd: tmpDir('agent-chat-ws-'),
    })

    expect(Object.values(lineages)).toEqual([{ from: ['agparent'] }])
    expect(result.agentId === undefined || lineages[result.agentId] !== undefined).toBe(true)
  })

  // Mutation caught: a successor registered with no lineage, which teleports a quarantined agent clean.
  it('never starts the teleport successor of a quarantined agent, and says so instead of naming its script', async () => {
    // Nothing attaches: a successor that never started must not look as if it registered.
    stopAutoAttach()
    stopAutoAttach = () => undefined
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const { port, lineages } = carryingPort(['agpred01'])
    supervisor = new Supervisor(core, {
      surface: { platform: 'linux', spawn: countingSpawn },
      integrity: port,
      launcherRunning: async () => false,
    })

    try {
      const relaunching = supervisor.relaunch(successor({ teleport_from: 'agpred01' }))
      const settled = expect(relaunching).rejects.toThrow(
        /this launch is quarantined: \/state\/rc\/\.zshrc changed/,
      )
      await vi.advanceTimersByTimeAsync(RELAUNCH_RETRY_MS * 3)
      await settled
    } finally {
      vi.useRealTimers()
    }

    const notice = core.events.history(50).find(row => row.kind === 'notice' && row.text.includes('scout'))
    expect(lineages.agsucc01).toEqual({ from: ['agpred01'] })
    expect(spawned).toBe(0)
    expect(notice?.text).toMatch(/this launch is quarantined: \/state\/rc\/\.zshrc changed/)
    expect(notice?.text).not.toMatch(/in a terminal to start it/)
  })
})
