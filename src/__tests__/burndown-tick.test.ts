import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../agents/burndown/exec.js'
import { execute, spawnFrame, type SpawnFrame, type SpawnReply } from '../agents/burndown/execute.js'
import { readLedger, writeLedger, type Claim } from '../agents/burndown/ledger.js'
import { tickFromDisk, type TickBroker } from '../agents/burndown/run-tick.js'
import { TRUST_RULE_CLI_VERSION } from '../agents/trust.js'
import { burndownLedgerPath, burndownPausePath } from '../paths.js'
import type { AgentIdentity } from '../protocol.js'

/**
 * `burndown tick` over a fixture world: a real git repo, an active-work root,
 * one account's status cache and trust file, and a fake broker that records
 * every frame. Nothing here reaches the live broker or the developer's files.
 */

let world: string
const saved = { ...process.env }
const NOON = new Date(2026, 8, 26, 12, 0)

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })

const repo = (): string => path.join(world, 'repo')
const accountPath = (): string => path.join(world, 'profiles', 'agents')

const task = (id: string, priority = 3): string =>
  `id: ${id}\ntitle: Do ${id}\npriority: ${priority}\nestimate: 1\ndone_when: unit tests cover the new branch\nstatus: open\ntags:\n  - agent-chat\n`

function initiative(tasks: Record<string, string>): void {
  const autonomy = `autonomy:\n  mode: burndown\n  lanes: 1\n  accounts: [agents]\n  grants: []\n  repo: ${repo()}\n`
  write(
    path.join(world, 'aw', 'demo', 'brief.md'),
    `---\ntitle: Demo\nstate: focused\nrank: 1\nprofile: agents\n${autonomy}---\n# Demo\n`,
  )
  for (const [id, text] of Object.entries(tasks))
    write(path.join(world, 'aw', 'demo', 'tasks', `${id}.yml`), text)
}

function account(): void {
  const rate_limits = { seven_day: { used_percentage: 40 }, five_hour: { used_percentage: 10 } }
  write(
    path.join(accountPath(), 'status-cache', 'sessions', 's1.json'),
    JSON.stringify({ session_id: 's1', written_at: NOON.getTime() / 1000 - 30, rate_limits }),
  )
  const projects = { [repo()]: { hasTrustDialogAccepted: true } }
  write(path.join(accountPath(), '.claude.json'), JSON.stringify({ projects }))
}

function installClaude(): void {
  const target = path.join(world, 'claude', 'versions', TRUST_RULE_CLI_VERSION)
  write(target, '')
  fs.chmodSync(target, 0o755)
  const link = path.join(world, 'bin', 'claude')
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(target, link)
  process.env.AGENT_CHAT_CLAUDE = link
}

function config(extra: Record<string, unknown> = {}): void {
  const base = { enabled: true, reportTo: 'coord', maxAgents: 3, reserveSlots: 2 }
  write(path.join(world, 'home', 'burndown.config.json'), JSON.stringify({ ...base, ...extra }))
}

const row = (name: string, state: AgentIdentity['state'], cwd = repo()): AgentIdentity => ({
  agentId: `id-${name}`,
  name,
  profile: 'bd-implementer',
  state,
  origin: 'spawned',
  spawnedBy: 'human',
  spawnedAt: NOON.getTime(),
  brief: '',
  cwd,
  isolation: 'worktree',
  surface: 'headless',
  sessionId: '',
  configDir: accountPath(),
  lastEventAt: NOON.getTime(),
  generation: 1,
})

interface Fake {
  broker: TickBroker
  frames: SpawnFrame[]
  rosterCalls: number
}

function fakeBroker(
  opts: {
    agents?: AgentIdentity[]
    slots?: { held: number; cap: number }
    spawn?: (frame: SpawnFrame) => SpawnReply
  } = {},
): Fake {
  const fake: Fake = {
    frames: [],
    rosterCalls: 0,
    broker: {
      roster: async () => {
        fake.rosterCalls += 1
        return { agents: opts.agents ?? [], slots: opts.slots ?? { held: 4, cap: 36 } }
      },
      inboxSince: async () => [],
      spawn: async frame => {
        fake.frames.push(frame)
        return opts.spawn?.(frame) ?? { ok: true, agentId: `id-${frame.name}` }
      },
      retire: async () => ({ ok: true }),
    },
  }
  return fake
}

