import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { launchFieldsOf, SocketServer } from '../broker/socket.js'
import { Supervisor, type SpawnOutcome, type SpawnRequest } from '../agents/supervisor.js'
import { LAUNCH_REASON_MAX, type ClientMessage } from '../protocol.js'
import { startSupervisor, type RestartHarness } from './helpers/restart-harness.js'

/** CC-1466: who ran a CLI spawn as the human. Display and audit only; synthetic names throughout. */

const sent: ClientMessage[] = []

vi.mock('../cli/client.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  withBroker: async (fn: (b: unknown) => Promise<unknown>) =>
    fn({
      request: async (frame: ClientMessage) => {
        sent.push(frame)
        return { t: 'spawn_result', ok: true, name: 'agent-x', agentId: 'a1' }
      },
    }),
  fail: (reason: string): never => {
    throw new Error(reason)
  },
}))

const { buildProgram } = await import('../cli/index.js')

async function cli(...argv: string[]): Promise<ClientMessage | undefined> {
  const program = buildProgram()
  program.exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
  const agent = program.commands.find(c => c.name() === 'agent')
  agent?.commands.forEach(c => c.exitOverride().configureOutput({ writeErr: () => undefined }))
  await program.parseAsync(['agent', ...argv], { from: 'user' }).catch(() => undefined)
  return sent.find(f => f.t === 'spawn' || f.t === 'resume')
}

describe('the --launched-by flag', () => {
  beforeEach(() => {
    sent.length = 0
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited')
    }) as never)
  })
  afterEach(() => vi.restoreAllMocks())

  it('puts the launcher and its reason on a spawn frame', async () => {
    const frame = await cli(
      'spawn',
      'agent-x',
      'explorer',
      'go',
      '--launched-by',
      'shepherd',
      '--launch-reason',
      'fix round',
    )

    expect(frame).toMatchObject({ t: 'spawn', launchedBy: 'shepherd', launchReason: 'fix round' })
  })

  it('puts the launcher on a resume frame', async () => {
    const frame = await cli('resume', 'agent-x', '--message', 'wake', '--launched-by', 'shepherd')

    expect(frame).toMatchObject({ t: 'resume', name: 'agent-x', launchedBy: 'shepherd' })
  })

  it('accepts autoresearch as the launcher on a resume frame', async () => {
    const frame = await cli('resume', 'agent-x', '--message', 'wake', '--launched-by', 'autoresearch')

    expect(frame).toMatchObject({ t: 'resume', name: 'agent-x', launchedBy: 'autoresearch' })
  })

  // Catches: free text accepted, which would let a caller dress a spawn up as any agent's.
  it.each([
    ['spawn', 'agent-x', 'explorer', 'go'],
    ['resume', 'agent-x', '--message', 'wake'],
  ])('refuses a launcher off the allow-list on %s, sending nothing', async (...argv) => {
    expect(await cli(...argv, '--launched-by', 'seat-a')).toBeUndefined()
  })
})

describe('launchFieldsOf', () => {
  it('keeps an allow-listed launcher and its reason', () => {
    expect(launchFieldsOf({ launchedBy: 'seat-watchdog', launchReason: 'dark 40 min' })).toEqual({
      launchedBy: 'seat-watchdog',
      launchReason: 'dark 40 min',
    })
  })

  it('drops a launcher off the allow-list, and a reason with no launcher', () => {
    expect(launchFieldsOf({ launchedBy: 'agent-x', launchReason: 'r' })).toEqual({})
    expect(launchFieldsOf({ launchReason: 'r' })).toEqual({})
  })

  it('cuts a reason to one bounded line', () => {
    const { launchReason } = launchFieldsOf({
      launchedBy: 'shepherd',
      launchReason: `a\nb ${'x'.repeat(400)}`,
    })

    expect(launchReason?.startsWith('a b x')).toBe(true)
    expect(launchReason).toHaveLength(LAUNCH_REASON_MAX)
  })
})

