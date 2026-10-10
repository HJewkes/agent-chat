import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadPolicy, parseSeat, type Policy } from '../agents/burndown/policy.js'
import { repoForTask, resolveSeatDispatch, type SeatDispatch } from '../agents/burndown/seat-dispatch.js'
import { loadTickConfig } from '../agents/burndown/source.js'
import { configPath } from '../paths.js'

/** CC-245: the seat dispatch policy that CC-205 seats mode resolves from the charter and a seat file. */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'autonomy-2026-09-29')
const HOME = '/tmp/home'

const withSeat = (policy: Policy, name: string, patch: Record<string, unknown>): Policy => ({
  ...policy,
  seats: { ...policy.seats, [name]: { ...policy.seats[name], ...patch } as Policy['seat'] },
})

describe('spawn config maxAgents', () => {
  const load = (maxAgents: number) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc668-')), 'burndown.config.json')
    fs.writeFileSync(file, JSON.stringify({ enabled: true, maxAgents }))
    return loadTickConfig(file)
  }

  it.each([0, -1])('refuses maxAgents %i', maxAgents => {
    expect(() => load(maxAgents)).toThrow(/maxAgents/)
  })
})

describe('resolveSeatDispatch', () => {
  let policy: Policy
  let agentChatHome: string
  const writeConfig = (config: Record<string, unknown>) =>
    fs.writeFileSync(configPath(), JSON.stringify(config))
  const withoutCharterReserve = (): Policy => {
    const { worktrees_left_free_per_repo: _free, ...defaults } = policy.charter.defaults
    return { ...policy, charter: { ...policy.charter, defaults } }
  }
  beforeEach(() => {
    policy = loadPolicy(FIXTURE, 'seat-a')
    agentChatHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc872-'))
    process.env.AGENT_CHAT_HOME = agentChatHome
  })
  afterEach(() => {
    delete process.env.AGENT_CHAT_HOME
    fs.rmSync(agentChatHome, { recursive: true, force: true })
  })

  it('resolves prefix, pool, repos, caps, worktree caps, excluded tags and grants for seat-a', () => {
    const dispatch = resolveSeatDispatch(policy, 'seat-a', HOME)

    expect(dispatch).toEqual({
      seat: 'seat-a',
      prefix: 'sa',
      pool: expect.objectContaining({ name: 'pool-x', config_dir: '/tmp/pool-x', human_uses: true }),
      configDir: '/tmp/pool-x',
      repos: { 'init-alpha': ['/tmp/repos/alpha-app', '/tmp/repos/alpha-docs'] },
      nonGitRepos: [],
      caps: { implementers: 4, reviewers: 2, planners: 1 },
      worktrees: { perRepoPerSeat: 3, capName: 'worktrees_per_repo_per_seat', leftFreePerRepo: 2 },
      excludedTags: ['human-only', 'blocked'],
      grants: ['grant-merge-alpha'],
    })
  })

  it('takes the pool config_dir when the seat names none and expands a home-relative repo path', () => {
    const capped = withSeat(policy, 'seat-b', { concurrency: { implementers: 1 } })
    const dispatch = resolveSeatDispatch(capped, 'seat-b', HOME)

    expect(dispatch.configDir).toBe('/tmp/pool-y')
    expect(dispatch.repos).toEqual({
      'init-beta': ['/tmp/home/repos/beta'],
      'init-gamma': ['/tmp/home/repos/beta'],
    })
  })

  it('gives no grants to a seat without grants_extra', () => {
    const dispatch = resolveSeatDispatch(
      withSeat(policy, 'seat-b', { concurrency: { implementers: 1 } }),
      'seat-b',
      HOME,
    )

    expect(dispatch.grants).toEqual([])
  })

  it('refuses a seat with no concurrency block', () => {
    expect(() => resolveSeatDispatch(policy, 'seat-b', HOME)).toThrow(
      /seat-b concurrency\.implementers is unset/,
    )
  })

  it.each([0, -1])('refuses a seat whose implementers cap is %i', implementers => {
    const bad = withSeat(policy, 'seat-a', { concurrency: { implementers, reviewers: 1, planners: 1 } })

    expect(() => resolveSeatDispatch(bad, 'seat-a', HOME)).toThrow(/not positive/)
  })

  it('refuses the hub seat', () => {
    expect(() => resolveSeatDispatch(policy, 'seat-hub', HOME)).toThrow('seat-hub is the hub seat')
  })

  it('refuses a seat whose role is hub even when the charter names another hub', () => {
    const renamed = { ...policy, charter: { ...policy.charter, hub: 'seat-b' } }
    const hub = withSeat(renamed, 'seat-hub', { prefix: 'sh', pool: 'pool-x' })

    expect(() => resolveSeatDispatch(hub, 'seat-hub', HOME)).toThrow('seat-hub is the hub seat')
  })

  it('resolves the seat the charter names as hub like any seat when its role is not hub', () => {
    const concurrency = { implementers: 2, reviewers: 1, planners: 0 }
    const hub = withSeat(policy, 'seat-hub', { role: 'coordinator', prefix: 'sh', concurrency })

    const dispatch = resolveSeatDispatch(hub, 'seat-hub', HOME)

    expect(policy.charter.hub).toBe('seat-hub')
    expect(dispatch).toMatchObject({ seat: 'seat-hub', prefix: 'sh', caps: concurrency })
  })

  it('refuses a seat whose config_dir differs from its pool', () => {
    expect(() => resolveSeatDispatch(policy, 'seat-c', HOME)).toThrow(
      'seat-c config_dir /tmp/pool-x differs from pool pool-y (/tmp/pool-y)',
    )
  })

  it('refuses a seat that names an unknown pool', () => {
    const unknown = withSeat(policy, 'seat-a', { pool: 'pool-missing' })

    expect(() => resolveSeatDispatch(unknown, 'seat-a', HOME)).toThrow(
      'seat-a names unknown pool pool-missing',
    )
  })

  it('refuses a seat that names no pool', () => {
    const none = withSeat(policy, 'seat-a', { pool: undefined })

    expect(() => resolveSeatDispatch(none, 'seat-a', HOME)).toThrow('seat-a names unknown pool (none)')
  })

  it('refuses a seat without an agent-name prefix', () => {
    const bare = withSeat(policy, 'seat-a', { prefix: undefined })

    expect(() => resolveSeatDispatch(bare, 'seat-a', HOME)).toThrow('seat-a has no agent-name prefix')
  })

  it('refuses a name the charter does not list', () => {
    expect(() => resolveSeatDispatch(policy, 'nobody', HOME)).toThrow('nobody is not a seat')
  })

  it('gives leftFreePerRepo 2 with no charter key and no config key', () => {
    const dispatch = resolveSeatDispatch(withoutCharterReserve(), 'seat-a', HOME)

    expect(dispatch.worktrees.leftFreePerRepo).toBe(2)
  })

  it('reads leftFreePerRepo from config worktreeOwnerReserve', () => {
    writeConfig({ worktreeOwnerReserve: 3 })

    expect(resolveSeatDispatch(withoutCharterReserve(), 'seat-a', HOME).worktrees.leftFreePerRepo).toBe(3)
  })

  it('prefers the config value over a charter worktrees_left_free_per_repo', () => {
    writeConfig({ worktreeOwnerReserve: 3 })

    expect(resolveSeatDispatch(policy, 'seat-a', HOME).worktrees.leftFreePerRepo).toBe(3)
  })

  it('ignores a charter worktrees_left_free_per_repo when config sets none', () => {
    const defaults = { ...policy.charter.defaults, worktrees_left_free_per_repo: 5 }
    const charterOnly = { ...policy, charter: { ...policy.charter, defaults } }

    expect(resolveSeatDispatch(charterOnly, 'seat-a', HOME).worktrees.leftFreePerRepo).toBe(2)
  })

  it.each([-1, 1.5, '2', null])('refuses config worktreeOwnerReserve %j', value => {
    writeConfig({ worktreeOwnerReserve: value })

    expect(() => resolveSeatDispatch(policy, 'seat-a', HOME)).toThrow(/worktreeOwnerReserve/)
  })

  it("caps active trees at the seat's implementers when worktrees_per_repo_per_seat is absent", () => {
    const { worktrees_per_repo_per_seat: _cap, ...defaults } = policy.charter.defaults
    const uncapped = { ...policy, charter: { ...policy.charter, defaults } }

    const dispatch = resolveSeatDispatch(uncapped, 'seat-a', HOME)

    expect(dispatch.worktrees).toEqual({
      perRepoPerSeat: 4,
      capName: 'concurrency.implementers',
      leftFreePerRepo: 2,
    })
  })

  it('keeps implementers as the cap when worktrees_per_repo_per_seat is above them', () => {
    const defaults = { ...policy.charter.defaults, worktrees_per_repo_per_seat: 12 }
    const loose = { ...policy, charter: { ...policy.charter, defaults } }

    const dispatch = resolveSeatDispatch(loose, 'seat-a', HOME)

    expect(dispatch.worktrees).toMatchObject({ perRepoPerSeat: 4, capName: 'concurrency.implementers' })
  })

  it('honours a worktrees_per_repo_per_seat ceiling of 0 over the implementers', () => {
    const defaults = { ...policy.charter.defaults, worktrees_per_repo_per_seat: 0 }
    const closed = { ...policy, charter: { ...policy.charter, defaults } }

    const dispatch = resolveSeatDispatch(closed, 'seat-a', HOME)

    expect(dispatch.worktrees).toMatchObject({ perRepoPerSeat: 0, capName: 'worktrees_per_repo_per_seat' })
  })

  it('names implementers as the cap when the ceiling equals them', () => {
    const defaults = { ...policy.charter.defaults, worktrees_per_repo_per_seat: 4 }
    const level = { ...policy, charter: { ...policy.charter, defaults } }

    const dispatch = resolveSeatDispatch(level, 'seat-a', HOME)

    expect(dispatch.worktrees).toMatchObject({ perRepoPerSeat: 4, capName: 'concurrency.implementers' })
  })
})

