import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SpawnFn } from '@titan-design/agent-surface'
import { autoAttach } from './broker-harness.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import type { LaunchIntegrity } from '../agents/launch-files.js'
import { Supervisor } from '../agents/supervisor.js'
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
