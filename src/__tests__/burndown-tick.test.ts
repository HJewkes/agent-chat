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
import { burndownLedgerPath, burndownPausePath, configPath } from '../paths.js'
import { tickBroker } from '../cli/burndown-broker.js'
import type { BrokerClient } from '../client/broker-client.js'
import type { AgentIdentity, QueueItem } from '../protocol.js'

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
  resumes: { name: string; message: string }[]
}

function fakeBroker(
  opts: {
    agents?: AgentIdentity[]
    slots?: { held: number; cap: number }
    spawn?: (frame: SpawnFrame) => SpawnReply
    queue?: QueueItem[]
    resume?: (name: string) => SpawnReply
  } = {},
): Fake {
  const fake: Fake = {
    frames: [],
    rosterCalls: 0,
    resumes: [],
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
      queue: async () => opts.queue ?? [],
      resume: async (name, message) => {
        fake.resumes.push({ name, message })
        return opts.resume?.(name) ?? { ok: true, agentId: `id-${name}` }
      },
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

const MINUTE = 60_000

const question = (minutesAgo: number, msgId = 'q1'): QueueItem => ({
  msgId,
  kind: 'question',
  from: 'bd-dm-1',
  text: 'which branch?',
  at: NOON.getTime() - minutesAgo * MINUTE,
  meta: {},
})

function deciderSetup(agentId = 'id-decider', extra: Record<string, unknown> = {}): void {
  config({ decider: { name: 'decider' }, ...extra })
  write(configPath(), JSON.stringify({ worktreeBudget: 10, decider: { agentId } }))
}

const deciderRow = (state: AgentIdentity['state'], agentId = 'id-decider'): AgentIdentity => ({
  ...row('decider', state),
  agentId,
  profile: 'decider',
  isolation: 'none',
})

const wakesAgo = (minutes: number[]): string[] =>
  minutes.map(m => new Date(NOON.getTime() - m * MINUTE).toISOString())

describe('burndown tick wakes the decider', () => {
  it('resumes the configured decider when a question has waited over 5 minutes', async () => {
    deciderSetup()
    const fake = fakeBroker({ agents: [deciderRow('exited')], queue: [question(6)] })

    const lines = await tick(fake)

    expect(fake.resumes.map(r => r.name)).toEqual(['decider'])
    expect(fake.resumes[0]?.message).toContain('`agent-chat inbox`')
    expect(fake.resumes[0]?.message).toContain('end your turn')
    expect(fake.resumes[0]?.message).not.toContain('which branch?')
    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('woke decider decider')
  })

  it('sends the broker resume frame headless with the wake message', async () => {
    const sent: unknown[] = []
    const client = {
      request: async (frame: unknown) => {
        sent.push(frame)
        return { t: 'spawn_result', ok: true, agentId: 'id-decider' }
      },
    } as unknown as BrokerClient

    await tickBroker(client).resume('decider', 'wake up')

    expect(sent).toEqual([{ t: 'resume', name: 'decider', surface: 'headless', message: 'wake up' }])
  })

  it('does not wake for a question younger than 5 minutes', async () => {
    deciderSetup()
    const fake = fakeBroker({ agents: [deciderRow('exited')], queue: [question(4)] })

    const lines = await tick(fake)

    expect(fake.resumes).toEqual([])
    expect(lines.join('\n')).toContain('no open question older than 5 minutes')
  })

  it('does not wake again for a question the decider already saw at its last wake', async () => {
    deciderSetup()
    writeLedger(burndownLedgerPath(), { version: 1, claims: [], decider: { wakes: wakesAgo([90]) } })
    const fake = fakeBroker({ agents: [deciderRow('exited')], queue: [question(120)] })

    await tick(fake)

    expect(fake.resumes).toEqual([])
  })

  it('refuses and records it when the roster agentId differs from config.json', async () => {
    deciderSetup('id-configured')
    const fake = fakeBroker({ agents: [deciderRow('exited', 'id-imposter')], queue: [question(6)] })

    const lines = await tick(fake)

    expect(fake.resumes).toEqual([])
    expect(lines.join('\n')).toContain('config.json names id-configured')
    expect(readLedger(burndownLedgerPath()).decider?.refused?.reason).toContain('id-imposter')
  })

  it('refuses and records it when the decider is retired', async () => {
    deciderSetup()
    const fake = fakeBroker({ agents: [deciderRow('retired')], queue: [question(6)] })

    const lines = await tick(fake)

    expect(fake.resumes).toEqual([])
    expect(lines.join('\n')).toContain('decider decider is retired')
    expect(readLedger(burndownLedgerPath()).decider?.refused?.reason).toContain('retired')
  })

  it('refuses and records it when no agent holds the decider name', async () => {
    deciderSetup()
    const fake = fakeBroker({ queue: [question(6)] })

    const lines = await tick(fake)

    expect(fake.resumes).toEqual([])
    expect(lines.join('\n')).toContain('no agent named decider')
    expect(readLedger(burndownLedgerPath()).decider?.refused).toBeDefined()
  })

  it('does not re-wake a decider that is already live', async () => {
    deciderSetup()
    const fake = fakeBroker({ agents: [deciderRow('live')], queue: [question(6)] })

    const lines = await tick(fake)

    expect(fake.resumes).toEqual([])
    expect(lines.join('\n')).toContain('already live')
    expect(readLedger(burndownLedgerPath()).decider).toBeUndefined()
  })

  it('stops at maxPerHour wakes in the last hour', async () => {
    deciderSetup()
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [],
      decider: { wakes: wakesAgo([50, 40, 30, 20]) },
    })
    const fake = fakeBroker({ agents: [deciderRow('exited')], queue: [question(10)] })

    const lines = await tick(fake)

    expect(fake.resumes).toEqual([])
    expect(lines.join('\n')).toContain('4 times in the last hour (maxPerHour 4)')
  })

  it('stops at maxPerDay wakes in the last day', async () => {
    deciderSetup()
    const day = Array.from({ length: 24 }, (_, i) => 70 + i * 55)
    writeLedger(burndownLedgerPath(), { version: 1, claims: [], decider: { wakes: wakesAgo(day.reverse()) } })
    const fake = fakeBroker({ agents: [deciderRow('exited')], queue: [question(10)] })

    const lines = await tick(fake)

    expect(fake.resumes).toEqual([])
    expect(lines.join('\n')).toContain('24 times in the last day (maxPerDay 24)')
  })

  it('counts the wake in the ledger, under the ledger lock, before the frame is sent', async () => {
    deciderSetup()
    let seen: { wakes: string[] | undefined; locked: boolean } | undefined
    const fake = fakeBroker({
      agents: [deciderRow('exited')],
      queue: [question(6)],
      resume: () => {
        seen = {
          wakes: readLedger(burndownLedgerPath()).decider?.wakes,
          locked: fs.existsSync(`${burndownLedgerPath()}.lock`),
        }
        return { ok: true }
      },
    })

    await tick(fake)

    expect(seen).toEqual({ wakes: [NOON.toISOString()], locked: true })
  })

  it('does not wake when maxAgents is already reached', async () => {
    deciderSetup(undefined, { maxAgents: 1 })
    const done: Claim = {
      taskId: 'OLD',
      initiative: 'other',
      spawnedAt: NOON.toISOString(),
      phase: 'done',
      phaseAt: NOON.toISOString(),
      spawned: ['bd-old'],
    }
    writeLedger(burndownLedgerPath(), { version: 1, claims: [done] })
    const fake = fakeBroker({ agents: [row('bd-old', 'live'), deciderRow('exited')], queue: [question(6)] })

    const lines = await tick(fake)

    expect(fake.resumes).toEqual([])
    expect(lines.join('\n')).toContain('no agent capacity: 1 of maxAgents 1')
  })

  it('takes the maxAgents slot a new task would have used, and a live decider holds it too', async () => {
    deciderSetup(undefined, { maxAgents: 1 })
    initiative({ 'DM-1': task('DM-1') })

    const waking = fakeBroker({ agents: [deciderRow('exited')], queue: [question(6)] })
    await tick(waking)
    const live = fakeBroker({ agents: [deciderRow('live')] })
    const lines = await tick(live)

    expect(waking.resumes.map(r => r.name)).toEqual(['decider'])
    expect(waking.frames).toEqual([])
    expect(live.frames).toEqual([])
    expect(lines.join('\n')).toContain('1 of maxAgents 1 burndown agents alive')
  })

  it('dry run names the wake and sends and writes nothing', async () => {
    deciderSetup()
    const fake = fakeBroker({ agents: [deciderRow('exited')], queue: [question(6)] })

    const lines = await tick(fake, true)

    expect(lines.join('\n')).toContain('would wake decider decider (headless) for 1 waiting question(s)')
    expect(fake.resumes).toEqual([])
    expect(fs.existsSync(burndownLedgerPath())).toBe(false)
  })
})

describe('the tick and config.json', () => {
  it('leaves config.json byte-identical across a wake and a refusal', async () => {
    deciderSetup()
    const before = fs.readFileSync(configPath())
    const mtime = fs.statSync(configPath()).mtimeMs

    await tick(fakeBroker({ agents: [deciderRow('exited')], queue: [question(6)] }))
    await tick(fakeBroker({ agents: [deciderRow('exited', 'id-other')], queue: [question(6, 'q2')] }))

    expect(fs.readFileSync(configPath())).toEqual(before)
    expect(fs.statSync(configPath()).mtimeMs).toBe(mtime)
  })

  it('no burndown module can reach the config.json path', () => {
    const dir = path.join(__dirname, '..', 'agents', 'burndown')
    const files = [
      ...fs.readdirSync(dir).map(f => path.join(dir, f)),
      path.join(__dirname, '..', 'cli', 'burndown-broker.ts'),
    ]

    const reaching = files.filter(f =>
      /\bconfigPath\b|\bwriteConfig\b|['"]config\.json['"]/.test(fs.readFileSync(f, 'utf8')),
    )

    expect(reaching).toEqual([])
  })
})
