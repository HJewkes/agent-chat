import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { readLaunchPlan } from '../agents/launch-files.js'
import { transcriptPath } from '../agents/transcript.js'
import type { AccountUsage } from '../agents/account-budget.js'
import { DEFAULT_ROTATION, type RotationConfig } from '../agents/account-rotation.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-1546: a worker spawn bills the account with the most fresh seven_day headroom, and
 * a coordinator, a resumed session or a fix round keeps its own.
 * `account-rotation.test.ts` pins the pick; this file proves the spawn path uses it.
 */

const tmpDirs: string[] = []
let core: BrokerCore
let stopAutoAttach: () => void
let realHome: string | undefined
let readingsRead: number

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const liveChild = () => ({ pid: 4242, unref: () => undefined, once: () => undefined })

function account(name: string): string {
  const dir = path.join(process.env.HOME as string, '.claude-profiles', name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const usage = (name: string, usedPct: number, stale = false): AccountUsage => ({
  account: name,
  config_dir: account(name),
  source: 'usage-poller',
  five_hour: null,
  seven_day: { used_pct: usedPct },
  age_seconds: stale ? 3600 : 60,
  stale,
  auth_fail: false,
})

function supervisorWith(readings: () => AccountUsage[], config: RotationConfig = DEFAULT_ROTATION) {
  return new Supervisor(core, {
    surface: { platform: 'linux', spawn: liveChild },
    accountRotation: {
      config: () => config,
      readings: () => {
        readingsRead++
        return readings()
      },
    },
  })
}

const spawnReq = (over: Record<string, unknown> = {}) => ({
  name: 'scout',
  profile: 'explorer',
  brief: 'read the log',
  requestedBy: 'human',
  cwd: tmp('agent-chat-ws-'),
  isolation: 'none' as const,
  surface: 'headless' as const,
  spawnerConfigDir: account('alpha'),
  ...over,
})

const spawnMeta = (agentId: string | undefined) =>
  core.events.agentEvents().find(row => row.kind === 'agent_spawned' && row.msgId === agentId)?.meta

const childDir = (agentId: string | undefined) => readLaunchPlan(agentId as string).env.CLAUDE_CONFIG_DIR

beforeEach(() => {
  realHome = process.env.HOME
  process.env.HOME = tmp('agent-chat-home-')
  const home = tmp('agent-chat-bus-')
  process.env.AGENT_CHAT_HOME = home
  fs.mkdirSync(path.join(home, 'profiles'))
  fs.writeFileSync(
    path.join(home, 'profiles', 'lead.json'),
    JSON.stringify({
      description: 'lead',
      model: 'sonnet',
      allowedTools: ['Read'],
      isolation: 'none',
      surface: 'headless',
      role: 'coordinator',
    }),
  )
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  stopAutoAttach = autoAttach(core)
  readingsRead = 0
})

afterEach(() => {
  stopAutoAttach()
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('a worker spawn’s account rotation', () => {
  it('runs the worker on the fresh account with the most headroom and records why', async () => {
    const sup = supervisorWith(() => [usage('alpha', 70), usage('beta', 20)])

    const outcome = await sup.spawn(spawnReq())
    sup.close()

    expect(childDir(outcome.agentId)).toBe(account('beta'))
    const meta = spawnMeta(outcome.agentId)
    expect(meta).toMatchObject({ config_dir: account('beta'), config_dir_source: 'rotation' })
    expect(JSON.parse(meta?.account_rotation as string)).toMatchObject({ from: 'alpha', chosen: 'beta' })
    expect(outcome.account).toBe('beta (rotated from alpha; seven_day alpha 70%, beta 20%)')
  })

  it('keeps the spawner’s account when every reading is stale, and still records them', async () => {
    const sup = supervisorWith(() => [usage('alpha', 70, true), usage('beta', 20, true)])

    const outcome = await sup.spawn(spawnReq())
    sup.close()

    expect(childDir(outcome.agentId)).toBe(account('alpha'))
    expect(spawnMeta(outcome.agentId)?.config_dir_source).toBe('spawner')
    expect(outcome.account).toBe('alpha (kept; seven_day alpha stale, beta stale)')
  })

  it('does nothing when the config turns rotation off', async () => {
    const sup = supervisorWith(() => [usage('alpha', 70), usage('beta', 20)], {
      ...DEFAULT_ROTATION,
      enabled: false,
    })

    const outcome = await sup.spawn(spawnReq())
    sup.close()

    expect(childDir(outcome.agentId)).toBe(account('alpha'))
    expect(outcome.account).toBeUndefined()
  })

  it('keeps a coordinator on its spawner’s account', async () => {
    const sup = supervisorWith(() => [usage('alpha', 70), usage('beta', 20)])

    const outcome = await sup.spawn(spawnReq({ profile: 'lead' }))
    sup.close()

    expect(outcome.reason).toBeUndefined()
    expect(childDir(outcome.agentId)).toBe(account('alpha'))
    expect(readingsRead).toBe(0)
  })

  it('keeps a fix round on its spawner’s account', async () => {
    const sup = supervisorWith(() => [usage('alpha', 70), usage('beta', 20)])

    const outcome = await sup.spawn(spawnReq({ workRole: 'fix-round-1' }))
    sup.close()

    expect(childDir(outcome.agentId)).toBe(account('alpha'))
    expect(readingsRead).toBe(0)
  })

  it('keeps a resumed session on the account its transcript lives under', async () => {
    const sup = supervisorWith(() => [usage('alpha', 70), usage('beta', 20)])
    const [cwd, sessionId] = [tmp('resume-cwd-'), '0f8fad5b-d9cb-469f-a165-70867728950e']
    const transcript = transcriptPath(cwd, sessionId, account('alpha'))
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, '{}\n')

    const outcome = await sup.spawn(spawnReq({ cwd, resumeSession: sessionId }))
    sup.close()

    expect(outcome.reason).toBeUndefined()
    expect(childDir(outcome.agentId)).toBe(account('alpha'))
    expect(readingsRead).toBe(0)
  })
})
