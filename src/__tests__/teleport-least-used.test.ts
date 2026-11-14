import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import { planPath } from '../agents/launch-files.js'
import type { SeatHandoffDeps } from '../agents/teleport.js'
import type { LaunchPlan } from '../agents/types.js'
import type { ServerMessage } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-894: a seat whose seat file declares `account: least-used` hands off to a successor on the
 * least-used account, read at teleport time. The real socket handler and supervisor run; the
 * least-used read is faked, and so are the OS boundaries, `process.kill` and the launch.
 */

const SESSION = '0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7'
const HOST_PID = 9999

const tmpDirs: string[] = []
let realHome: string | undefined
let core: BrokerCore
let server: SocketServer
let stopAutoAttach: () => void
let root: string
let fromDir: string
let toDir: string
let cwd: string
let subjectConn: Conn
let subjectReplies: ServerMessage[]

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function connection(): { conn: Conn; replies: ServerMessage[] } {
  const replies: ServerMessage[] = []
  const write = (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) replies.push(JSON.parse(line) as ServerMessage)
    return true
  }
  return { conn: { write, end: () => undefined } as unknown as Conn, replies }
}

function writeSeat(frontmatter: string): void {
  fs.mkdirSync(path.join(root, 'seats'), { recursive: true })
  fs.writeFileSync(path.join(root, 'seats', 'scout.md'), `---\nprefix: SC\npool: alpha\n${frontmatter}---\n`)
}

function startServer(leastUsed: string | undefined): void {
  const seatTeleport: SeatHandoffDeps = {
    autonomyRoot: root,
    now: () => new Date(),
    shepherd: async () => undefined,
    leastUsedDir: () => leastUsed,
  }
  server = new SocketServer(core, {
    countdownMs: 0,
    seatTeleport,
    argvReader: () => 'claude',
    launcherRunning: async () => false,
    surface: {
      platform: 'darwin',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
      runAppleScript: (script: string) => Promise.resolve(script.includes('is running') ? 'true' : 'pane'),
    },
  })
}

function registerSubject(): void {
  const { conn, replies } = connection()
  subjectConn = conn
  subjectReplies = replies
  server.handleMessage(conn, {
    t: 'register',
    name: 'scout',
    workingOn: 'a seat',
    cwd,
    pid: 111,
    sessionId: SESSION,
    hostPid: HOST_PID,
    host: os.hostname(),
    observed: { configDir: fromDir },
  })
}

async function teleportSelf(): Promise<LaunchPlan & { agentId: string }> {
  server.handleMessage(subjectConn, { t: 'teleport', handoff: 'carry on' })
  const result = await vi.waitFor(() => {
    const found = subjectReplies.find(r => r.t === 'teleport_result')
    if (found === undefined) throw new Error('no teleport_result yet')
    return found as Extract<ServerMessage, { t: 'teleport_result' }>
  })
  expect(result.ok).toBe(true)
  const agentId = result.agentId as string
  const plan = await vi.waitFor(() => JSON.parse(fs.readFileSync(planPath(agentId), 'utf8')) as LaunchPlan, {
    timeout: 5_000,
  })
  return { ...plan, agentId }
}

const spawnMeta = (agentId: string) =>
  core.events.agentEvents().find(r => r.kind === 'agent_spawned' && r.msgId === agentId)?.meta

beforeEach(() => {
  realHome = process.env.HOME
  process.env.HOME = tmp('agent-chat-home-')
  const bus = tmp('agent-chat-bus-')
  process.env.AGENT_CHAT_HOME = bus
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(bus, 'active-work')
  root = tmp('agent-chat-seat-')
  fromDir = tmp('agent-chat-from-')
  toDir = tmp('agent-chat-to-')
  cwd = tmp('agent-chat-cwd-')
  let ended = false
  vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: unknown) => {
    if (pid !== HOST_PID) return true
    if (signal === 0) {
      if (ended) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      return true
    }
    if (!ended) core.drop(subjectConn)
    ended = true
    return true
  })
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(bus, 'events.db')),
    registry: new Registry<Conn>(),
  })
  stopAutoAttach = autoAttach(core)
})

afterEach(() => {
  stopAutoAttach()
  server.close()
  vi.restoreAllMocks()
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  delete process.env.AGENT_CHAT_HOME
  delete process.env.AGENT_CHAT_ACTIVE_WORK_ROOT
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('a teleport of a seat that declares account: least-used', () => {
  // Mutation: keeping the predecessor's config dir starts the successor on the busy account.
  it('starts the successor on the least-used account and marks where it came from', async () => {
    writeSeat('account: least-used\n')
    startServer(toDir)
    registerSubject()

    const plan = await teleportSelf()

    expect(plan.env.CLAUDE_CONFIG_DIR).toBe(toDir)
    expect(spawnMeta(plan.agentId)).toMatchObject({ config_dir: toDir, account_from: fromDir })
  })

  // Mutation: dropping the declares check moves a seat nobody opted in.
  it('keeps a seat that does not declare it on its own account', async () => {
    writeSeat('')
    startServer(toDir)
    registerSubject()

    const plan = await teleportSelf()

    expect(plan.env.CLAUDE_CONFIG_DIR).toBe(fromDir)
    expect(spawnMeta(plan.agentId)?.account_from).toBeUndefined()
  })

  // Mutation: launching on an undefined pick drops CLAUDE_CONFIG_DIR and lands on the default account.
  it('keeps its own account when no account qualifies', async () => {
    writeSeat('account: least-used\n')
    startServer(undefined)
    registerSubject()

    const plan = await teleportSelf()

    expect(plan.env.CLAUDE_CONFIG_DIR).toBe(fromDir)
  })
})
