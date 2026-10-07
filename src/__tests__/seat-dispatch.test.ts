import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { seatDispatchLog, type SeatDispatchLog } from '../agents/seats/dispatch-log.js'
import { readDispatches } from '../agents/seats/dispatch-read.js'
import { identityTranscript } from '../agents/resume-session.js'
import { Supervisor } from '../agents/supervisor.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { openServices } from '../broker/daemon.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import type { ServerMessage } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-331: the broker appends a seat agent's dispatched row at a verified spawn and
 * its retired row, with the spend, after a retire. Every seat, prefix, task id and
 * repository here is synthetic, and the autonomy root is a temp directory.
 */

const SEAT = 'seat-x'
const AGENT = 'sx-ab-12-fix'
const AT = new Date('2026-02-03T04:05:00.000Z')
const PR = 'https://github.com/example-org/widget/pull/7'
const MODEL = 'claude-opus-5-5'

const tmpDirs: string[] = []
let root: string
let core: BrokerCore
let sup: Supervisor | undefined
let stopAutoAttach: () => void

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

function autonomyRoot(): string {
  const dir = tmp('dispatch-root-')
  fs.mkdirSync(path.join(dir, 'seats'))
  fs.writeFileSync(path.join(dir, 'seats', `${SEAT}.md`), '---\nprefix: sx\npool: pool-a\n---\n')
  return dir
}

const writerOver = (dir: string): SeatDispatchLog =>
  seatDispatchLog(dir, { now: () => AT, log: () => undefined, activeWork: tmp('dispatch-aw-') })

const logFile = (): string => path.join(root, 'logs', SEAT, 'dispatch.jsonl')

const rows = (): Record<string, unknown>[] =>
  fs.existsSync(logFile())
    ? fs
        .readFileSync(logFile(), 'utf8')
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line) as Record<string, unknown>)
    : []

const dispatchedRows = (): Record<string, unknown>[] => rows().filter(row => row.outcome === 'dispatched')

const retiredRows = (): Record<string, unknown>[] => rows().filter(row => row.outcome === 'retired')

function supervisorWith(seatDispatch: SeatDispatchLog, attachMs?: number): Supervisor {
  sup = new Supervisor(core, {
    ...(attachMs === undefined ? {} : { attachMs }),
    surface: {
      platform: 'linux',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
    },
    seatDispatch,
  })
  return sup
}

const spawnReq = (name: string) => ({
  name,
  profile: 'explorer',
  brief: 'do the task',
  requestedBy: 'human',
  cwd: tmp('dispatch-ws-'),
  isolation: 'none' as const,
  surface: 'headless' as const,
  spawnerConfigDir: tmp('dispatch-account-'),
})

/** A hand-built transcript at the path retire reads, with two requests, invented ids and any `extra` records. */
function writeTranscript(name: string, model = MODEL, extra: object[] = []): void {
  const identity = core.agents.byName(name)
  if (identity === undefined) throw new Error(`no identity for ${name}`)
  const file = identityTranscript(identity).path
  const request = (id: string, input: number, output: number) => ({
    type: 'assistant',
    timestamp: AT.toISOString(),
    message: { id, model, role: 'assistant', usage: { input_tokens: input, output_tokens: output } },
  })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lines = [request('msg-1', 100, 20), ...extra, request('msg-2', 300, 80)]
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
}

const HEAD = '0123456789abcdef0123456789abcdef01234567'

const failedTool = {
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: true, content: 'exit 1' }] },
}

const reportTo = (to: string, text: string) => ({
  type: 'assistant',
  message: {
    content: [{ type: 'tool_use', id: 'tu-2', name: 'mcp__agent-chat__chat_send', input: { to, text } }],
  },
})

beforeEach(() => {
  root = autonomyRoot()
  const home = tmp('dispatch-home-')
  process.env.AGENT_CHAT_HOME = home
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
})

