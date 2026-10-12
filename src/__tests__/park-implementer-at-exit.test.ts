import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor, type SupervisorOptions } from '../agents/supervisor.js'
import { transcriptPath } from '../agents/transcript.js'
import { resolveAutoParkOnExit } from '../config.js'
import type { AgentIdentity } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

const logged = vi.hoisted(() => vi.fn<(event: string, detail: Record<string, unknown>) => void>())
vi.mock('../broker/log.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../broker/log.js')>()),
  logEvent: logged,
}))

/**
 * CC-1039: a spawned non-reviewer worktree agent's tree is parked when it exits normally, under the
 * `agent park` rules and without waiting for CI; anything that would lose work keeps the tree.
 */

const tmpDirs: string[] = []
let home: string
let cwdProcs: () => Promise<{ pid: number; cwd: string }[]>
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
  const dir = tmp('implpark-repo-')
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'seed'], dir)
  return dir
}

function repoWithOrigin(): string {
  const repo = makeRepo()
  const origin = tmp('implpark-origin-')
  git(['init', '--bare', '-b', 'main'], origin)
  git(['remote', 'add', 'origin', origin], repo)
  git(['push', '-q', 'origin', 'main'], repo)
  return repo
}

const commitIn = (dir: string, file: string): string => {
  fs.writeFileSync(path.join(dir, file), 'work\n')
  git(['add', file], dir)
  git(['commit', '-m', `add ${file}`], dir)
  return git(['rev-parse', 'HEAD'], dir)
}

function writeProfile(name: string, isolation: 'none' | 'worktree'): void {
  fs.writeFileSync(
    path.join(home, 'profiles', `${name}.json`),
    JSON.stringify({
      description: name,
      model: 'sonnet',
      allowedTools: ['Read', 'Bash'],
      isolation,
      surface: 'headless',
    }),
  )
}

function writeTranscript(agent: AgentIdentity, records: object[]): void {
  const file = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n')
}

async function spawnIn(name: string, repo: string, profile = 'implementer'): Promise<AgentIdentity> {
  const spawned = await sup.spawn({
    name,
    profile,
    brief: 'do the task',
    requestedBy: 'coord-a',
    cwd: repo,
    surface: 'headless' as const,
    spawnerConfigDir: tmp('implpark-account-'),
  })
  expect(spawned.reason).toBeUndefined()
  const agent = core.agents.get(spawned.agentId as string)!
  writeTranscript(agent, [{}])
  return agent
}

/** A worker that pushed its HEAD and exits clean. */
async function pushedWorker(
  name = 'worker-a',
): Promise<{ agent: AgentIdentity; repo: string; pushed: string }> {
  const repo = repoWithOrigin()
  const agent = await spawnIn(name, repo)
  const pushed = commitIn(agent.cwd, 'feature.ts')
  git(['push', '-q', 'origin', `agent-chat/${name}`], agent.cwd)
  return { agent, repo, pushed }
}

async function exit(agent: AgentIdentity, outcome: Record<string, unknown> = {}): Promise<void> {
  const recordExit = (sup as unknown as { recordExit: (id: string, o: unknown) => Promise<void> }).recordExit
  await recordExit.call(sup, agent.agentId, { code: 0, signal: null, ...outcome })
}

function makeSupervisor(over: Partial<SupervisorOptions> = {}): Supervisor {
  return new Supervisor(core, {
    cwdLister: () => cwdProcs(),
    surface: {
      platform: 'linux',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
    },
    autoRetireOnReport: () => false,
    autoParkOnExit: () => true,
    ...over,
  })
}

const parkedRows = (agentId: string) =>
  core.events.agentEvents().filter(r => r.kind === 'isolation_parked' && r.ref === agentId)

const loggedAs = (event: string) => logged.mock.calls.filter(([e]) => e === event).map(([, d]) => d)

const keptReason = (): unknown => loggedAs('implementer_park_kept').at(-1)?.reason

const implementerLogs = () => logged.mock.calls.filter(([e]) => e.startsWith('implementer_'))

beforeEach(() => {
  home = tmp('implpark-home-')
  process.env.AGENT_CHAT_HOME = home
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  writeProfile('implementer', 'worktree')
  writeProfile('rv-readonly', 'none')
  fs.writeFileSync(path.join(home, 'config.json'), '{"worktreeBudget": 12}')
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
  cwdProcs = async () => []
  logged.mockClear()
  sup = makeSupervisor()
})

