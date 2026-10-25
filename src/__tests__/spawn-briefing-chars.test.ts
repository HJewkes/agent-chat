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
  fs.mkdirSync(path.join(root, 'widgets', 'tasks'))
  fs.writeFileSync(path.join(root, 'widgets', 'tasks', 'XX-1.yml'), 'id: XX-1\ntitle: Hum louder\nstatus: open\n')
  fs.mkdirSync(path.join(root, 'widgets', 'sessions'))
  fs.writeFileSync(path.join(root, 'widgets', 'sessions', '2026-07-31-latest.md'), 'Hummed yesterday.\n')
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

/** CC-1596: an implementer is handed one task, so the initiative-wide sections are coordinator context. */
describe('the orientation a briefed spawn receives, by profile contract', () => {
  const deliveredTo = async (profile: string): Promise<string> => {
    const result = await sup.spawn(spawnReq({ profile, requestedBy: 'coord', briefing: 'widgets' }))
    expect(result.ok).toBe(true)
    return readLaunchPlan(result.agentId as string).stdin ?? ''
  }

  // Mutation caught: scoping every spawn 'full' in supervisor.briefingFor.
  it('leaves the brief, open tasks and latest session out for an implementer', async () => {
    const delivered = await deliveredTo('implementer')

    expect(delivered).toContain('# Orientation: active-work initiative "widgets"')
    expect(delivered).toContain('review the parser')
    expect(delivered).not.toContain('Why: to prove orientation lands.')
    expect(delivered).not.toContain('XX-1: Hum louder')
    expect(delivered).not.toContain('Hummed yesterday.')
  })

  // Mutation caught: scoping every spawn 'implementer' in supervisor.briefingFor.
  it('keeps every section for a planner', async () => {
    const delivered = await deliveredTo('planner')

    expect(delivered).toContain('Why: to prove orientation lands.')
    expect(delivered).toContain('XX-1: Hum louder')
    expect(delivered).toContain('Hummed yesterday.')
  })
})
