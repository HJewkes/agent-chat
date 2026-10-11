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

/**
 * CC-171: session-read finds where the assignment starts in a spawn brief by
 * matching this repo's heading strings, so a heading rename silently unlinks the
 * task. The spawn row records the injected block's length instead.
 */

const tmpDirs: string[] = []
let core: BrokerCore
let sup: Supervisor
let stopAutoAttach: () => void

const tmp = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const spawnReq = (over: Record<string, unknown> = {}) => ({
  name: 'scout',
  profile: 'explorer',
  brief: 'review the parser',
  requestedBy: 'human',
  cwd: tmp('briefing-chars-ws-'),
  isolation: 'none' as const,
  surface: 'headless' as const,
  ...over,
})

const spawnRow = (agentId: string) =>
  core.events.agentEvents().find(r => r.kind === 'agent_spawned' && r.msgId === agentId)

beforeEach(() => {
  const home = tmp('briefing-chars-home-')
  process.env.AGENT_CHAT_HOME = home
  const root = tmp('briefing-chars-aw-')
  fs.mkdirSync(path.join(root, 'widgets'))
  fs.writeFileSync(path.join(root, 'widgets', 'brief.md'), '# Widgets\n\nWhy: to prove orientation lands.\n')
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = root
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
  sup = new Supervisor(core, {
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
  delete process.env.AGENT_CHAT_ACTIVE_WORK_ROOT
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the agent_spawned row of a briefed spawn', () => {
  it("records the injected orientation length so the delivered brief's assignment starts right after it", async () => {
    const result = await sup.spawn(spawnReq({ briefing: 'widgets' }))

    expect(result.ok).toBe(true)
    const delivered = readLaunchPlan(result.agentId as string).stdin ?? ''
    const briefingChars = Number(spawnRow(result.agentId as string)?.meta.briefing_chars)
    expect(briefingChars).toBeGreaterThan(0)
    expect(delivered.indexOf('\n\nreview the parser')).toBe(briefingChars)
  })

  it('records no briefing_chars when the spawn had no briefing', async () => {
    const result = await sup.spawn(spawnReq())

    expect(result.ok).toBe(true)
    expect(spawnRow(result.agentId as string)?.meta).not.toHaveProperty('briefing_chars')
  })
})
