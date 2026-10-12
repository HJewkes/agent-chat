import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor, type SpawnRequest } from '../agents/supervisor.js'
import { agentDir } from '../paths.js'

/**
 * CC-1059 b: a spawn from a requester on another host is recorded here and launched there. The
 * broker never checks that host's cwd on its own disk, picks the surface by the requester's OS,
 * and retires the identity, freeing its slot, whenever the launch is refused, fails or goes quiet.
 */

const CALLER = 'mac-test-host'
const MAC_CWD = `/Users/${os.userInfo().username}/projects/fantasy-football`
const tmpDirs: string[] = []
let core: BrokerCore
let supervisor: Supervisor

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const liveChild = () => ({ pid: 4242, unref: () => undefined, once: () => undefined })

function start(over: { remoteReportMs?: number; attachMs?: number; attachCeilingMs?: number } = {}): void {
  supervisor = new Supervisor(core, { surface: { platform: 'linux', spawn: liveChild }, ...over })
}

beforeEach(() => {
  process.env.HOME = tmp('agent-chat-home-')
  const home = tmp('agent-chat-bus-')
  process.env.AGENT_CHAT_HOME = home
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  start()
})

afterEach(() => {
  supervisor?.close()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const remoteReq = (over: Partial<SpawnRequest> = {}): SpawnRequest => ({
  name: 'ff-planner',
  profile: 'peer',
  brief: 'plan the draft',
  requestedBy: 'human',
  cwd: MAC_CWD,
  surface: 'iterm-tab',
  callerHost: CALLER,
  hostPlatform: 'darwin',
  launchesHere: true,
  ...over,
})

const rows = (kind: string) => core.events.agentEvents().filter(row => row.kind === kind)
const attach = (agentId: string): void =>
  void core.append({ kind: 'agent_attached', actor: 'ff-planner', ref: agentId })
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('a spawn whose requester runs on another host', () => {
  it('is recorded and handed back to launch there, never checked against this disk', async () => {
    const outcome = await supervisor.spawn(remoteReq())

    expect(outcome).toMatchObject({ ok: true, host: CALLER })
    expect(outcome.launch).toMatchObject({ cwd: MAC_CWD, surface: 'iterm-tab', name: 'ff-planner' })
    expect(outcome.launch?.configDirUnset ?? outcome.launch?.configDir).toBeDefined()
    expect(outcome.launch?.profile).not.toHaveProperty('env')
    const spawned = rows('agent_spawned')
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.meta).toMatchObject({ host: CALLER, site: 'caller', cwd: MAC_CWD })
    expect(fs.existsSync(agentDir(outcome.agentId as string))).toBe(false)
  })

  it('names the account against the requester home, never the broker environment', async () => {
    const own = `/Users/${os.userInfo().username}/.claude-profiles/agents`
    process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'broker-only-account')

    const carried = await supervisor.spawn(remoteReq({ spawnerConfigDir: own }))
    const unset = await supervisor.spawn(remoteReq({ name: 'ff-two' }))
    delete process.env.CLAUDE_CONFIG_DIR

    expect(carried.launch).toMatchObject({ configDir: own })
    expect(unset.launch).toMatchObject({ configDirUnset: true })
    expect(unset.launch).not.toHaveProperty('configDir')
  })

  it('picks the surface by the requester OS and refuses an explicit one that OS cannot run', async () => {
    const linux = await supervisor.spawn(
      remoteReq({ surface: undefined, hostPlatform: 'linux', cwd: '/home/x/ff', callerHome: '/home/x' }),
    )
    expect(linux.launch?.surface).toBe('tmux-window')

    const refused = await supervisor.spawn(
      remoteReq({ name: 'ff-two', hostPlatform: 'linux', cwd: '/home/x/ff', callerHome: '/home/x' }),
    )
    expect(refused).toMatchObject({ ok: false, code: 'surface_refused' })
    expect(refused.reason).toContain('iTerm2 surfaces need macOS')
    expect(rows('agent_spawned').map(row => row.target)).toEqual(['ff-planner'])
  })

  it.each<[string, Partial<SpawnRequest>]>([
    ['worktree isolation', { isolation: 'worktree' }],
    ['inherit: context', { inherit: 'context' }],
    ['resume_session', { resumeSession: '00000000-0000-4000-8000-000000000000' }],
    ['owns', { owns: ['src/**'] }],
  ])('refuses %s, naming the broker host, without a row or a slot', async (_label, over) => {
    const outcome = await supervisor.spawn(remoteReq(over))

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain(`name host ${os.hostname()}`)
    expect(rows('agent_spawned')).toHaveLength(0)
    expect(supervisor.slotIds()).toEqual([])
  })

  it('refuses a cwd outside the requester home by the lexical policy alone', async () => {
    const outcome = await supervisor.spawn(remoteReq({ cwd: `/Users/${os.userInfo().username}/.ssh/keys` }))

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('protected directory')
  })

  it('keeps an older client, which cannot launch on its own host, on the broker path', async () => {
    const outcome = await supervisor.spawn(remoteReq({ launchesHere: undefined }))

    expect(outcome).toMatchObject({ ok: false, reason: `cwd does not exist: ${MAC_CWD}` })
  })

  it('routes a named host: an unknown one is refused naming the machines, the broker host launches here', async () => {
    const unknown = await supervisor.spawn(remoteReq({ host: 'nowhere' }))
    expect(unknown.ok).toBe(false)
    expect(unknown.reason).toContain('unknown machine "nowhere"; known machines:')
    expect(unknown.reason).toContain(CALLER)

    const here = await supervisor.spawn(remoteReq({ host: os.hostname() }))
    expect(here.reason).toBe(`cwd does not exist: ${MAC_CWD}`)
  })
})

