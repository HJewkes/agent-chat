import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor, type SupervisorOptions } from '../agents/supervisor.js'
import { RECLAIM_GRACE_MS } from '../agents/isolation/worktree.js'
import {
  OPEN_PR_REASON,
  parseActiveRuns,
  type ShepherdRun,
  type ShepherdSkipPort,
} from '../agents/isolation/shepherd-skip.js'
import { NOT_FINISHED } from '../agents/isolation/retire-at-report.js'
import { resolveAutoRetireOnReport } from '../config.js'
import type { AgentIdentity } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

const logged = vi.hoisted(() => vi.fn<(event: string, detail: Record<string, unknown>) => void>())
vi.mock('../broker/log.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../broker/log.js')>()),
  logEvent: logged,
}))

const keptReason = (): unknown =>
  logged.mock.calls.findLast(([event]) => event === 'auto_retire_kept')?.[1].reason

/**
 * CC-921: an opted-in spawner's agent that exits on a final report is parked and retired
 * by the broker, with the CC-904 open-PR and Shepherd rule shared with `retire --finished`.
 */

const tmpDirs: string[] = []
let home: string
let core: BrokerCore
let sup: Supervisor
let stopAutoAttach: () => void
let shepherd: { runs: () => Promise<ShepherdRun[]>; openPr: boolean | Error }

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

function makeRepo(): string {
  const dir = tmp('auto-repo-')
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'seed'], dir)
  return dir
}

/** A push made as a fetch from the bare side, so a machine-wide pre-push hook cannot fail the fixture. */
function publish(dir: string, branch: string): void {
  const origin = git(['remote', 'get-url', 'origin'], dir)
  git(['fetch', '-q', dir, `${branch}:${branch}`], origin)
  git(['fetch', '-q', 'origin'], dir)
}

function repoWithOrigin(): string {
  const repo = makeRepo()
  const origin = tmp('auto-origin-')
  git(['init', '--bare', '-b', 'main'], origin)
  git(['remote', 'add', 'origin', origin], repo)
  publish(repo, 'main')
  return repo
}

const commitIn = (dir: string, file: string): void => {
  fs.writeFileSync(path.join(dir, file), 'work\n')
  git(['add', file], dir)
  git(['commit', '-m', `add ${file}`], dir)
}

const fakeSkip: ShepherdSkipPort = {
  activeRuns: () => shepherd.runs(),
  hasOpenPr: () =>
    shepherd.openPr instanceof Error ? Promise.reject(shepherd.openPr) : Promise.resolve(shepherd.openPr),
}

function supervisor(over: Partial<SupervisorOptions> = {}): Supervisor {
  return new Supervisor(core, {
    surface: {
      platform: 'linux',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
    },
    shepherdSkip: fakeSkip,
    autoRetireOnReport: spawner => spawner === 'coord-a',
    ...over,
  })
}

async function spawnIn(
  name: string,
  repo: string,
  over: Record<string, unknown> = {},
): Promise<AgentIdentity> {
  const spawned = await sup.spawn({
    name,
    profile: 'explorer',
    brief: 'do the task',
    requestedBy: 'coord-a',
    cwd: repo,
    isolation: 'worktree' as const,
    surface: 'headless' as const,
    spawnerConfigDir: tmp('auto-account-'),
    ...over,
  })
  expect(spawned.reason).toBeUndefined()
  return core.agents.get(spawned.agentId as string)!
}

const report = (agent: AgentIdentity, body = 'Status: DONE\nPR: example/repo#1'): void =>
  void core.append({ kind: 'message', actor: agent.name, target: 'coord-a', body })

async function exit(agent: AgentIdentity): Promise<void> {
  const recordExit = (sup as unknown as { recordExit: (id: string, o: unknown) => Promise<void> }).recordExit
  await recordExit.call(sup, agent.agentId, { code: 0, signal: null })
}

/** A finished implementer: one commit, pushed to origin, then its final report. */
async function pushedImplementer(name: string): Promise<AgentIdentity> {
  const agent = await spawnIn(name, repoWithOrigin())
  commitIn(agent.cwd, 'feature.ts')
  publish(agent.cwd, `agent-chat/${name}`)
  report(agent)
  return agent
}