const tick = (fake: Fake, dryRun = false, log: (e: string, d: Record<string, unknown>) => void = () => {}) =>
  tickFromDisk({ dryRun, broker: fake.broker, now: NOON, log })

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-tick-')))
  process.env.AGENT_CHAT_HOME = path.join(world, 'home')
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(world, 'aw')
  process.env.CLAUDE_PROFILE_ROOT = path.join(world, 'profiles')
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.AGENT_CHAT_STATUS_CACHE
  write(path.join(world, 'home', 'config.json'), JSON.stringify({ worktreeBudget: 10 }))
  fs.mkdirSync(repo(), { recursive: true })
  git(repo(), 'init', '-q', '-b', 'main')
  git(repo(), 'commit', '-q', '--allow-empty', '-m', 'init')
  installClaude()
  account()
  config()
})

afterEach(() => {
  process.env = { ...saved }
  fs.rmSync(world, { recursive: true, force: true })
})

describe('burndown tick spawns', () => {
  it('sends configDir for the chosen account even when CLAUDE_CONFIG_DIR is unset, headless', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const fake = fakeBroker()

    await tick(fake)

    expect(fake.frames).toEqual([
      expect.objectContaining({
        t: 'spawn',
        name: 'bd-dm-1',
        profile: 'bd-implementer-lite',
        cwd: repo(),
        configDir: accountPath(),
        surface: 'headless',
        briefing: 'demo',
        tags: ['burndown', 'task:DM-1'],
      }),
    ])
    expect(fake.frames[0]?.brief).toContain('`chat_send` to coord')
  })

  it('records the claim in spawning and logs the intent before the frame is sent', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const logged: string[] = []
    let seenAtSend: Claim | undefined
    let loggedAtSend: string[] = []
    const fake = fakeBroker({
      spawn: () => {
        seenAtSend = readLedger(burndownLedgerPath()).claims[0]
        loggedAtSend = [...logged]
        return { ok: true, agentId: 'a-1' }
      },
    })

    await tick(fake, false, event => logged.push(event))

    expect(seenAtSend).toMatchObject({ taskId: 'DM-1', phase: 'spawning', agentName: 'bd-dm-1' })
    expect(loggedAtSend).toEqual(['burndown_spawn_intent'])
    const after = readLedger(burndownLedgerPath())
    expect(after.claims[0]).toMatchObject({
      agentId: 'a-1',
      worktree: path.join(repo(), '.worktrees', 'bd-dm-1'),
    })
    expect(after.lastTickAt).toBe(NOON.toISOString())
  })

  it('refuses to send a spawn whose claim was never recorded', async () => {
    const frames: SpawnFrame[] = []
    const frame = spawnFrame({
      name: 'bd-x',
      profile: 'bd-implementer',
      brief: 'b',
      cwd: repo(),
      configDir: accountPath(),
      initiative: 'demo',
      taskId: 'X',
    })

    const result = await execute(
      [{ kind: 'spawn', key: { taskId: 'X' }, frame }],
      { version: 1, claims: [] },
      {
        ledgerFile: burndownLedgerPath(),
        spawn: async f => (frames.push(f), { ok: true }),
        retire: async () => ({ ok: true }),
        log: () => {},
        now: NOON,
      },
    )

    expect(frames).toEqual([])
    expect(result.lines[0]).toContain('no spawning claim recorded')
  })

  it('stalls the claim and names the leftover worktree when the spawn fails after allocation', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const fake = fakeBroker({ spawn: () => ({ ok: false, reason: 'spawn failed: claude exited 1' }) })

    await tick(fake)

    expect(readLedger(burndownLedgerPath()).claims[0]?.stalledReason).toContain(
      `${repo()}/.worktrees/bd-dm-1 may be left behind`,
    )
  })
})

