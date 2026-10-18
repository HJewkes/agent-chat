import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { SupervisorOptions } from '../agents/supervisor.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/**
 * CC-1059 c1, over the socket: a session's host comes from its registration and the CLI's from its
 * frame, the spawn's two reports are taken only from the connection handed the launch, and the
 * placed report is answered after the agent registers.
 */

const REMOTE = 'mac-test-host.invalid'
const MAC_CWD = `/Users/${os.userInfo().username}/projects/proj-a`
const tmpDirs: string[] = []
let core: BrokerCore
let server: SocketServer | undefined

interface Wire {
  frames: ServerMessage[]
  send: (msg: ClientMessage) => void
  next: <T extends ServerMessage['t']>(t: T) => Promise<Extract<ServerMessage, { t: T }>>
}

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function start(over: SupervisorOptions = {}): void {
  server = new SocketServer(core, {
    surface: {
      platform: 'linux',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
    },
    ...over,
  })
}

beforeEach(() => {
  process.env.HOME = tmp('agent-chat-home-')
  const home = tmp('agent-chat-bus-')
  process.env.AGENT_CHAT_HOME = home
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
})

afterEach(() => {
  server?.close()
  server = undefined
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function wire(): Wire {
  const frames: ServerMessage[] = []
  const conn = Object.assign(new EventEmitter(), {
    write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
    end: () => undefined,
  })
  ;(server as SocketServer).onConnection(conn as unknown as Conn)
  const next = async <T extends ServerMessage['t']>(t: T): Promise<Extract<ServerMessage, { t: T }>> => {
    for (let tries = 0; tries < 200; tries++) {
      const index = frames.findIndex(frame => frame.t === t)
      if (index >= 0) return frames.splice(index, 1)[0] as Extract<ServerMessage, { t: T }>
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`no ${t} frame arrived`)
  }
  return { frames, next, send: msg => conn.emit('data', JSON.stringify(msg) + '\n') }
}

type SpawnFrame = Extract<ClientMessage, { t: 'spawn' }>

const spawnFrame = (over: Partial<SpawnFrame> = {}): SpawnFrame => ({
  t: 'spawn',
  name: 'ff-planner',
  profile: 'peer',
  brief: 'plan the draft',
  cwd: MAC_CWD,
  surface: 'iterm-tab',
  hostPlatform: 'darwin',
  launchesHere: true,
  ...over,
})

const rows = (kind: string) => core.events.agentEvents().filter(row => row.kind === kind)
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** A CLI requester on REMOTE, whose spawn the broker hands back to launch there. */
async function remoteSpawn(): Promise<{ cli: Wire; agentId: string }> {
  const cli = wire()
  cli.send(spawnFrame({ callerHost: REMOTE }))
  const result = await cli.next('spawn_result')
  expect(result).toMatchObject({ ok: true, host: REMOTE })
  return { cli, agentId: result.agentId as string }
}

describe("where a spawn's requester runs", () => {
  it("takes a registered session's host from its registration, not the frame", async () => {
    start()
    const session = wire()
    session.send({
      t: 'register',
      name: 'ff-coord',
      workingOn: 'w',
      cwd: MAC_CWD,
      pid: 1,
      host: REMOTE,
      hostPid: 9,
    })
    await session.next('register_result')

    session.send(spawnFrame({ callerHost: os.hostname() }))
    const result = await session.next('spawn_result')

    expect(result).toMatchObject({ ok: true, host: REMOTE })
    expect(result.launch).toMatchObject({ cwd: MAC_CWD, surface: 'iterm-tab', name: 'ff-planner' })
    expect(rows('agent_spawned')[0]?.meta).toMatchObject({ host: REMOTE, site: 'caller' })
  })

  it("reads the CLI's host from its frame, since it holds no registration", async () => {
    start()

    await remoteSpawn()

    expect(rows('agent_spawned')[0]?.meta).toMatchObject({ host: REMOTE, site: 'caller' })
  })

  it('keeps an older client that sends no launchesHere on the broker path', async () => {
    start()
    const cli = wire()

    const older = spawnFrame({ callerHost: REMOTE })
    delete older.launchesHere
    cli.send(older)

    expect(await cli.next('spawn_result')).toMatchObject({
      ok: false,
      reason: `cwd does not exist: ${MAC_CWD}`,
    })
  })
})

describe("the reports on a remote spawn's launch", () => {
  it('refuses a report from a connection other than the requester, and the spawn still expires', async () => {
    start({ remoteReportMs: 100 })
    const { agentId } = await remoteSpawn()
    const stranger = wire()

    stranger.send({ t: 'spawn_launched', agentId, ok: true })
    const refused = await stranger.next('spawn_launched_result')
    stranger.send({ t: 'spawn_placed', agentId, ok: false, reason: 'not mine' })
    const placed = await stranger.next('spawn_placed_result')
    await pause(200)

    expect(refused.ok).toBe(false)
    expect(refused.reason).toContain('not handed the launch')
    expect(placed.ok).toBe(false)
    expect(rows('agent_retired').map(row => row.ref)).toEqual([agentId])
    expect(rows('agent_retired')[0]?.body).toContain('no ready report')
  })

  it('acks ready, and answers placed only after the agent registers', async () => {
    start()
    const { cli, agentId } = await remoteSpawn()

    cli.send({ t: 'spawn_launched', agentId, ok: true })
    expect(await cli.next('spawn_launched_result')).toEqual({ t: 'spawn_launched_result', ok: true })
    cli.send({ t: 'spawn_placed', agentId, ok: true })
    await pause(50)
    expect(cli.frames.map(frame => frame.t)).not.toContain('spawn_placed_result')

    core.append({ kind: 'agent_attached', actor: 'ff-planner', ref: agentId })

    expect(await cli.next('spawn_placed_result')).toMatchObject({ ok: true, agentId, name: 'ff-planner' })
    expect(rows('agent_retired')).toHaveLength(0)
  })

  it('retires the identity when placement fails, and says why', async () => {
    start()
    const { cli, agentId } = await remoteSpawn()
    cli.send({ t: 'spawn_launched', agentId, ok: true })
    await cli.next('spawn_launched_result')

    cli.send({ t: 'spawn_placed', agentId, ok: false, reason: 'iTerm2 is not running' })
    const placed = await cli.next('spawn_placed_result')

    expect(placed).toMatchObject({ ok: false, agentId })
    expect(placed.reason).toContain(`not placed on ${REMOTE}: iTerm2 is not running`)
    expect(rows('agent_retired').map(row => row.ref)).toEqual([agentId])
  })

  it('retires the identity when the requester refuses it on its own host', async () => {
    start()
    const { cli, agentId } = await remoteSpawn()

    cli.send({ t: 'spawn_launched', agentId, ok: false, reason: 'cwd does not exist' })
    const ack = await cli.next('spawn_launched_result')
    cli.send({ t: 'spawn_placed', agentId, ok: true })

    expect(ack.ok).toBe(false)
    expect(ack.reason).toContain(`refused on ${REMOTE}: cwd does not exist`)
    expect((await cli.next('spawn_placed_result')).reason).toContain('not handed the launch')
    expect(rows('agent_retired').map(row => row.ref)).toEqual([agentId])
  })
})