const stateOf = (name: string): string | undefined =>
  core.agents.roster({ includeRetired: true }).findLast(a => a.name === name)?.state

const branchKept = (agent: AgentIdentity, repo: string): boolean =>
  git(['branch', '--list', `agent-chat/${agent.name}`], repo) !== ''

const repoOf = (agent: AgentIdentity): string => path.dirname(path.dirname(fs.realpathSync(agent.cwd)))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  home = tmp('auto-home-')
  process.env.AGENT_CHAT_HOME = home
  fs.writeFileSync(path.join(home, 'config.json'), '{"worktreeBudget": 12}')
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
  shepherd = { runs: () => Promise.resolve([]), openPr: false }
  logged.mockClear()
  sup = supervisor()
})

afterEach(() => {
  stopAutoAttach()
  sup.close()
  vi.useRealTimers()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('retire at the final report', () => {
  it('retires a merged-PR implementer, removes its tree and keeps its branch', async () => {
    const agent = await pushedImplementer('cc-merged')
    const repo = repoOf(agent)

    await exit(agent)

    expect(keptReason()).toBeUndefined()

    expect(stateOf('cc-merged')).toBe('retired')
    expect(fs.existsSync(agent.cwd)).toBe(false)
    expect(branchKept(agent, repo)).toBe(true)
  })

  it('retires a reviewer that holds no branch', async () => {
    const agent = await spawnIn('cc-reviewer', makeRepo(), { isolation: 'none' })
    report(agent, 'Verdict: MERGE\nPR: example/repo#1')

    await exit(agent)

    expect(stateOf('cc-reviewer')).toBe('retired')
  })

  it('skips an implementer whose branch has an open PR', async () => {
    shepherd.openPr = true
    const agent = await pushedImplementer('cc-open')

    await exit(agent)

    expect(keptReason()).toBe(OPEN_PR_REASON)

    expect(stateOf('cc-open')).toBe('exited')
    expect(fs.existsSync(agent.cwd)).toBe(true)
  })

  it('skips an agent a live Shepherd run names by its branch', async () => {
    shepherd.runs = () => Promise.resolve([{ branch: 'agent-chat/cc-shep', names: [] }])
    const agent = await pushedImplementer('cc-shep')

    await exit(agent)

    expect(keptReason()).toBe(OPEN_PR_REASON)

    expect(stateOf('cc-shep')).toBe('exited')
  })

  it('retires nothing when Shepherd cannot be read', async () => {
    shepherd.runs = () => Promise.reject(new Error('connection refused'))
    const agent = await pushedImplementer('cc-dark')

    await exit(agent)

    expect(keptReason()).toMatch(/^Shepherd could not be read \(connection refused\)/)

    expect(stateOf('cc-dark')).toBe('exited')
    expect(fs.existsSync(agent.cwd)).toBe(true)
  })

  it('retires nothing when the open-PR read fails', async () => {
    shepherd.openPr = new Error('gh: not logged in')
    const agent = await pushedImplementer('cc-nogh')

    await exit(agent)

    expect(keptReason()).toBe('could not tell whether agent-chat/cc-nogh has an open PR (gh: not logged in)')

    expect(stateOf('cc-nogh')).toBe('exited')
  })

  it('keeps a dirty tree', async () => {
    const agent = await pushedImplementer('cc-dirty')
    fs.writeFileSync(path.join(agent.cwd, 'draft.txt'), 'unsaved\n')

    await exit(agent)

    expect(keptReason()).toBe(`uncommitted or untracked changes in ${agent.cwd}`)

    expect(stateOf('cc-dirty')).toBe('exited')
    expect(fs.existsSync(path.join(agent.cwd, 'draft.txt'))).toBe(true)
  })

  it('keeps a tree with unpushed commits', async () => {
    const agent = await pushedImplementer('cc-ahead')
    commitIn(agent.cwd, 'more.ts')

    await exit(agent)

    expect(keptReason()).toMatch(/1 commit\(s\) .* are not on origin\/agent-chat\/cc-ahead/)

    expect(stateOf('cc-ahead')).toBe('exited')
    expect(fs.existsSync(agent.cwd)).toBe(true)
  })

  it('keeps a tree a live agent works in', async () => {
    const agent = await pushedImplementer('cc-owner')
    await spawnIn('heir', agent.cwd, { worktree: agent.cwd, isolation: 'worktree' })

    await exit(agent)

    expect(keptReason()).toBe('heir (not retired) still works in its worktree')

    expect(stateOf('cc-owner')).toBe('exited')
    expect(fs.existsSync(agent.cwd)).toBe(true)
  })

  it('keeps an agent whose last report is not a final one', async () => {
    const agent = await pushedImplementer('cc-midway')
    report(agent, 'Status: IN PROGRESS')

    await exit(agent)

    expect(keptReason()).toBe(NOT_FINISHED)

    expect(stateOf('cc-midway')).toBe('exited')
  })

  // BLOCKED and NEEDS_CONTEXT wait on a follow-up resume, which a retired name cannot take.
  it.each(['BLOCKED', 'NEEDS_CONTEXT'])('keeps an agent whose final report is Status: %s', async status => {
    const name = `cc-${status.toLowerCase().replace('_', '-')}`
    const agent = await pushedImplementer(name)
    report(agent, `Status: ${status}\nPR: example/repo#1`)

    await exit(agent)

    expect(keptReason()).toBe(NOT_FINISHED)
    expect(stateOf(name)).toBe('exited')
    expect(fs.existsSync(agent.cwd)).toBe(true)
  })

  it('retires an agent whose final report is Status: DONE_WITH_CONCERNS', async () => {
    const agent = await pushedImplementer('cc-concerns')
    report(agent, 'Status: DONE_WITH_CONCERNS\nPR: example/repo#1')

    await exit(agent)

    expect(stateOf('cc-concerns')).toBe('retired')
  })

  it('does nothing for a spawner that did not opt in', async () => {
    sup.close()
    sup = supervisor({ autoRetireOnReport: () => false })
    const agent = await pushedImplementer('cc-off')

    await exit(agent)

    expect(logged.mock.calls.map(([event]) => event)).not.toContain('auto_retire_kept')

    expect(stateOf('cc-off')).toBe('exited')
  })
})

describe('retire --finished shares the CC-904 rule', () => {
  it('skips an agent whose branch has an open PR, with the Shepherd reason', async () => {
    shepherd.openPr = true
    sup.close()
    sup = supervisor({ autoRetireOnReport: () => false })
    const agent = await pushedImplementer('cc-bulk')
    await exit(agent)
    vi.setSystemTime(Date.now() + RECLAIM_GRACE_MS + 1_000)

    const out = await sup.retireFinished({ prefix: 'cc-' })

    expect(out.plan).toEqual([{ name: 'cc-bulk', action: 'skip', reason: OPEN_PR_REASON }])
  })
})

describe('the autoRetire config key', () => {
  const writeConfig = (config: unknown): void =>
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config))

  it('is off when the key is absent', () => {
    writeConfig({})
    expect(resolveAutoRetireOnReport('coord-a')).toBe(false)
  })

  it('is on for every spawner when onFinalReport is true', () => {
    writeConfig({ autoRetire: { onFinalReport: true } })
    expect(resolveAutoRetireOnReport('anyone')).toBe(true)
  })

  it('is on only for the listed spawners', () => {
    writeConfig({ autoRetire: { onFinalReport: ['coord-a'] } })
    expect([resolveAutoRetireOnReport('coord-a'), resolveAutoRetireOnReport('coord-b')]).toEqual([
      true,
      false,
    ])
  })

  it('reads a malformed value as off', () => {
    writeConfig({ autoRetire: { onFinalReport: 'yes' } })
    expect(resolveAutoRetireOnReport('coord-a')).toBe(false)
  })
})

describe('reading Shepherd runs', () => {
  it('keeps unfinished and unknown phases, and the names a row lists', () => {
    const stdout = JSON.stringify([
      { phase: 'done', branch: 'agent-chat/a' },
      { phase: 'review', branch: 'agent-chat/b', implementer: 'impl-b', reviewer: 'rv-b' },
      { phase: 'something-new', branch: null },
    ])

    expect(parseActiveRuns(stdout)).toEqual([
      { branch: 'agent-chat/b', names: ['impl-b', 'rv-b'] },
      { branch: null, names: [] },
    ])
  })

  it('rejects an answer that is not a JSON array', () => {
    expect(() => parseActiveRuns('{}')).toThrow('not a JSON array')
  })
})