afterEach(() => {
  stopAutoAttach()
  sup.close()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('an implementer that exits normally', () => {
  it('has its pushed tree parked and its branch kept, with no CI read', async () => {
    const { agent, repo, pushed } = await pushedWorker()

    await exit(agent)

    expect(fs.existsSync(agent.cwd)).toBe(false)
    expect(git(['rev-parse', 'agent-chat/worker-a'], repo)).toBe(pushed)
    expect(parkedRows(agent.agentId)).toHaveLength(1)
    expect(loggedAs('implementer_parked')).toEqual([expect.objectContaining({ name: 'worker-a' })])
  })

  it('keeps a tree holding a commit origin does not have', async () => {
    const { agent } = await pushedWorker()
    commitIn(agent.cwd, 'more.ts')

    await exit(agent)

    expect(fs.existsSync(agent.cwd)).toBe(true)
    expect(parkedRows(agent.agentId)).toEqual([])
    expect(keptReason()).toMatch(/not on origin/)
    expect(loggedAs('implementer_parked')).toEqual([])
  })

  it('keeps a tree with an uncommitted file', async () => {
    const { agent } = await pushedWorker()
    fs.writeFileSync(path.join(agent.cwd, 'scratch.ts'), 'wip\n')

    await exit(agent)

    expect(fs.existsSync(agent.cwd)).toBe(true)
    expect(keptReason()).toMatch(/uncommitted/)
  })

  it('parks a tree whose HEAD origin holds only under a differently named PR head', async () => {
    const repo = repoWithOrigin()
    const agent = await spawnIn('worker-a', repo)
    commitIn(agent.cwd, 'feature.ts')
    git(['push', '-q', 'origin', 'HEAD:agent-chat/pr-head'], agent.cwd)

    await exit(agent)

    expect(fs.existsSync(agent.cwd)).toBe(false)
    expect(loggedAs('implementer_parked')).toHaveLength(1)
  })

  it('keeps a tree whose PR head was deleted on origin, despite a stale tracking ref', async () => {
    const repo = repoWithOrigin()
    const agent = await spawnIn('worker-a', repo)
    commitIn(agent.cwd, 'feature.ts')
    git(['push', '-q', 'origin', 'HEAD:agent-chat/pr-head'], agent.cwd)
    git(['branch', '-q', '-D', 'agent-chat/pr-head'], git(['remote', 'get-url', 'origin'], repo))

    await exit(agent)

    expect(fs.existsSync(agent.cwd)).toBe(true)
    expect(keptReason()).toMatch(/not on origin/)
  })

  it('is re-created by resume at the same path, on the kept PR branch and pushed head', async () => {
    const repo = repoWithOrigin()
    const agent = await spawnIn('worker-a', repo)
    git(['checkout', '-q', '-b', 'agent-chat/pr-branch'], agent.cwd)
    const pushed = commitIn(agent.cwd, 'feature.ts')
    git(['push', '-q', 'origin', 'agent-chat/pr-branch'], agent.cwd)
    await exit(agent)
    expect(fs.existsSync(agent.cwd)).toBe(false)

    const resumed = await sup.resume('worker-a')

    expect(resumed.reason).toBeUndefined()
    expect(git(['symbolic-ref', '--short', 'HEAD'], agent.cwd)).toBe('agent-chat/pr-branch')
    expect(git(['rev-parse', 'HEAD'], agent.cwd)).toBe(pushed)
    expect(git(['rev-parse', 'agent-chat/pr-branch'], repo)).toBe(pushed)
  })

  it('keeps a tree a process still has as its working directory', async () => {
    const { agent } = await pushedWorker()
    cwdProcs = async () => [{ pid: 777, cwd: path.join(agent.cwd, 'src') }]

    await exit(agent)

    expect(fs.existsSync(agent.cwd)).toBe(true)
    expect(keptReason()).toMatch(/process 777 has its working directory/)
  })
})

describe('when the exit park does not run', () => {
  it('leaves the tree alone and logs nothing when autoPark.onExit is off', async () => {
    sup.close()
    sup = makeSupervisor({ autoParkOnExit: () => false })
    const { agent } = await pushedWorker()

    await exit(agent)

    expect(fs.existsSync(agent.cwd)).toBe(true)
    expect(implementerLogs()).toEqual([])
  })

  it('keeps a tree a held burndown claim still reads, with the claim as the reason', async () => {
    sup.close()
    const hold = vi.fn((_tree: string) => 'burndown claim CC-1 holds the tree in phase reviewing')
    sup = makeSupervisor({ burndownTreeHold: hold })
    const { agent } = await pushedWorker()

    await exit(agent)

    expect(fs.existsSync(agent.cwd)).toBe(true)
    expect(hold).toHaveBeenCalledWith(agent.cwd)
    expect(keptReason()).toBe('burndown claim CC-1 holds the tree in phase reviewing')
  })

  it('does not park an agent about to be resumed for a pending background task', async () => {
    const { agent } = await pushedWorker()
    writeTranscript(agent, [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Bash',
              input: { command: 'sleep 9', run_in_background: true },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'Command running in background with ID: b7' },
          ],
        },
      },
    ])

    await exit(agent)

    expect(parkedRows(agent.agentId)).toEqual([])
    expect(fs.existsSync(agent.cwd)).toBe(true)
  })

  it('does not park after a failed exit', async () => {
    const { agent } = await pushedWorker()

    await exit(agent, { failed: 'never attached' })

    expect(fs.existsSync(agent.cwd)).toBe(true)
    expect(implementerLogs()).toEqual([])
  })

  it('leaves a reviewer to the CC-976 rule', async () => {
    const reviewer = await spawnIn('rv-x', makeRepo(), 'rv-readonly')
    expect(reviewer.cwd).toContain(`${path.sep}.worktrees${path.sep}`)

    await exit(reviewer)

    expect(fs.existsSync(reviewer.cwd)).toBe(true)
    expect(implementerLogs()).toEqual([])
  })
})

describe('reading autoPark.onExit', () => {
  const writeConfig = (config: unknown): void =>
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config))

  it('is on when the key is absent', () => {
    writeConfig({})
    expect(resolveAutoParkOnExit()).toBe(true)
  })

  it('is off when onExit is false', () => {
    writeConfig({ autoPark: { onExit: false } })
    expect(resolveAutoParkOnExit()).toBe(false)
  })

  it('reads a malformed value as on and logs it', () => {
    writeConfig({ autoPark: { onExit: 'no' } })

    expect(resolveAutoParkOnExit()).toBe(true)
    expect(loggedAs('config_invalid')).toEqual([expect.objectContaining({ key: 'autoPark.onExit' })])
  })
})
