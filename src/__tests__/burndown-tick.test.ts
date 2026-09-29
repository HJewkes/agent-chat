import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrokerView } from '../agents/burndown/collision.js'
import { run, type Runner } from '../agents/burndown/exec.js'
import { execute, spawnFrame, type SpawnFrame, type SpawnReply } from '../agents/burndown/execute.js'
import { readLedger, writeLedger, type Claim } from '../agents/burndown/ledger.js'
import { tickFromDisk, type TickBroker } from '../agents/burndown/run-tick.js'
import { renderStatus } from '../agents/burndown/tick.js'
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

function initiative(
  tasks: Record<string, string>,
  { slug = 'demo', at = repo(), lanes = 1, rank = 1 } = {},
): void {
  const autonomy = `autonomy:\n  mode: burndown\n  lanes: ${lanes}\n  accounts: [agents]\n  grants: []\n  repo: ${at}\n`
  write(
    path.join(world, 'aw', slug, 'brief.md'),
    `---\ntitle: ${slug}\nstate: focused\nrank: ${rank}\nprofile: agents\n${autonomy}---\n# ${slug}\n`,
  )
  for (const [id, text] of Object.entries(tasks))
    write(path.join(world, 'aw', slug, 'tasks', `${id}.yml`), text)
}

/** A second repo with its own bare origin, for checks that must stay scoped to one repo. */
function secondRepo(): string {
  const at = path.join(world, 'repo2')
  fs.mkdirSync(at, { recursive: true })
  git(at, 'init', '-q', '-b', 'main')
  git(at, 'commit', '-q', '--allow-empty', '-m', 'init')
  git(world, 'init', '-q', '--bare', '-b', 'main', 'origin2.git')
  git(at, 'remote', 'add', 'origin', path.join(world, 'origin2.git'))
  git(at, 'push', '-q', 'origin', 'main')
  return at
}

function account(): void {
  const rate_limits = { seven_day: { used_percentage: 40 }, five_hour: { used_percentage: 10 } }
  write(
    path.join(accountPath(), 'status-cache', 'sessions', 's1.json'),
    JSON.stringify({ session_id: 's1', written_at: NOON.getTime() / 1000 - 30, rate_limits }),
  )
  const trusted = { hasTrustDialogAccepted: true }
  const projects = { [repo()]: trusted, [path.join(world, 'repo2')]: trusted }
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
  retires: string[]
}

function fakeBroker(
  opts: {
    agents?: AgentIdentity[]
    slots?: { held: number; cap: number }
    spawn?: (frame: SpawnFrame) => SpawnReply
    queue?: QueueItem[]
    resume?: (name: string) => SpawnReply
    retire?: (name: string) => SpawnReply
    view?: () => BrokerView
  } = {},
): Fake {
  const fake: Fake = {
    frames: [],
    rosterCalls: 0,
    resumes: [],
    retires: [],
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
      retire: async name => {
        fake.retires.push(name)
        return opts.retire?.(name) ?? { ok: true }
      },
      queue: async () => opts.queue ?? [],
      resume: async (name, message) => {
        fake.resumes.push({ name, message })
        return opts.resume?.(name) ?? { ok: true, agentId: `id-${name}` }
      },
      collisionView: async () => opts.view?.() ?? { names: [], claims: [] },
    },
  }
  return fake
}

/** `gh` answers per call from `gh`; `git` runs for real against the fixture repo and its bare origin. */
const stubGh =
  (
    gh: (args: string[], cwd?: string) => { status: number; stdout: string } = () => ({
      status: 0,
      stdout: '',
    }),
  ): Runner =>
  (bin, args, cwd) =>
    bin === 'gh' ? gh(args, cwd) : run(bin, args, cwd)