afterEach(() => {
  vi.useRealTimers()
  stopAutoAttach()
  sup?.close()
  sup = undefined
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('a seat agent’s spawn', () => {
  it('writes one dispatched row with the time, task, profile and agent', async () => {
    const spawned = await supervisorWith(writerOver(root)).spawn(spawnReq(AGENT))

    expect(spawned.reason).toBeUndefined()
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({
      outcome: 'dispatched',
      ts: AT.toISOString(),
      task: 'AB-12',
      profile: 'explorer',
      agent: AGENT,
      agent_id: spawned.agentId,
      spawner: 'human',
      by: 'broker',
    })
  })

  it('writes nothing for a spawn whose agent never attaches', async () => {
    vi.useFakeTimers()
    stopAutoAttach()

    const spawning = supervisorWith(writerOver(root), 1000).spawn(spawnReq(AGENT))
    await vi.advanceTimersByTimeAsync(1000)
    const spawned = await spawning

    expect(spawned.reason).toMatch(/never registered/)
    expect(fs.existsSync(logFile())).toBe(false)
  })

  it('writes an abandoned row when a late attach never comes and the ceiling fails the agent', async () => {
    vi.useFakeTimers()
    stopAutoAttach()
    sup = new Supervisor(core, {
      attachMs: 1000,
      attachCeilingMs: 5000,
      surface: {
        platform: 'darwin',
        runAppleScript: async script =>
          script.includes('is running') ? 'true' : script.includes('@@present@@') ? '@@present@@' : 'PANE-1',
      },
      seatDispatch: writerOver(root),
    })

    const spawning = sup.spawn({ ...spawnReq(AGENT), surface: 'iterm-window' })
    await vi.advanceTimersByTimeAsync(10_000)
    await spawning

    expect(rows().map(row => row.outcome)).toEqual(['dispatched', 'abandoned'])
    expect(readDispatches(root, SEAT).records).toMatchObject([{ agent: AGENT, outcome: 'abandoned' }])
  })

  it('writes nothing for an agent whose name has no seat prefix', async () => {
    const spawned = await supervisorWith(writerOver(root)).spawn(spawnReq('scout'))

    expect(spawned.reason).toBeUndefined()
    expect(fs.existsSync(path.join(root, 'logs'))).toBe(false)
  })
})

describe('a seat agent’s retire', () => {
  it('writes one retired row with tokens and usd_est read from the transcript, after retire answers', async () => {
    const s = supervisorWith(writerOver(root))
    await s.spawn(spawnReq(AGENT))
    writeTranscript(AGENT)

    const retired = await s.retire(AGENT)
    const atAnswer = retiredRows().length

    expect(retired.ok).toBe(true)
    expect(atAnswer).toBe(0)
    await expect.poll(() => retiredRows().length).toBe(1)
    const row = retiredRows()[0]
    expect(row).toMatchObject({ agent: AGENT, task: 'AB-12', tokens: 500, models: [MODEL] })
    expect(row?.usd_est).toEqual(expect.any(Number))
    expect(row?.usd_est).toBeGreaterThan(0)
  })

  it('writes the pr, head, failure class and tool errors read from the same transcript', async () => {
    const s = supervisorWith(writerOver(root))
    await s.spawn(spawnReq(AGENT))
    writeTranscript(AGENT, MODEL, [
      failedTool,
      reportTo('human', `Status: DONE\nPR: example-org/widget#7\nHead: ${HEAD}`),
    ])

    await s.retire(AGENT)

    await expect.poll(() => retiredRows().length).toBe(1)
    expect(retiredRows()[0]).toMatchObject({
      pr: 'example-org/widget#7',
      head: HEAD,
      failure_class: 'none',
      tool_errors: 1,
    })
  })

  it('writes a no-report class and null pr and head for an agent with no report and no worktree', async () => {
    const s = supervisorWith(writerOver(root))
    await s.spawn(spawnReq(AGENT))
    writeTranscript(AGENT)

    await s.retire(AGENT)

    await expect.poll(() => retiredRows().length).toBe(1)
    expect(retiredRows()[0]).toMatchObject({
      pr: null,
      head: null,
      failure_class: 'no-report',
      tool_errors: 0,
    })
  })

  it('writes the predecessor a successor was spawned with', async () => {
    const s = supervisorWith(writerOver(root))
    await s.spawn(spawnReq(AGENT))
    const successor = `${AGENT}-again`
    await s.spawn({ ...spawnReq(successor), predecessor: AGENT })

    await s.retire(successor)

    await expect.poll(() => retiredRows().length).toBe(1)
    expect(retiredRows()[0]).toMatchObject({ agent: successor, predecessor: AGENT })
  })

  it('writes the tier a spawn carries on its dispatched row, and no tier key without one', async () => {
    const s = supervisorWith(writerOver(root))
    await s.spawn({ ...spawnReq(AGENT), tier: 2 })
    await s.spawn(spawnReq(`${AGENT}-hand`))

    const [tiered, plain] = dispatchedRows()
    expect(tiered).toMatchObject({ agent: AGENT, tier: 2 })
    expect(plain).not.toHaveProperty('tier')
  })

  it('records burndown as the spawner of a CLI spawn it marks, with the seat in a seat field (CC-802)', async () => {
    const s = supervisorWith(writerOver(root))
    await s.spawn({ ...spawnReq(AGENT), spawnedAs: 'burndown' })

    expect(dispatchedRows()[0]).toMatchObject({ agent: AGENT, spawner: 'burndown', seat: SEAT })
  })

  it('records shepherd as the spawner of a fix-round successor it marks (CC-802)', async () => {
    const s = supervisorWith(writerOver(root))
    await s.spawn({ ...spawnReq(`${AGENT}-s1`), spawnedAs: 'shepherd' })

    expect(dispatchedRows()[0]).toMatchObject({ agent: `${AGENT}-s1`, spawner: 'shepherd', seat: SEAT })
  })

  it('keeps recording the spawning seat for a spawn made through MCP (CC-802)', async () => {
    const s = supervisorWith(writerOver(root))
    await s.spawn({ ...spawnReq(AGENT), requestedBy: SEAT })

    const [row] = dispatchedRows()
    expect(row).toMatchObject({ agent: AGENT, spawner: SEAT })
    expect(row).not.toHaveProperty('seat')
  })

  it('writes the row with null tokens and usd_est when the transcript is missing', async () => {
    const s = supervisorWith(writerOver(root))
    await s.spawn(spawnReq(AGENT))

    const retired = await s.retire(AGENT)

    expect(retired.ok).toBe(true)
    await expect.poll(() => retiredRows().length).toBe(1)
    expect(retiredRows()[0]).toMatchObject({ agent: AGENT, tokens: null, usd_est: null })
    expect(retiredRows()[0]?.usage_miss).toEqual(expect.any(String))
  })

  it('logs a warn line naming a model with no price row', async () => {
    const s = supervisorWith(writerOver(root))
    await s.spawn(spawnReq(AGENT))
    writeTranscript(AGENT, 'model-unknown-9')

    await s.retire(AGENT)
    await expect.poll(() => retiredRows().length).toBe(1)

    const logged = fs.readFileSync(path.join(process.env.AGENT_CHAT_HOME ?? '', 'broker.log'), 'utf8')
    expect(logged).toMatch(/"event":"seat_dispatch_unpriced","level":"warn","models":\["model-unknown-9"\]/)
    expect(retiredRows()[0]?.usd_est).toBeNull()
  })

  it('folds with a hand-written outcome for the same agent to one record', async () => {
    const s = supervisorWith(writerOver(root))
    await s.spawn(spawnReq(AGENT))
    writeTranscript(AGENT)
    await s.retire(AGENT)
    await expect.poll(() => retiredRows().length).toBe(1)

    const outcome = { agent: AGENT, outcome: 'merged', value: 'high', pr: PR }
    fs.appendFileSync(logFile(), `${JSON.stringify(outcome)}\n`)
    const fold = readDispatches(root, SEAT)

    expect(fold.records).toHaveLength(1)
    expect(fold.records[0]).toMatchObject({ agent: AGENT, outcome: 'merged', pr: PR, tokens: 500 })
  })
})

describe('a dispatch log that cannot be written', () => {
  it('fails neither spawn nor retire when the root is unusable', async () => {
    const s = supervisorWith(writerOver(path.join(root, 'missing')))

    const spawned = await s.spawn(spawnReq(AGENT))
    const retired = await s.retire(AGENT)

    expect(spawned).toMatchObject({ ok: true, name: AGENT })
    expect(spawned.reason).toBeUndefined()
    expect(retired.ok).toBe(true)
    expect(fs.existsSync(path.join(root, 'missing'))).toBe(false)
  })

  it('leaves the spawn and retire results as they were when the writer throws', async () => {
    const throwing: SeatDispatchLog = {
      dispatched: () => {
        throw new Error('disk gone')
      },
      abandoned: () => {
        throw new Error('disk gone')
      },
      retired: () => {
        throw new Error('disk gone')
      },
    }
    const s = supervisorWith(throwing)

    const spawned = await s.spawn(spawnReq(AGENT))
    const retired = await s.retire(AGENT)

    expect(spawned).toMatchObject({ ok: true, name: AGENT })
    expect(spawned.reason).toBeUndefined()
    expect(retired.ok).toBe(true)
  })
})

describe('the broker’s services', () => {
  let world: string
  let autonomy: string

  beforeEach(() => {
    world = tmp('dispatch-wiring-')
    process.env.AGENT_CHAT_HOME = path.join(world, 'home')
    process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(world, 'aw')
    fs.mkdirSync(path.join(world, 'home'), { recursive: true })
    autonomy = path.join(world, 'aw', 'claude-channels', 'sources', 'autonomy')
    fs.mkdirSync(path.join(autonomy, 'seats'), { recursive: true })
    fs.writeFileSync(path.join(autonomy, 'seats', `${SEAT}.md`), '---\nprefix: sx\npool: pool-a\n---\n')
  })

  afterEach(() => {
    delete process.env.AGENT_CHAT_ACTIVE_WORK_ROOT
  })

  const dispatchLog = (): string => path.join(autonomy, 'logs', SEAT, 'dispatch.jsonl')

  const retireOver = async (ephemeral: boolean): Promise<ServerMessage> => {
    const services = openServices(ephemeral)
    try {
      services.core.append({
        kind: 'agent_spawned',
        actor: 'human',
        target: AGENT,
        msgId: 'a1',
        body: 'work',
      })
      const frames: ServerMessage[] = []
      const conn = {
        write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
      } as unknown as Conn
      services.socketServer.handleMessage(conn, { t: 'retire', name: AGENT })
      await expect.poll(() => frames.length).toBe(1)
      if (!ephemeral) await expect.poll(() => fs.existsSync(dispatchLog())).toBe(true)
      return frames[0] as ServerMessage
    } finally {
      services.socketServer.close()
      services.core.close()
    }
  }

  it('write a retired row under the autonomy root when the home is a lasting one', async () => {
    const reply = await retireOver(false)

    expect(reply).toMatchObject({ t: 'spawn_result', ok: true })
    expect(fs.readFileSync(dispatchLog(), 'utf8')).toMatch(/"outcome":"retired"/)
  })

  it('builds no seat dispatch writer when the home is a test’s', () => {
    const services = openServices(true)
    try {
      const supervisor = Reflect.get(services.socketServer, 'supervisor') as object
      expect(Reflect.get(supervisor, 'seatDispatch')).toBeUndefined()
    } finally {
      services.socketServer.close()
      services.core.close()
    }
  })

  it('write nothing when the home is a test’s', async () => {
    const reply = await retireOver(true)
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(reply).toMatchObject({ t: 'spawn_result', ok: true })
    expect(fs.existsSync(path.join(autonomy, 'logs'))).toBe(false)
  })
})
