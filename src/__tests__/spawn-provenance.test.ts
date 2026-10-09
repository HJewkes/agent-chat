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
import { foldAgent } from '../agents/identity.js'
import { githubRepoOf, inferWorkRole, isWorkRole } from '../agents/spawn-provenance.js'
import type { AgentEventRow } from '../broker/event-store.js'
import type { AgentIdentity } from '../protocol.js'
import { spawnFrame } from '../agents/burndown/execute.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-915: the repo, branch and base commit an agent's worktree was cut from, the
 * task it ran and the role it played, recorded at spawn and at resume. A squash
 * merge and branch cleanup lose the base for good, so the spawn row is the only
 * place a later exporter can read it from.
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

/** A repo whose origin reads as a GitHub URL but fetches from a local bare repo. */
function repoWithGithubOrigin(): { repo: string; tip: string } {
  const repo = tmp('prov-repo-')
  git(['init', '-b', 'main'], repo)
  git(['config', 'user.email', 'test@example.com'], repo)
  git(['config', 'user.name', 'Test'], repo)
  git(['config', 'commit.gpgsign', 'false'], repo)
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(['add', '.'], repo)
  git(['commit', '-m', 'seed'], repo)
  const bare = tmp('prov-origin-')
  git(['init', '--bare', '-b', 'main'], bare)
  git(['remote', 'add', 'origin', 'https://github.com/acme/widget.git'], repo)
  git(['config', `url.${bare}.insteadOf`, 'https://github.com/acme/widget.git'], repo)
  // A local push URL, so an agent's leak-guard git shim sees a local destination.
  git(['remote', 'set-url', '--push', 'origin', bare], repo)
  git(['push', '-q', 'origin', 'main'], repo)
  return { repo, tip: git(['rev-parse', 'HEAD'], repo) }
}

const spawnReq = (name: string, repo: string, over: Record<string, unknown> = {}) => ({
  name,
  profile: 'explorer',
  brief: 'do the task',
  requestedBy: 'human',
  cwd: repo,
  isolation: 'worktree' as const,
  surface: 'headless' as const,
  spawnerConfigDir: tmp('prov-account-'),
  ...over,
})

async function spawnIn(name: string, repo: string, over: Record<string, unknown> = {}) {
  const spawned = await sup.spawn(spawnReq(name, repo, over))
  expect(spawned.reason).toBeUndefined()
  return core.agents.get(spawned.agentId as string) as AgentIdentity
}

const spawnRow = (agentId: string) =>
  core.events.agentEvents().find(r => r.kind === 'agent_spawned' && r.msgId === agentId)

