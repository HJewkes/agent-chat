import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import {
  retireFinished,
  STALE_AFTER_MS,
  STALE_RETIRE_CAP,
  type FinishedRetirePort,
} from '../agents/isolation/retire-finished.js'
import { runWatchdog, type WatchdogDeps } from '../agents/seats/run.js'
import { staleRetirePass } from '../agents/seats/stale-retire.js'
import { burndownPausePath } from '../paths.js'
import type { AgentIdentity } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-1465: the seat watchdog retires agents exited over 24 h with no worktree left, every pass,
 * so a paused burndown (whose tick held the only daily retire) no longer lets them pile up.
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

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

function makeRepo(): string {
  const dir = tmp('stale-repo-')
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'seed'], dir)
  return dir
}

async function spawnIn(name: string, repo: string, isolation: 'worktree' | 'none'): Promise<AgentIdentity> {
  const spawned = await sup.spawn({
    name,
    profile: 'explorer',
    brief: 'do the task',
    requestedBy: 'seat-x',
    cwd: repo,
    isolation,
    surface: 'headless',
    spawnerConfigDir: tmp('stale-account-'),
  })
  expect(spawned.reason).toBeUndefined()
  return core.agents.get(spawned.agentId as string)!
}

async function exit(agent: AgentIdentity): Promise<void> {
  const recordExit = (sup as unknown as { recordExit: (id: string, o: unknown) => Promise<void> }).recordExit
  await recordExit.call(sup, agent.agentId, { code: 0, signal: null })
}

const untrack = (agent: AgentIdentity): void =>
  void (sup as unknown as { live: Map<string, unknown> }).live.delete(agent.agentId)

const advance = (ms: number): void => void vi.setSystemTime(Date.now() + ms)

const stateOf = (name: string): string | undefined =>
  core.agents.roster({ includeRetired: true }).findLast(a => a.name === name)?.state

const CHARTER = `---
owner_seat: seat-x
seats: [seat-x]
pools:
  alpha: {config_dir: /synthetic/alpha, human_uses: false, reserve_seven_day: 14, ceiling_five_hour: 100}
---
`