describe('burndown tick ceilings', () => {
  it('refuses with kind slots when the broker has no free slot beyond the reserve', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const fake = fakeBroker({ slots: { held: 34, cap: 36 } })

    const lines = await tick(fake)

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('refused demo DM-1 [slots]')
  })

  it('counts live burndown agents against maxAgents', async () => {
    config({ maxAgents: 1 })
    initiative({ 'DM-1': task('DM-1') })
    const done: Claim = {
      taskId: 'OLD',
      initiative: 'other',
      spawnedAt: NOON.toISOString(),
      phase: 'done',
      phaseAt: NOON.toISOString(),
      spawned: ['bd-old'],
    }
    writeLedger(burndownLedgerPath(), { version: 1, claims: [done] })
    const fake = fakeBroker({ agents: [row('bd-old', 'live')] })

    const lines = await tick(fake)

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('1 of maxAgents 1 burndown agents alive')
  })

  it('refuses with kind worktrees at 7 of a budget of 10 with a reserve of 3', async () => {
    initiative({ 'DM-1': task('DM-1') })
    for (let i = 0; i < 7; i++)
      git(repo(), 'worktree', 'add', '-q', '-b', `w${i}`, path.join('.worktrees', `w${i}`))
    const fake = fakeBroker()

    const lines = await tick(fake)

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('refused demo DM-1 [worktrees]: 7 worktrees')
  })

  it('reports a branch left by a failed spawn and dispatches the next task instead', async () => {
    initiative({ 'DM-1': task('DM-1', 1), 'DM-2': task('DM-2', 2) })
    git(repo(), 'branch', 'agent-chat/bd-dm-1')
    const fake = fakeBroker()

    const lines = await tick(fake)

    expect(lines.join('\n')).toContain('refused demo DM-1 [orphan]: branch agent-chat/bd-dm-1')
    expect(fake.frames.map(f => f.name)).toEqual(['bd-dm-2'])
  })
})

describe('burndown tick gates', () => {
  it('does nothing while another tick holds the lock', async () => {
    initiative({ 'DM-1': task('DM-1') })
    write(`${burndownLedgerPath()}.lock`, `${process.pid}\n`)
    const fake = fakeBroker()

    const lines = await tick(fake)

    expect(lines.join('\n')).toContain('another tick holds the ledger lock')
    expect(fake.rosterCalls).toBe(0)
    expect(fs.existsSync(burndownLedgerPath())).toBe(false)
  })

  it('does nothing when disabled, paused, or without a reportTo', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const fake = fakeBroker()

    config({ enabled: false })
    expect((await tick(fake))[0]).toContain('disabled')
    config({ reportTo: undefined })
    expect((await tick(fake))[0]).toContain('no reportTo')
    config()
    write(burndownPausePath(), 'now')
    expect((await tick(fake))[0]).toContain('paused')

    expect(fake.rosterCalls).toBe(0)
  })

  it('dry run prints the spawn and writes and sends nothing', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const fake = fakeBroker()

    const lines = await tick(fake, true)

    expect(lines.join('\n')).toContain(
      `would spawn bd-dm-1 as bd-implementer-lite (headless) on ${accountPath()}`,
    )
    expect(fake.frames).toEqual([])
    expect(fs.existsSync(burndownLedgerPath())).toBe(false)
  })
})

describe('burndown tick advances claims', () => {
  it('spawns a reviewer in the worktree of an implementer that exited with commits', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const worktree = path.join(repo(), '.worktrees', 'bd-dm-1')
    git(repo(), 'worktree', 'add', '-q', '-b', 'agent-chat/bd-dm-1', worktree)
    git(worktree, 'commit', '-q', '--allow-empty', '-m', 'work')
    const claim: Claim = {
      taskId: 'DM-1',
      initiative: 'demo',
      spawnedAt: NOON.toISOString(),
      phase: 'implementing',
      phaseAt: NOON.toISOString(),
      agentName: 'bd-dm-1',
      spawned: ['bd-dm-1'],
      worktree,
    }
    writeLedger(burndownLedgerPath(), { version: 1, claims: [claim] })
    const fake = fakeBroker({ agents: [row('bd-dm-1', 'exited', worktree)] })

    await tick(fake)

    expect(fake.frames).toEqual([
      expect.objectContaining({
        name: 'bd-dm-1-r0',
        profile: 'bd-reviewer',
        cwd: worktree,
        configDir: accountPath(),
      }),
    ])
    expect(readLedger(burndownLedgerPath()).claims[0]).toMatchObject({
      phase: 'spawning',
      nextPhase: 'reviewing',
    })
  })
})

describe('tick subprocesses', () => {
  it('never pass the agent-chat identity to a child', () => {
    process.env.AGENT_CHAT_NAME = 'parent'
    process.env.AGENT_CHAT_AGENT_ID = 'parent-id'

    const env = run('/usr/bin/env', []).stdout

    expect(env).not.toContain('AGENT_CHAT_NAME')
    expect(env).not.toContain('AGENT_CHAT_AGENT_ID')
    expect(env).toContain('AGENT_CHAT_HOME')
  })
})