beforeEach(() => {
  const home = tmp('prov-home-')
  process.env.AGENT_CHAT_HOME = home
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
  sup = new Supervisor(core, {
    cwdLister: async () => [],
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

describe('a worktree agent spawned with a task and role', () => {
  it('reads back its repo, branch, base commit, task and role from the agent record', async () => {
    const { repo, tip } = repoWithGithubOrigin()

    const agent = await spawnIn('worker-a', repo, { task: 'CC-915', workRole: 'reviewer' })

    expect(agent).toMatchObject({
      repo: 'acme/widget',
      branch: 'agent-chat/worker-a',
      base: { sha: tip, ref: 'origin/main' },
      task: 'CC-915',
      workRole: 'reviewer',
    })
    expect(agent.workRoleInferred).toBeUndefined()
  })

  it('writes the same fields on the spawn row the session-origin reader consumes', async () => {
    const { repo, tip } = repoWithGithubOrigin()

    const agent = await spawnIn('worker-a', repo, { task: 'CC-915', workRole: 'fix-round-2' })

    expect(spawnRow(agent.agentId)?.meta).toMatchObject({
      repo: 'acme/widget',
      branch: 'agent-chat/worker-a',
      base_sha: tip,
      base_ref: 'origin/main',
      task: 'CC-915',
      work_role: 'fix-round-2',
    })
    expect(spawnRow(agent.agentId)?.meta).not.toHaveProperty('work_role_inferred')
  })

  it('infers the role from the profile and name when the spawner gives none, and marks it inferred', async () => {
    const { repo } = repoWithGithubOrigin()

    const agent = await spawnIn('sx-x-1-s1-s1', repo, { profile: 'implementer' })

    expect(agent).toMatchObject({ workRole: 'fix-round-2', workRoleInferred: true })
    expect(spawnRow(agent.agentId)?.meta).toMatchObject({
      work_role: 'fix-round-2',
      work_role_inferred: 'true',
    })
  })

  it('refuses a role outside the vocabulary', async () => {
    const { repo } = repoWithGithubOrigin()

    const result = await sup.spawn(spawnReq('worker-a', repo, { workRole: 'boss' }))

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/role must be one of/)
  })
})

describe('a burndown spawn', () => {
  it('is refused without a task id', async () => {
    const { repo } = repoWithGithubOrigin()

    const result = await sup.spawn(spawnReq('bd-a', repo, { spawnedAs: 'burndown' }))

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/burndown spawn needs a task id/)
    expect(core.events.agentEvents().some(r => r.kind === 'agent_spawned')).toBe(false)
  })

  it('spawns with one', async () => {
    const { repo } = repoWithGithubOrigin()

    const agent = await spawnIn('bd-a', repo, { spawnedAs: 'burndown', task: 'CC-1' })

    expect(agent.task).toBe('CC-1')
  })
})

describe("burndown's spawn frame", () => {
  it('carries the task id the broker now requires', () => {
    const frame = spawnFrame({
      name: 'bd-a',
      profile: 'bd-implementer',
      brief: 'b',
      cwd: '/repo',
      configDir: '/acct',
      initiative: 'demo',
      taskId: 'AB-7',
    })

    expect(frame).toMatchObject({ task: 'AB-7', spawnedAs: 'burndown' })
  })
})

describe('a resume that re-creates a parked worktree', () => {
  it('records the repo, branch and base it was re-created from on the resume row', async () => {
    const { repo, tip } = repoWithGithubOrigin()
    const agent = await spawnIn('worker-a', repo, { task: 'CC-915' })
    const transcript = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, '{}\n')
    fs.writeFileSync(path.join(agent.cwd, 'feature.ts'), 'work\n')
    git(['add', 'feature.ts'], agent.cwd)
    git(['commit', '-m', 'work'], agent.cwd)
    git(['push', '-q', 'origin', 'agent-chat/worker-a'], agent.cwd)
    const recordExit = (sup as unknown as { recordExit: (id: string, o: unknown) => Promise<void> })
      .recordExit
    await recordExit.call(sup, agent.agentId, { code: 0, signal: null })
    expect((await sup.park('worker-a')).ok).toBe(true)

    const resumed = await sup.resume('worker-a')

    expect(resumed.reason).toBeUndefined()
    const row = core.events.agentEvents().findLast(r => r.kind === 'agent_resumed' && r.ref === agent.agentId)
    expect(row?.meta).toMatchObject({
      repo: 'acme/widget',
      branch: 'agent-chat/worker-a',
      base_sha: tip,
      base_ref: 'origin/main',
      reattached: 'local',
    })
    expect(core.agents.get(agent.agentId)).toMatchObject({ base: { sha: tip }, task: 'CC-915' })
  })
})

describe('an agent record written before these fields existed', () => {
  const oldRow: AgentEventRow = {
    id: 1,
    ts: 1_700_000_000_000,
    kind: 'agent_spawned',
    actor: 'human',
    target: 'rv-acme-widget-12',
    msgId: 'a-old',
    ref: null,
    body: 'review it',
    meta: { name: 'rv-acme-widget-12', profile: 'bd-reviewer', cwd: '/x', session_id: 's' },
  } as unknown as AgentEventRow

  it('still loads, with an inferred role and no provenance fields', () => {
    const agent = foldAgent([oldRow])

    expect(agent).toMatchObject({
      name: 'rv-acme-widget-12',
      workRole: 'shepherd-review',
      workRoleInferred: true,
    })
    expect(agent).not.toHaveProperty('base')
    expect(agent).not.toHaveProperty('repo')
    expect(agent).not.toHaveProperty('branch')
    expect(agent).not.toHaveProperty('task')
  })
})

describe('inferring a role', () => {
  it.each([
    ['sx-cc-1-review', 'bd-reviewer', 'reviewer'],
    ['rv-acme-widget-524-2', 'bd-reviewer', 'shepherd-review'],
    ['dc-td-789-apply-s1', 'bd-implementer', 'fix-round-1'],
    ['sx-tp-2088-cost-s1-s1-s1', 'bd-implementer', 'fix-round-3'],
    ['sx-cc-915-spawn-capture', 'implementer-lite', 'implementer'],
    ['sx-tp-2150-throughput-plan', 'bd-planner', 'planner'],
    ['scout', 'explorer', 'other'],
  ])('reads %s on %s as %s', (name, profile, role) => {
    expect(inferWorkRole(profile, name)).toBe(role)
  })

  it('accepts the vocabulary and a numbered fix round, and nothing else', () => {
    expect(
      ['implementer', 'reviewer', 'fix-round-3', 'shepherd-review', 'planner', 'other'].every(isWorkRole),
    ).toBe(true)
    expect(['fix-round-', 'fix-round-x', 'boss', ''].some(isWorkRole)).toBe(false)
  })
})

describe('reading owner/name from an origin URL', () => {
  it.each([
    ['https://github.com/acme/widget.git', 'acme/widget'],
    ['git@github.com:acme/widget.git', 'acme/widget'],
    ['https://github.com/acme/widget', 'acme/widget'],
    ['/srv/git/widget.git', undefined],
  ])('%s', (url, slug) => {
    expect(githubRepoOf(url)).toBe(slug)
  })
})