function watchdogDeps(): WatchdogDeps {
  return {
    now: () => new Date(),
    readCharter: () => CHARTER,
    readSeatFile: () => '---\nprefix: sx\npool: alpha\n---\n',
    seatLogDays: () => [],
    readSeatLog: () => undefined,
    readBudget: dir => ({ found: false, path: dir, reason: 'no_file' }),
    ownerMessages: () => [],
    roster: async () => ({ agents: [], connected: [] }),
    presence: () => undefined,
    eligible: () => ({ count: 0, skipped: 0 }),
    loadDoc: () => ({ seats: {}, pools: {}, stopped: {} }),
    saveDoc: () => undefined,
    wake: async () => ({ ok: true, detail: 'm1' }),
    appendLog: () => undefined,
    lock: () => ({ held: true, release: () => undefined }),
    retireStale: () => sup.retireFinished({ stale: true }),
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const home = tmp('stale-home-')
  process.env.AGENT_CHAT_HOME = home
  fs.writeFileSync(path.join(home, 'config.json'), '{"worktreeBudget": 12}')
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
  vi.useRealTimers()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the watchdog pass while burndown is paused', () => {
  it('retires an exited agent older than 24 h and keeps the live, detached, young and tree-holding ones', async () => {
    fs.writeFileSync(burndownPausePath(), '')
    const repo = makeRepo()
    const old = await spawnIn('agent-old', repo, 'none')
    const tree = await spawnIn('agent-tree', repo, 'worktree')
    const detached = await spawnIn('agent-detached', repo, 'none')
    await exit(old)
    await exit(tree)
    core.append({ kind: 'agent_detached', actor: detached.name, ref: detached.agentId, body: 'closed' })
    untrack(detached)
    advance(STALE_AFTER_MS + 60_000)
    await exit(await spawnIn('agent-young', repo, 'none'))
    await spawnIn('agent-live', repo, 'none')
    await vi.waitFor(() => expect(stateOf('agent-live')).toBe('live'))

    const lines = await runWatchdog(watchdogDeps(), { dryRun: false })

    expect(lines).toContain('Watchdog: retired 1 agent(s) exited over 24 h')
    expect(stateOf('agent-old')).toBe('retired')
    expect({
      tree: stateOf('agent-tree'),
      detached: stateOf('agent-detached'),
      young: stateOf('agent-young'),
      live: stateOf('agent-live'),
    }).toEqual({ tree: 'exited', detached: 'detached', young: 'exited', live: 'live' })
    expect(fs.existsSync(tree.cwd)).toBe(true)
  })

  it('names the tree it keeps, and the plan never lists the detached or young agents', async () => {
    const repo = makeRepo()
    const tree = await spawnIn('agent-tree', repo, 'worktree')
    const detached = await spawnIn('agent-detached', repo, 'none')
    await exit(tree)
    core.append({ kind: 'agent_detached', actor: detached.name, ref: detached.agentId, body: 'closed' })
    untrack(detached)
    advance(STALE_AFTER_MS + 60_000)
    await exit(await spawnIn('agent-young', repo, 'none'))

    const out = await sup.retireFinished({ stale: true, dryRun: true })

    expect(out.plan).toEqual([
      { name: 'agent-tree', action: 'skip', reason: `still holds ${tree.cwd}; park it first` },
    ])
  })

  it('retires an agent whose worktree is already gone', async () => {
    const repo = makeRepo()
    const agent = await spawnIn('agent-parked', repo, 'worktree')
    await exit(agent)
    git(['worktree', 'remove', '--force', agent.cwd], repo)
    advance(STALE_AFTER_MS + 60_000)

    const out = await sup.retireFinished({ stale: true })

    expect(out.results).toEqual([{ name: 'agent-parked', ok: true }])
    expect(stateOf('agent-parked')).toBe('retired')
  })

  it('retires nothing on a dry-run pass', async () => {
    const old = await spawnIn('agent-old', makeRepo(), 'none')
    await exit(old)
    advance(STALE_AFTER_MS + 60_000)

    await runWatchdog(watchdogDeps(), { dryRun: true })

    expect(stateOf('agent-old')).toBe('exited')
  })
})

describe('the per-call cap', () => {
  const stale = (i: number): AgentIdentity =>
    ({
      agentId: `id-${i}`,
      name: `agent-${i}`,
      state: 'exited',
      origin: 'spawned',
      spawnedBy: 'seat-x',
      cwd: '',
      exitedAt: 0,
    }) as AgentIdentity

  it(`retires at most ${STALE_RETIRE_CAP} in one call and leaves the rest for the next`, async () => {
    const roster = Array.from({ length: STALE_RETIRE_CAP + 5 }, (_, i) => stale(i))
    const retired: string[] = []
    const port: FinishedRetirePort = {
      roster: () => roster,
      events: () => [],
      tracked: () => false,
      parking: () => false,
      current: id => roster.find(a => a.agentId === id),
      presence: () => 'none',
      retire: id => (retired.push(id), Promise.resolve({ ok: true })),
      now: () => STALE_AFTER_MS,
    }

    const out = await retireFinished(port, { stale: true })

    expect(retired).toHaveLength(STALE_RETIRE_CAP)
    expect(out.plan).toHaveLength(STALE_RETIRE_CAP)
  })
})

describe('the pass lines', () => {
  it('reports a failed call and logs it, without throwing', async () => {
    const events: string[] = []

    const lines = await staleRetirePass({
      retireStale: () => Promise.reject(new Error('broker did not answer retire_finished_result')),
      log: event => void events.push(event),
    })

    expect(lines).toEqual(['Watchdog: stale retire failed (broker did not answer retire_finished_result)'])
    expect(events).toEqual(['watchdog_stale_retire_failed'])
  })

  it('prints nothing when there was nothing to retire', async () => {
    const lines = await staleRetirePass({
      retireStale: async () => ({ ok: true, plan: [{ name: 'agent-x', action: 'skip', reason: 'r' }], results: [] }),
    })

    expect(lines).toEqual([])
  })
})