const tick = (
  fake: Fake,
  dryRun = false,
  log: (e: string, d: Record<string, unknown>) => void = () => {},
  exec: Runner = stubGh(),
) => tickFromDisk({ dryRun, broker: fake.broker, now: NOON, log, exec })

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
  git(world, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
  git(repo(), 'remote', 'add', 'origin', path.join(world, 'origin.git'))
  git(repo(), 'push', '-q', 'origin', 'main')
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

/** CC-182: a retire refused after the claim is done must stay visible and be tried again. */
describe('burndown tick retires refused after a claim is done', () => {
  const doneClaim = (extra: Partial<Claim> = {}): Claim => ({
    taskId: 'DM-1',
    initiative: 'demo',
    spawnedAt: NOON.toISOString(),
    phase: 'done',
    phaseAt: NOON.toISOString(),
    spawned: ['bd-dm-1', 'bd-dm-1-s1'],
    ...extra,
  })
  const TENANCY = 'bd-dm-1 allocated the worktree, and heir (not retired) is working in it'
  const REFUSED = NOON.toISOString()

  it('records the refused name on the done claim and says it will retry', async () => {
    const retired: string[] = []
    const result = await execute(
      [{ kind: 'retire', key: { taskId: 'DM-1' }, names: ['bd-dm-1-s1', 'bd-dm-1'] }],
      { version: 1, claims: [doneClaim()] },
      {
        ledgerFile: burndownLedgerPath(),
        spawn: async () => ({ ok: true }),
        retire: async name =>
          name === 'bd-dm-1' ? { ok: false, reason: TENANCY } : (retired.push(name), { ok: true }),
        log: () => {},
        now: NOON,
      },
    )

    expect(retired).toEqual(['bd-dm-1-s1'])
    expect(result.lines).toContain(`left bd-dm-1: ${TENANCY}; recorded on DM-1#, retried next tick`)
    expect(readLedger(burndownLedgerPath()).claims[0]?.unretired).toEqual([
      { name: 'bd-dm-1', reason: TENANCY, at: REFUSED },
    ])
  })

  it('retries it on the next tick and clears it once the retire succeeds', async () => {
    initiative({})
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [doneClaim({ unretired: [{ name: 'bd-dm-1', reason: TENANCY, at: REFUSED }] })],
    })
    const fake = fakeBroker({ agents: [row('bd-dm-1', 'exited')] })

    const lines = await tick(fake)

    expect(fake.retires).toEqual(['bd-dm-1'])
    expect(lines).toContain('retired bd-dm-1')
    expect(readLedger(burndownLedgerPath()).claims[0]?.unretired).toBeUndefined()
  })

  it('keeps it recorded while the retire still refuses', async () => {
    initiative({})
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [doneClaim({ unretired: [{ name: 'bd-dm-1', reason: TENANCY, at: REFUSED }] })],
    })
    const fake = fakeBroker({
      agents: [row('bd-dm-1', 'exited')],
      retire: () => ({ ok: false, reason: TENANCY }),
    })

    await tick(fake)

    expect(fake.retires).toEqual(['bd-dm-1'])
    expect(readLedger(burndownLedgerPath()).claims[0]?.unretired).toEqual([
      { name: 'bd-dm-1', reason: TENANCY, at: REFUSED },
    ])
  })

  it('shows the unretired agent in burndown status', () => {
    const ledger = {
      version: 1 as const,
      claims: [doneClaim({ unretired: [{ name: 'bd-dm-1', reason: TENANCY, at: REFUSED }] })],
    }

    const lines = renderStatus(ledger, NOON)

    expect(lines).toContain(`DM-1 (demo) done, UNRETIRED bd-dm-1: ${TENANCY}`)
  })

  it('retries in the recorded order, so a successor still goes before its predecessor', async () => {
    initiative({})
    const unretired = ['bd-dm-1-s1', 'bd-dm-1'].map(name => ({ name, reason: TENANCY, at: REFUSED }))
    writeLedger(burndownLedgerPath(), { version: 1, claims: [doneClaim({ unretired })] })
    const fake = fakeBroker({ agents: [row('bd-dm-1-s1', 'exited'), row('bd-dm-1', 'exited')] })

    await tick(fake)

    expect(fake.retires).toEqual(['bd-dm-1-s1', 'bd-dm-1'])
  })

  it('does not retire a hand-spawned agent that took the name after the refusal', async () => {
    initiative({})
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [doneClaim({ unretired: [{ name: 'bd-dm-1', reason: TENANCY, at: REFUSED }] })],
    })
    const newer = { ...row('bd-dm-1', 'live'), agentId: 'id-hand', spawnedAt: NOON.getTime() + 60_000 }
    const fake = fakeBroker({ agents: [newer] })

    await tick(fake)

    expect(fake.retires).toEqual([])
    expect(readLedger(burndownLedgerPath()).claims[0]?.unretired).toBeUndefined()
  })

  /** A pre-CC-185 entry has no refusal time, so only the held-claim check stands between it and a reused name. */
  it('does not retire a name a held claim reused, even without a refusal time', async () => {
    initiative({})
    const rerun: Claim = {
      ...doneClaim({ phase: 'implementing', agentName: 'bd-dm-1', spawned: ['bd-dm-1'] }),
      agentId: 'id-bd-dm-1',
    }
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [doneClaim({ unretired: [{ name: 'bd-dm-1', reason: TENANCY }] }), rerun],
    })
    const fake = fakeBroker({ agents: [row('bd-dm-1', 'live')] })

    await tick(fake)

    expect(fake.retires).toEqual([])
    expect(readLedger(burndownLedgerPath()).claims[0]?.unretired).toBeUndefined()
  })

  it('skips a name whose refusal time cannot be read rather than risk retiring a reused name', async () => {
    initiative({})
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [doneClaim({ unretired: [{ name: 'bd-dm-1', reason: TENANCY, at: 'not-a-date' }] })],
    })
    const fake = fakeBroker({ agents: [row('bd-dm-1', 'exited')] })

    await tick(fake)

    expect(fake.retires).toEqual([])
  })

  it('drops a name retired by hand without retiring anything', async () => {
    initiative({})
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [doneClaim({ unretired: [{ name: 'bd-dm-1', reason: TENANCY, at: REFUSED }] })],
    })
    const fake = fakeBroker({ agents: [row('bd-dm-1', 'retired')] })

    await tick(fake)

    expect(fake.retires).toEqual([])
    expect(readLedger(burndownLedgerPath()).claims[0]?.unretired).toBeUndefined()
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

  it('reports a mismatched id on a dry run even with an empty queue', async () => {
    deciderSetup('id-configured')
    const fake = fakeBroker({ agents: [deciderRow('exited', 'id-imposter')] })

    const lines = await tick(fake, true)

    expect(lines.join('\n')).toContain('config.json names id-configured')
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

/** CC-231: the tick runs the CC-202 collision check before it dispatches. */
describe('burndown tick collision check', () => {
  const pulls =
    (prs: { number: number; title: string; branch: string; body: string }[], failIn?: string) =>
    (args: string[], cwd?: string) =>
      cwd === failIn
        ? { status: 1, stdout: '' }
        : { status: 0, stdout: prs.map(p => JSON.stringify(p)).join('\n') }

  it('refuses a task a commit subject on the default branch names', async () => {
    initiative({ 'DM-1': task('DM-1') })
    git(repo(), 'commit', '-q', '--allow-empty', '-m', 'Do the thing (DM-1) (#7)')
    git(repo(), 'push', '-q', 'origin', 'main')
    const fake = fakeBroker()

    const lines = await tick(fake)

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('refused demo DM-1 [landed]: "Do the thing (DM-1) (#7)"')
  })

  it("refuses when another task's held agent opened the PR that names this id", async () => {
    initiative({ 'DM-1': task('DM-1', 1), 'DM-2': task('DM-2', 2) }, { lanes: 2 })
    const held: Claim = {
      taskId: 'DM-2',
      initiative: 'demo',
      spawnedAt: NOON.toISOString(),
      phase: 'implementing',
      phaseAt: NOON.toISOString(),
      agentName: 'bd-dm-2',
      spawned: ['bd-dm-2'],
    }
    writeLedger(burndownLedgerPath(), { version: 1, claims: [held] })
    const pr = { number: 9, title: 'Do DM-2', branch: 'agent-chat/bd-dm-2', body: 'Also fixes DM-1.' }
    const fake = fakeBroker({ agents: [row('bd-dm-2', 'live')] })

    const lines = await tick(fake, false, () => {}, stubGh(pulls([pr])))

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('refused demo DM-1 [open-pr]: #9 (agent-chat/bd-dm-2) names DM-1')
  })

  it("does not refuse on the PR of this task's own held claim", async () => {
    initiative({ 'DM-1': task('DM-1', 1), 'DM-2': task('DM-2', 2) }, { lanes: 2 })
    const pr = { number: 9, title: 'Do DM-2', branch: 'agent-chat/bd-dm-2', body: '' }
    const fake = fakeBroker()

    await tick(fake, false, () => {}, stubGh(pulls([pr])))

    expect(fake.frames.map(f => f.name)).toEqual(['bd-dm-1'])
  })

  it('logs a failed gh-pulls reader by name and refuses only that repo', async () => {
    const other = secondRepo()
    initiative({ 'DM-1': task('DM-1') })
    initiative({ 'OT-1': task('OT-1') }, { slug: 'other', at: other, rank: 2 })
    const logged: { event: string; detail: Record<string, unknown> }[] = []
    const fake = fakeBroker()

    const lines = await tick(
      fake,
      false,
      (event, detail) => logged.push({ event, detail }),
      stubGh(pulls([], repo())),
    )

    expect(logged.filter(l => l.event === 'burndown_collision_reader_failed')).toEqual([
      { event: 'burndown_collision_reader_failed', detail: { reader: 'gh-pulls', repo: repo() } },
    ])
    expect(lines.join('\n')).toContain('refused demo DM-1 [open-pr]: reader gh-pulls failed')
    expect(fake.frames.map(f => f.name)).toEqual(['bd-ot-1'])
  })

  it('logs a failed git-subjects reader by name and refuses only that repo', async () => {
    const other = secondRepo()
    initiative({ 'DM-1': task('DM-1') })
    initiative({ 'OT-1': task('OT-1') }, { slug: 'other', at: other, rank: 2 })
    git(other, 'remote', 'remove', 'origin')
    const logged: { event: string; detail: Record<string, unknown> }[] = []
    const fake = fakeBroker()

    const lines = await tick(fake, false, (event, detail) => logged.push({ event, detail }))

    expect(logged.filter(l => l.event === 'burndown_collision_reader_failed')).toEqual([
      { event: 'burndown_collision_reader_failed', detail: { reader: 'git-subjects', repo: other } },
    ])
    expect(lines.join('\n')).toContain('refused other OT-1 [landed]: reader git-subjects failed')
    expect(fake.frames.map(f => f.name)).toEqual(['bd-dm-1'])
  })

  it('logs a failed broker-view reader by name and refuses as claimed', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const logged: { event: string; detail: Record<string, unknown> }[] = []
    const fake = fakeBroker({
      view: () => {
        throw new Error('broker gone')
      },
    })

    const lines = await tick(fake, false, (event, detail) => logged.push({ event, detail }))

    expect(logged.filter(l => l.event === 'burndown_collision_reader_failed')).toEqual([
      { event: 'burndown_collision_reader_failed', detail: { reader: 'broker-view', repo: repo() } },
    ])
    expect(lines.join('\n')).toContain('refused demo DM-1 [claimed]: reader broker-view failed')
    expect(fake.frames).toEqual([])
  })

  it('refuses a task a live agent outside the ledger carries', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const fake = fakeBroker({ view: () => ({ names: ['hs-dm-1-by-hand'], claims: [] }) })

    const lines = await tick(fake)

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('refused demo DM-1 [claimed]: live agent hs-dm-1-by-hand carries DM-1')
  })
})