describe('the broker reading launchedBy', () => {
  let home: string
  let server: SocketServer | undefined

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-launched-by-'))
    process.env.AGENT_CHAT_HOME = home
  })
  afterEach(() => {
    server?.close()
    vi.restoreAllMocks()
    delete process.env.AGENT_CHAT_HOME
    fs.rmSync(home, { recursive: true, force: true })
  })

  async function requestFrom(register: boolean): Promise<SpawnRequest> {
    const seen: SpawnRequest[] = []
    vi.spyOn(Supervisor.prototype, 'spawn').mockImplementation(async req => {
      seen.push(req)
      return { ok: false, reason: 'stubbed' }
    })
    const core = new BrokerCore(() => undefined, {
      events: new EventLog(path.join(home, 'events.db')),
      registry: new Registry<Conn>(),
    })
    server = new SocketServer(core)
    const conn = { write: () => true, end: () => undefined } as unknown as Conn
    if (register)
      server.handleMessage(conn, { t: 'register', name: 'agent-x', workingOn: 'w', cwd: home, pid: 1 })
    server.handleMessage(conn, {
      t: 'spawn',
      name: 'impl',
      profile: 'explorer',
      brief: 'b',
      launchedBy: 'shepherd',
      launchReason: 'r',
    })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    return seen[0] as SpawnRequest
  }

  it("takes an unregistered CLI connection's launcher", async () => {
    expect(await requestFrom(false)).toMatchObject({
      requestedBy: 'human',
      launchedBy: 'shepherd',
      launchReason: 'r',
    })
  })

  // Catches: a registered agent claiming to be the watchdog on its own spawn row.
  it("drops a registered session's launcher", async () => {
    const request = await requestFrom(true)

    expect(request.requestedBy).toBe('agent-x')
    expect(request).not.toHaveProperty('launchedBy')
    expect(request).not.toHaveProperty('launchReason')
  })
})

/**
 * CC-1466: launched_by is display data. The unprefixed seat gate is one `spawnedAs` lifts, so it is
 * the gate a launcher claim would most plausibly leak into; the outcome must not move either way.
 */
describe('launchedBy and the spawn gates', () => {
  let sup: RestartHarness | undefined
  afterEach(() => {
    sup?.close()
    sup = undefined
  })

  const gated = (): RestartHarness => {
    sup = startSupervisor({
      seatOverlap: { mode: () => 'refuse', read: () => undefined, spawnerSeat: () => ({ prefix: 'sa' }) },
    })
    return sup
  }
  const LAUNCHED: Partial<SpawnRequest> = { launchedBy: 'shepherd', launchReason: 'fix round' }

  it.each([
    ['refused', 'impl-12'],
    ['admitted', 'sa-impl-12'],
  ])('leaves a gate that %s the spawn with the same outcome', async (_label, name) => {
    const plain = await gated().spawnAgent(name, { profile: 'implementer' })
    sup?.close()
    const launched = await gated().spawnAgent(name, { profile: 'implementer', ...LAUNCHED })

    const verdict = ({ ok, code, reason, retryable }: SpawnOutcome) => ({ ok, code, reason, retryable })
    expect(plain.ok).toBe(name.startsWith('sa-'))
    expect(verdict(launched)).toEqual(verdict(plain))
  })

  it('is not spawnedAs: a claim that does lift the gate still lifts it alone', async () => {
    const h = gated()

    expect((await h.spawnAgent('impl-12', { profile: 'implementer', ...LAUNCHED })).ok).toBe(false)
    expect(
      (await h.spawnAgent('impl-13', { profile: 'implementer', spawnedAs: 'burndown', task: 'AB-1' })).ok,
    ).toBe(true)
  })

  it('records the human as actor and the launcher beside it', async () => {
    const h = gated()
    const { agentId } = await h.spawnAgent('sa-impl-12', { profile: 'implementer', ...LAUNCHED })

    const row = h.core.events.agentEvents().find(r => r.kind === 'agent_spawned' && r.msgId === agentId)
    expect(row?.actor).toBe('human')
    expect(row?.meta).toMatchObject({ launched_by: 'shepherd', launch_reason: 'fix round' })
    expect(row?.meta).not.toHaveProperty('spawned_as')
    expect(h.core.agents.get(String(agentId))).toMatchObject({ spawnedBy: 'human', launchedBy: 'shepherd' })
  })

  /** A retired identity two coordinator links deep, so its name is free to spawn again. */
  const retiredDeep = (h: RestartHarness, name: string): string => {
    const { msgId } = h.core.append({
      kind: 'agent_spawned',
      actor: 'seat-b',
      target: name,
      body: 'earlier',
      meta: { name, profile: 'implementer', depth: '3', coordinator_depth: '2' },
    })
    h.core.append({ kind: 'agent_retired', actor: 'human', target: name, ref: msgId })
    return msgId
  }
  const depthsOf = (h: RestartHarness, agentId: string | undefined): string[] => {
    const row = h.core.events.agentEvents().find(r => r.kind === 'agent_spawned' && r.msgId === agentId)
    return [row?.meta.depth ?? '', row?.meta.coordinator_depth ?? '']
  }

  it("keeps the depths of an earlier identity of the same name, and ignores another name's", async () => {
    const h = gated()
    const same = retiredDeep(h, 'sa-impl-12')
    const other = retiredDeep(h, 'sa-other')

    const kept = await h.spawnAgent('sa-impl-12', { profile: 'implementer', lineageFrom: same })
    const borrowed = await h.spawnAgent('sa-impl-13', { profile: 'implementer', lineageFrom: other })

    expect(depthsOf(h, kept.agentId)).toEqual(['3', '2'])
    expect(depthsOf(h, borrowed.agentId)).toEqual(['1', '0'])
  })
})
