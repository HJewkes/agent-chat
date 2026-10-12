import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { transcriptPath } from '../agents/transcript.js'
import {
  fixRoundBlocker,
  parseActiveRuns,
  type ShepherdRun,
  type ShepherdSkipPort,
} from '../agents/isolation/shepherd-skip.js'
import type { AgentIdentity } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-754: on 2026-10-05 (#564) Shepherd queued an implementer wake at 08:17:22 and the tree was parked at
 * about 08:20, so the wake attached to a missing cwd. Park now refuses while the agent's run is in a fix round.
 */

const tmpDirs: string[] = []
let runs: () => Promise<ShepherdRun[]>
let core: BrokerCore
let sup: Supervisor
let stopAutoAttach: () => void

const port: ShepherdSkipPort = {
  activeRuns: () => runs(),
  hasOpenPr: () => Promise.resolve(true),
}

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

function repoWithOrigin(): string {
  const repo = tmp('fix-round-repo-')
  git(['init', '-b', 'main'], repo)
  git(['config', 'user.email', 'test@example.com'], repo)
  git(['config', 'user.name', 'Test'], repo)
  git(['config', 'commit.gpgsign', 'false'], repo)
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(['add', '.'], repo)
  git(['commit', '-m', 'seed'], repo)
  const origin = tmp('fix-round-origin-')
  git(['init', '--bare', '-b', 'main'], origin)
  git(['remote', 'add', 'origin', origin], repo)
  git(['push', '-q', 'origin', 'main'], repo)
  return repo
}

/** An implementer that committed, pushed its branch and exited: everything park checks besides Shepherd passes. */
async function finishedPushed(name: string): Promise<AgentIdentity> {
  const spawned = await sup.spawn({
    name,
    profile: 'explorer',
    brief: 'do the task',
    requestedBy: 'human',
    cwd: repoWithOrigin(),
    isolation: 'worktree',
    surface: 'headless',
    spawnerConfigDir: tmp('fix-round-account-'),
  })
  expect(spawned.reason).toBeUndefined()
  const agent = core.agents.get(spawned.agentId as string)!
  const transcript = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
  fs.mkdirSync(path.dirname(transcript), { recursive: true })
  fs.writeFileSync(transcript, '{}\n')
  fs.writeFileSync(path.join(agent.cwd, 'feature.ts'), 'work\n')
  git(['add', 'feature.ts'], agent.cwd)
  git(['commit', '-m', 'add feature'], agent.cwd)
  git(['push', '-q', 'origin', `agent-chat/${name}`], agent.cwd)
  const recordExit = (sup as unknown as { recordExit: (id: string, o: unknown) => Promise<void> }).recordExit
  await recordExit.call(sup, agent.agentId, { code: 0, signal: null })
  return agent
}

const run = (over: Partial<ShepherdRun> = {}): ShepherdRun => ({
  branch: 'agent-chat/impl',
  names: ['impl'],
  implementer: 'impl',
  phase: 'fixing',
  ...over,
})

beforeEach(() => {
  const home = tmp('fix-round-home-')
  process.env.AGENT_CHAT_HOME = home
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
  runs = () => Promise.resolve([])
  sup = new Supervisor(core, {
    cwdLister: async () => [],
    shepherdSkip: port,
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
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('parking while a Shepherd run is in a fix round', () => {
  it('refuses the #564 sequence: the implementer exited, then Shepherd queued its wake, then park ran', async () => {
    const agent = await finishedPushed('impl')
    runs = () => Promise.resolve([run()])

    const parked = await sup.park('impl')

    expect(parked).toEqual({
      ok: false,
      reason:
        'Shepherd run for agent-chat/impl is in a fix round (phase fixing); parking would strand its wake',
    })
    expect(fs.existsSync(agent.cwd)).toBe(true)
  })

  it('parks when the run for its branch is in review', async () => {
    const agent = await finishedPushed('impl')
    runs = () => Promise.resolve([run({ phase: 'review' })])

    expect((await sup.park('impl')).ok).toBe(true)
    expect(fs.existsSync(agent.cwd)).toBe(false)
  })

  it('parks when the run in a fix round is for another branch and implementer', async () => {
    await finishedPushed('impl')
    runs = () =>
      Promise.resolve([run({ branch: 'agent-chat/other', names: ['other'], implementer: 'other' })])

    expect((await sup.park('impl')).ok).toBe(true)
  })

  it('refuses when Shepherd cannot be read', async () => {
    const agent = await finishedPushed('impl')
    runs = () => Promise.reject(new Error('connection refused'))

    const parked = await sup.park('impl')

    expect(parked.ok).toBe(false)
    expect(parked.reason).toMatch(/^Shepherd could not be read \(connection refused\)/)
    expect(fs.existsSync(agent.cwd)).toBe(true)
  })
})

describe('fixRoundBlocker', () => {
  const agent = { name: 'impl' } as AgentIdentity

  it('blocks on a fixing run that names the agent as implementer under another branch', async () => {
    runs = () => Promise.resolve([run({ branch: 'feat/x' })])

    expect(await fixRoundBlocker(port, agent, undefined)).toMatch(/feat\/x is in a fix round/)
  })

  it('blocks on a fixing run for the tree branch even when it lists no implementer', async () => {
    runs = () => Promise.resolve([run({ branch: 'feat/tree', names: [], implementer: null })])
    const target = {
      gitRoot: '/repo',
      worktree: '/repo/.worktrees/impl',
      branch: 'feat/tree',
      assigned: true,
    }

    expect(await fixRoundBlocker(port, agent, target)).toMatch(/feat\/tree is in a fix round/)
  })
})

describe('reading Shepherd phases', () => {
  it('keeps each live run phase', () => {
    const stdout = JSON.stringify([
      { phase: 'fixing', branch: 'agent-chat/impl', implementer: 'impl' },
      { phase: 'done', branch: 'agent-chat/gone' },
    ])

    expect(parseActiveRuns(stdout).map(r => r.phase)).toEqual(['fixing'])
  })
})