describe('repoForTask', () => {
  let dispatch: SeatDispatch
  beforeEach(() => {
    dispatch = resolveSeatDispatch(loadPolicy(FIXTURE, 'seat-a'), 'seat-a', HOME)
  })

  it('uses the first listed repo when the task has no repo tag', () => {
    expect(repoForTask(dispatch, 'init-alpha', ['product'])).toBe('/tmp/repos/alpha-app')
  })

  it('ignores a tag of another key when choosing the first listed repo', () => {
    expect(repoForTask(dispatch, 'init-alpha', ['kind:alpha-docs'])).toBe('/tmp/repos/alpha-app')
  })

  it('uses the repo whose basename a repo tag names', () => {
    expect(repoForTask(dispatch, 'init-alpha', ['product', 'repo:alpha-docs'])).toBe('/tmp/repos/alpha-docs')
  })

  it('finds no repo when the tag names a repo the initiative does not list', () => {
    expect(repoForTask(dispatch, 'init-alpha', ['repo:beta'])).toBeUndefined()
  })

  it('finds no repo for an initiative the seat maps to none', () => {
    expect(repoForTask(dispatch, 'init-omega', [])).toBeUndefined()
  })
})

describe('seat schema', () => {
  it('reads repos default branch and leaves unknown keys in place', () => {
    const seat = parseSeat('---\nrepos:\n  - {path: /tmp/r, default: trunk, remote: x/r}\n---\n', 's')

    expect(seat.repos).toEqual([{ path: '/tmp/r', default: 'trunk', remote: 'x/r', initiatives: [] }])
  })

  it('rejects a negative concurrency cap', () => {
    expect(() => parseSeat('---\nconcurrency: {implementers: -1}\n---\n', 's')).toThrow(
      'seat file s is malformed',
    )
  })
})

