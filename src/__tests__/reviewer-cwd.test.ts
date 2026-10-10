import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { isReviewerSpawn, primaryCheckoutOf } from '../agents/reviewer-tree.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-916: a reviewer spawned with a repo's primary checkout as cwd lands in a disposable
 * worktree instead, so its git writes cannot dirty the tree deploys are cut from.
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
  const dir = tmp('rv-repo-')
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'seed'], dir)
  return dir
}

const treesUnder = (repo: string): number =>
  git(['worktree', 'list', '--porcelain'], repo)
    .split('\n')
    .filter(line => line.startsWith(`worktree ${path.join(repo, '.worktrees')}${path.sep}`)).length

const spawnReq = (name: string, repo: string, profile: string, over: Record<string, unknown> = {}) => ({
  name,
  profile,
  brief: 'review the change',
  requestedBy: 'human',
  cwd: repo,
  surface: 'headless' as const,
  spawnerConfigDir: tmp('rv-account-'),
  ...over,
})

async function spawnAgent(name: string, repo: string, profile: string, over: Record<string, unknown> = {}) {
  const spawned = await sup.spawn(spawnReq(name, repo, profile, over))
  expect(spawned.reason).toBeUndefined()
  return core.agents.get(spawned.agentId as string)!
}

beforeEach(() => {
  const home = tmp('rv-home-')
  process.env.AGENT_CHAT_HOME = home
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  for (const name of ['bd-reviewer', 'rv-readonly']) {
    fs.writeFileSync(
      path.join(home, 'profiles', `${name}.json`),
      JSON.stringify({
        description: 'a reviewer',
        model: 'sonnet',
        allowedTools: ['Read', 'Bash'],
        disallowedTools: ['Write', 'Edit'],
        isolation: 'none',
        surface: 'headless',
      }),
    )
  }
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

describe('which spawns are reviewers', () => {
  it.each([
    ['reviewer', 'x-1'],
    ['bd-reviewer', 'x-1'],
    ['rv-readonly', 'x-1'],
    ['relay-reviewer', 'x-1'],
    ['anything', 'rv-owner-repo-9-2'],
  ])('treats profile %s with agent %s as a reviewer', (profile, name) => {
    expect(isReviewerSpawn(profile, name)).toBe(true)
  })

  it.each([
    ['implementer', 'worker-a'],
    ['bd-implementer', 'previewer-1'],
    ['peer', 'rvx-1'],
  ])('leaves profile %s with agent %s alone', (profile, name) => {
    expect(isReviewerSpawn(profile, name)).toBe(false)
  })
})

describe('finding a primary checkout', () => {
  it('names the root for the root and for a subdirectory, and nothing for a linked worktree', () => {
    const repo = makeRepo()
    fs.mkdirSync(path.join(repo, 'src'))
    const linked = path.join(tmp('rv-linked-'), 'tree')
    git(['worktree', 'add', '--detach', linked], repo)

    expect(primaryCheckoutOf(repo)).toBe(repo)
    expect(primaryCheckoutOf(path.join(repo, 'src'))).toBe(repo)
    expect(primaryCheckoutOf(linked)).toBeUndefined()
    expect(primaryCheckoutOf(tmp('rv-plain-'))).toBeUndefined()
  })
})

describe.each(['reviewer', 'bd-reviewer', 'rv-readonly'])('a %s spawned in a primary checkout', profile => {
  it('runs in a worktree whose git writes leave the primary tree clean', async () => {
    const repo = makeRepo()
    const head = git(['rev-parse', 'HEAD'], repo)

    const agent = await spawnAgent('rv-owner-repo-1-1', repo, profile)

    expect(agent.cwd).not.toBe(repo)
    expect(agent.cwd.startsWith(path.join(repo, '.worktrees') + path.sep)).toBe(true)
    fs.writeFileSync(path.join(agent.cwd, 'scratch.txt'), 'review notes\n')
    git(['add', 'scratch.txt'], agent.cwd)
    expect(git(['status', '--porcelain'], repo)).toBe('')
    expect(git(['rev-parse', 'HEAD'], repo)).toBe(head)
    expect(git(['branch', '--show-current'], repo)).toBe('main')
  })
})

describe('a reviewer spawn that is already safe', () => {
  it('keeps an existing worktree as its cwd', async () => {
    const repo = makeRepo()
    const linked = path.join(tmp('rv-linked-'), 'tree')
    git(['worktree', 'add', '--detach', linked], repo)

    const agent = await spawnAgent('rv-owner-repo-2-1', linked, 'reviewer')

    expect(agent.cwd).toBe(linked)
    expect(treesUnder(repo)).toBe(0)
  })

  it('keeps a directory outside any repository', async () => {
    const dir = tmp('rv-review-dir-')

    const agent = await spawnAgent('rv-owner-repo-3-1', dir, 'reviewer')

    expect(agent.cwd).toBe(dir)
  })

  it('leaves a non-reviewer spawn on the primary checkout', async () => {
    const repo = makeRepo()

    const agent = await spawnAgent('peer-a', repo, 'peer')

    expect(agent.cwd).toBe(repo)
  })
})

describe('the disposable worktree', () => {
  it('counts against the worktree budget and is removed when the reviewer retires', async () => {
    const repo = makeRepo()
    await spawnAgent('rv-owner-repo-4-1', repo, 'reviewer')
    expect(treesUnder(repo)).toBe(1)

    const retired = await sup.retire('rv-owner-repo-4-1')

    expect(retired.reason).toBeUndefined()
    expect(treesUnder(repo)).toBe(0)
  })

  it('refuses a reviewer when the budget is spent', async () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(process.env.AGENT_CHAT_HOME!, 'config.json'), '{"worktreeBudget": 1}')
    await spawnAgent('worker-a', repo, 'implementer')

    const refused = await sup.spawn(spawnReq('rv-owner-repo-5-1', repo, 'reviewer'))

    expect(refused.reason).toMatch(/budget/i)
    expect(git(['status', '--porcelain'], repo)).toBe('')
  })

  it('refuses a reviewer that asks to own paths in the primary checkout', async () => {
    const repo = makeRepo()

    const refused = await sup.spawn(spawnReq('rv-owner-repo-6-1', repo, 'reviewer', { owns: ['src/**'] }))

    expect(refused.reason).toMatch(/primary checkout/)
  })
})
