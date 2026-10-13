import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { readLaunchPlan } from '../agents/launch-files.js'
import { autoAttach } from './broker-harness.js'

/** CC-398: the spawn path lints the caller's brief, and only the caller's brief. */

const tmpDirs: string[] = []
let core: BrokerCore
let sup: Supervisor
let stopAutoAttach: () => void

const tmp = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const spawnReq = (brief: string) => ({
  name: 'builder',
  profile: 'implementer',
  brief,
  requestedBy: 'coord',
  cwd: tmp('brief-lint-ws-'),
  isolation: 'none' as const,
  surface: 'headless' as const,
})

beforeEach(() => {
  const home = tmp('brief-lint-home-')
  process.env.AGENT_CHAT_HOME = home
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
  sup = new Supervisor(core, {
    surface: {
      platform: 'linux',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
    },
    repoVisibility: async () => 'public',
  })
})

afterEach(() => {
  stopAutoAttach()
  sup.close()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('a spawn whose brief asks for a tool the agent cannot use', () => {
  it('is refused with the profile and the tool named', async () => {
    const result = await sup.spawn(spawnReq('Use ScheduleWakeup to check back on CI.'))

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('implementer')
    expect(result.reason).toContain('ScheduleWakeup')
  })
})

describe('a spawn whose brief is clean', () => {
  it("launches though the broker's own return contract names ScheduleWakeup", async () => {
    const result = await sup.spawn(spawnReq('Fix the parser.'))

    expect(result.ok).toBe(true)
    expect(readLaunchPlan(result.agentId as string).stdin).toContain('ScheduleWakeup')
  })

  it('carries the public-repo warning when the brief has no synthetic-data line', async () => {
    const result = await sup.spawn(spawnReq('Fix the parser.'))

    expect(result.warnings?.some(w => w.includes('synthetic-data'))).toBe(true)
  })
})