describe('burndown.config.json seats', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-config-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('defaults to no seats when the config omits them', () => {
    const file = path.join(dir, 'burndown.config.json')
    fs.writeFileSync(file, JSON.stringify({ enabled: true }))

    expect(loadTickConfig(file).seats).toEqual([])
  })

  it('reads a list of seat names', () => {
    const file = path.join(dir, 'burndown.config.json')
    fs.writeFileSync(file, JSON.stringify({ seats: ['seat-a', 'seat-b'] }))

    expect(loadTickConfig(file).seats).toEqual(['seat-a', 'seat-b'])
  })

  it('rejects a seat entry that is not a name', () => {
    const file = path.join(dir, 'burndown.config.json')
    fs.writeFileSync(file, JSON.stringify({ seats: [''] }))

    expect(() => loadTickConfig(file)).toThrow('is malformed')
  })

  it('routes both exception classes to the owner when the config has no exceptions', () => {
    const file = path.join(dir, 'burndown.config.json')
    fs.writeFileSync(file, JSON.stringify({ enabled: true }))

    expect(loadTickConfig(file).exceptions.route).toEqual({ stalled: 'owner', failed: 'owner' })
  })

  it('leaves every brief gate off with a 14-day brief age when the config names none (CC-925)', () => {
    const file = path.join(dir, 'burndown.config.json')
    fs.writeFileSync(file, JSON.stringify({ enabled: true }))

    const config = loadTickConfig(file)

    expect(config.briefGate).toEqual({})
    expect(config.briefMaxAgeDays).toBe(14)
  })

  it('reads a per-seat brief gate and a brief age', () => {
    const file = path.join(dir, 'burndown.config.json')
    fs.writeFileSync(
      file,
      JSON.stringify({ briefGate: { 'seat-a': 'shadow', 'seat-b': 'on' }, briefMaxAgeDays: 7 }),
    )

    const config = loadTickConfig(file)

    expect(config.briefGate).toEqual({ 'seat-a': 'shadow', 'seat-b': 'on' })
    expect(config.briefMaxAgeDays).toBe(7)
  })

  it.each([{ briefGate: { 'seat-a': 'enforce' } }, { briefMaxAgeDays: 0 }, { briefMaxAgeDays: 1.5 }])(
    'rejects the brief gate config %j',
    config => {
      const file = path.join(dir, 'burndown.config.json')
      fs.writeFileSync(file, JSON.stringify(config))

      expect(() => loadTickConfig(file)).toThrow('is malformed')
    },
  )

  it.each(['gate-trip', 'unknown'])('rejects a %s key under exceptions.route', key => {
    const file = path.join(dir, 'burndown.config.json')
    fs.writeFileSync(file, JSON.stringify({ exceptions: { route: { [key]: 'triage' } } }))

    expect(() => loadTickConfig(file)).toThrow('is malformed')
  })
})
