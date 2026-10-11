import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { transcriptPath } from '../agents/transcript.js'
import { NO_VERDICT, parkReviewerAtReport } from '../agents/isolation/park-reviewer-at-report.js'
import type { AgentIdentity } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

const logged = vi.hoisted(() => vi.fn<(event: string, detail: Record<string, unknown>) => void>())
vi.mock('../broker/log.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../broker/log.js')>()),
  logEvent: logged,
}))

/**
 * CC-976: a reviewer spawned in a primary checkout gets a CC-916 tree under `.worktrees`; once it
 * exits on its final Verdict the broker parks that tree, with CC-921's opt-in off.
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
  const dir = tmp('rvpark-repo-')
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'seed'], dir)
  return dir
}

function writeProfile(home: string, name: string): void {
  fs.writeFileSync(
    path.join(home, 'profiles', `${name}.json`),
    JSON.stringify({
      description: name,
      model: 'sonnet',
      allowedTools: ['Read', 'Bash'],
      isolation: 'none',
      surface: 'headless',
    }),
  )
}

async function spawnIn(name: string, repo: string, profile: string): Promise<AgentIdentity> {
  const spawned = await sup.spawn({
    name,
    profile,
    brief: 'review the change',
    requestedBy: 'coord-a',
    cwd: repo,
    surface: 'headless' as const,
    spawnerConfigDir: tmp('rvpark-account-'),
  })
  expect(spawned.reason).toBeUndefined()
  return core.agents.get(spawned.agentId as string)!
}

const reviewer = async (name = 'rv-x'): Promise<AgentIdentity> => {
  const agent = await spawnIn(name, makeRepo(), 'rv-readonly')
  expect(agent.cwd).toContain(`${path.sep}.worktrees${path.sep}`)
  return agent
}

const report = (agent: AgentIdentity, body: string): void =>
  void core.append({ kind: 'message', actor: agent.name, target: 'coord-a', body })

/** Shepherd's reviewers answer in their last assistant turn, not in a message. */
function finalTurn(agent: AgentIdentity, text: string): void {
  const file = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const row = {
    type: 'assistant',
    sessionId: agent.sessionId,
    cwd: agent.cwd,
    timestamp: new Date().toISOString(),
    uuid: 'a1',
    message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text }] },
  }
  fs.writeFileSync(file, `${JSON.stringify(row)}\n`)
}

async function exit(agent: AgentIdentity): Promise<void> {
  const recordExit = (sup as unknown as { recordExit: (id: string, o: unknown) => Promise<void> }).recordExit
  await recordExit.call(sup, agent.agentId, { code: 0, signal: null })
}

const parkedRows = (agentId: string) =>
  core.events.agentEvents().filter(r => r.kind === 'isolation_parked' && r.ref === agentId)

const branchKept = (repo: string, name: string): boolean =>
  git(['branch', '--list', `agent-chat/${name}`], repo) !== ''

const repoOf = (agent: AgentIdentity): string => path.dirname(path.dirname(agent.cwd))

const stateOf = (name: string): string | undefined =>
  core.agents.roster({ includeRetired: true }).findLast(a => a.name === name)?.state

const keptReason = (): unknown =>
  logged.mock.calls.findLast(([event]) => event === 'reviewer_park_kept')?.[1].reason

beforeEach(() => {
  const home = tmp('rvpark-home-')
  process.env.AGENT_CHAT_HOME = home
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  writeProfile(home, 'rv-readonly')
  writeProfile(home, 'implementer')
  fs.writeFileSync(path.join(home, 'config.json'), '{"worktreeBudget": 12}')
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
  logged.mockClear()
  sup = new Supervisor(core, {
    surface: {
      platform: 'linux',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
    },
    autoRetireOnReport: () => false,
  })
})

afterEach(() => {
  stopAutoAttach()
  sup.close()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('parking a reviewer at its final Verdict', () => {
  it.each(['MERGE', 'FIX_FIRST'])(
    'parks the tree after a Verdict: %s report, keeps the branch and does not retire',
    async verdict => {
      const agent = await reviewer()
      const repo = repoOf(agent)
      report(agent, `Verdict: ${verdict}\nPR: example/repo#1`)

      await exit(agent)

      expect(fs.existsSync(agent.cwd)).toBe(false)
      expect(branchKept(repo, 'rv-x')).toBe(true)
      expect(parkedRows(agent.agentId)).toHaveLength(1)
      expect(stateOf('rv-x')).not.toBe('retired')
    },
  )

  it("parks on a Verdict line in Shepherd's final assistant turn after a lead-in", async () => {
    const agent = await reviewer()
    finalTurn(agent, 'Read the diff.\n\nVerdict: MERGE\nPR: example/repo#1\nHead: abc')

    await exit(agent)

    expect(fs.existsSync(agent.cwd)).toBe(false)
    expect(parkedRows(agent.agentId)).toHaveLength(1)
  })

  it('keeps the tree while the review runs', async () => {
    const agent = await reviewer()
    report(agent, 'Verdict: MERGE\nPR: example/repo#1')

    expect(fs.existsSync(agent.cwd)).toBe(true)
    expect(parkedRows(agent.agentId)).toHaveLength(0)
  })

  it('keeps the tree of a reviewer that exits with no Verdict', async () => {
    const agent = await reviewer()
    finalTurn(agent, 'Still reading the diff.')

    await exit(agent)

    expect(fs.existsSync(agent.cwd)).toBe(true)
    expect(keptReason()).toBe(NO_VERDICT)
  })

  it('keeps the tree of an implementer that exits on Status: DONE', async () => {
    const agent = await spawnIn('cc-impl', makeRepo(), 'implementer')
    expect(agent.cwd).not.toBe('')
    report(agent, 'Status: DONE\nPR: example/repo#1')

    await exit(agent)

    expect(parkedRows(agent.agentId)).toHaveLength(0)
  })

  it('re-creates the parked tree at the same path on resume', async () => {
    const agent = await reviewer()
    finalTurn(agent, 'Verdict: FIX_FIRST\nPR: example/repo#1')
    await exit(agent)
    expect(fs.existsSync(agent.cwd)).toBe(false)

    const resumed = await sup.resume('rv-x')

    expect(resumed.reason).toBeUndefined()
    expect(fs.existsSync(agent.cwd)).toBe(true)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], agent.cwd)).toBe('agent-chat/rv-x')
  })
})

describe('parkReviewerAtReport', () => {
  it('resolves to a kept result when the event log is already closed', async () => {
    const closed = (): never => {
      throw new Error('database is not open')
    }
    const port = { current: closed, events: closed, lastReport: closed, finalText: closed, park: closed }

    const result = await parkReviewerAtReport(port, 'agent-1')

    expect(result).toEqual({ action: 'kept', name: 'agent-1', reason: 'database is not open' })
  })
})