describe('the reports that follow a remote spawn', () => {
  it('retires the identity and frees its slot when no ready report arrives', async () => {
    supervisor.close()
    start({ remoteReportMs: 20 })
    const { agentId } = await supervisor.spawn(remoteReq())
    expect(supervisor.slotIds()).toEqual([agentId])

    await pause(60)

    expect(rows('agent_retired').map(row => row.ref)).toEqual([agentId])
    expect(rows('agent_retired')[0]?.body).toContain(`spawn not launched on ${CALLER}: no ready report`)
    expect(supervisor.slotIds()).toEqual([])
    expect(supervisor.remoteSpawnReady(agentId as string, { ok: true }).ok).toBe(false)
  })

  it('acks a ready report and answers placed once the agent registers, keeping its slot', async () => {
    const { agentId } = await supervisor.spawn(remoteReq())
    const id = agentId as string

    expect(supervisor.remoteSpawnReady(id, { ok: true })).toEqual({ ok: true })
    const placed = supervisor.remoteSpawnPlaced(id, { ok: true })
    attach(id)

    expect(await placed).toMatchObject({ ok: true, agentId: id, name: 'ff-planner' })
    expect(supervisor.slotIds()).toEqual([id])
    expect(rows('agent_retired')).toHaveLength(0)
  })

  it('reads an attach that lands before the placed report', async () => {
    const { agentId } = await supervisor.spawn(remoteReq())
    const id = agentId as string
    supervisor.remoteSpawnReady(id, { ok: true })
    attach(id)

    expect(await supervisor.remoteSpawnPlaced(id, { ok: true })).toMatchObject({ ok: true, agentId: id })
  })

  it('retires a spawn its requester refused before writing anything', async () => {
    const { agentId } = await supervisor.spawn(remoteReq())

    const reply = supervisor.remoteSpawnReady(agentId as string, {
      ok: false,
      reason: 'cwd does not exist on mac',
    })

    expect(reply.ok).toBe(false)
    expect(rows('agent_retired')[0]?.body).toContain('cwd does not exist on mac')
    expect(supervisor.slotIds()).toEqual([])
  })

  it('retires a spawn whose surface failed to open, carrying the reason back', async () => {
    const { agentId } = await supervisor.spawn(remoteReq())
    const id = agentId as string
    supervisor.remoteSpawnReady(id, { ok: true })

    const placed = await supervisor.remoteSpawnPlaced(id, { ok: false, reason: 'osascript denied' })

    expect(placed).toMatchObject({ ok: false, agentId: id })
    expect(placed.reason).toContain('osascript denied')
    expect(rows('agent_retired').map(row => row.ref)).toEqual([id])
    expect(supervisor.slotIds()).toEqual([])
  })

  it('retires a placed spawn that never registers within the ceiling', async () => {
    supervisor.close()
    start({ attachMs: 10, attachCeilingMs: 40 })
    const { agentId } = await supervisor.spawn(remoteReq())
    const id = agentId as string
    supervisor.remoteSpawnReady(id, { ok: true })

    const placed = await supervisor.remoteSpawnPlaced(id, { ok: true })
    expect(placed.ok).toBe(true)
    expect(placed.warnings?.[0]).toContain('still starting')
    await pause(80)

    expect(rows('agent_retired')[0]?.body).toContain('placement unconfirmed')
    expect(supervisor.slotIds()).toEqual([])
  })
})
