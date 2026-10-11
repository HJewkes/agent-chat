import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-168: a spawn that is part of an experiment records the experiment and arm on
 * its `agent_spawned` row, beside `predecessor`, so the session-origin miner can
 * build an arm table from row meta without joining on agent names.
 */

const tmpDirs: string[] = []
let core: BrokerCore
let sup: Supervisor
let stopAutoAttach: () => void

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

const spawnReq = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  profile: 'explorer',
  brief: 'do the task',
  requestedBy: 'human',
  cwd: tmp('exp-cwd-'),
  surface: 'headless' as const,
  spawnerConfigDir: tmp('exp-account-'),
  ...over,
})

const spawnedRows = () => core.events.agentEvents().filter(r => r.kind === 'agent_spawned')

beforeEach(() => {
  const home = tmp('exp-home-')
  process.env.AGENT_CHAT_HOME = home
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
  sup = new Supervisor(core, {
    cwdLister: async () => [],
    surface: {
      platform: 'linux',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
    },
  })
})

afterEach(() => {
  stopAutoAttach()
  sup.close()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('a spawn in an experiment', () => {
  it('records the experiment id and arm on the agent_spawned row', async () => {
    const result = await sup.spawn(spawnReq('worker-a', { experiment: { id: 'E3', arm: 'fresh-successor' } }))

    expect(result.reason).toBeUndefined()
    const row = spawnedRows().find(r => r.msgId === result.agentId)
    expect(row?.meta).toMatchObject({ experiment_id: 'E3', experiment_arm: 'fresh-successor' })
  })

  it('refuses an experiment with an empty arm', async () => {
    const result = await sup.spawn(spawnReq('worker-a', { experiment: { id: 'E3', arm: ' ' } }))

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/experiment needs a non-empty id and arm/)
    expect(spawnedRows()).toHaveLength(0)
  })

  it('writes no experiment fields for a spawn outside one', async () => {
    const result = await sup.spawn(spawnReq('worker-a'))

    const row = spawnedRows().find(r => r.msgId === result.agentId)
    expect(row?.meta).not.toHaveProperty('experiment_id')
    expect(row?.meta).not.toHaveProperty('experiment_arm')
  })
})
