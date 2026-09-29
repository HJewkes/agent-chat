import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrokerView } from '../agents/burndown/collision.js'
import { run, type Runner } from '../agents/burndown/exec.js'
import { execute, spawnFrame, type SpawnFrame, type SpawnReply } from '../agents/burndown/execute.js'
import { readLedger, writeLedger, type Claim } from '../agents/burndown/ledger.js'
import { tickFromDisk, type TickBroker } from '../agents/burndown/run-tick.js'
import { renderPlan, renderStatus, seatPlanFromDisk } from '../agents/burndown/tick.js'
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
  sends: { to: string; text: string }[]
  senders: { opened: number; closed: number }
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
    sendAs?: (to: string) => SpawnReply
  } = {},
): Fake {
  const fake: Fake = {
    frames: [],
    rosterCalls: 0,
    resumes: [],
    retires: [],
    sends: [],
    senders: { opened: 0, closed: 0 },
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
      seatSender: async () => {
        fake.senders.opened += 1
        return {
          send: async (to, text) => {
            fake.sends.push({ to, text })
            return opts.sendAs?.(to) ?? { ok: true }
          },
          close: () => {
            fake.senders.closed += 1
          },
        }
      },
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

  it('pins the dry-run output of a tick with no seats configured', async () => {
    initiative({ 'DM-1': task('DM-1', 1), 'DM-2': task('DM-2', 2), 'DM-3': 'id: DM-3\nstatus: open\n' })
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [
        {
          taskId: 'DM-2',
          initiative: 'demo',
          spawnedAt: NOON.toISOString(),
          phase: 'parked',
          phaseAt: NOON.toISOString(),
        },
      ],
    })

    const lines = await tick(fakeBroker(), true)

    expect(lines).toEqual([
      `burndown tick at ${NOON.toISOString()} (dry run)`,
      `would record add DM-1`,
      `would spawn bd-dm-1 as bd-implementer-lite (headless) on ${accountPath()} in ${repo()}; brief ${lines[2]?.split('brief ')[1]}`,
      'refused demo DM-2 [claimed]: held in the burndown claim ledger',
      'refused demo DM-3 [no-done-when]: no done_when, so no return contract',
    ])
    expect(lines[2]).toMatch(/; brief \d+ chars$/)
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

const DEFAULTS = `defaults:
  kind_weights: {platform: 0.8}
  share_caps: {}
  initiative_decay: 0.85
  score_terms: {severity: 0.40, priority_pct: 0.30, unblocks: 0.20, staleness: 0.10}
  severity: {unset: 0.3}
  readiness: {ready: 1.0, untriaged: 0.6, blocked: 0.25}
  size: {le3: 1.0, le8: 0.9, gt8: 0.75}
  stop_short_factor: 0.8
  worktrees_per_repo_per_seat: 3
  worktrees_left_free_per_repo: 0`

/** A synthetic charter with seat `seat-t` (prefix `st`) on pool `pool-t`, whose config dir is the fixture account. */
function seatPolicy({ implementers = 2, extraSeats = '', extraRepo = '', grants = '' } = {}): void {
  const root = path.join(world, 'aw', 'claude-channels', 'sources', 'autonomy')
  const pool = `pool-t: {config_dir: ${accountPath()}, human_uses: false, reserve_seven_day: 30, ceiling_five_hour: 75}`
  write(
    path.join(root, 'charter.md'),
    `---\nseats: [seat-t, seat-e${extraSeats}]\n${DEFAULTS}\npools:\n  ${pool}\n---\n`,
  )
  const concurrency = `concurrency: {implementers: ${implementers}, reviewers: 1, planners: 1}`
  const more = extraRepo === '' ? '' : `\n  - {path: ${extraRepo}, initiatives: [demo]}`
  const granted = grants === '' ? '' : `\ngrants_extra: [${grants}]`
  write(
    path.join(root, 'seats', 'seat-t.md'),
    `---\nprefix: st\npool: pool-t\ninitiatives: {demo: 1.0}\nrepos:\n  - {path: ${repo()}, initiatives: [demo]}${more}\n${concurrency}${granted}\n---\n`,
  )
  write(path.join(root, 'seats', 'seat-e.md'), '---\nprefix: se\npool: pool-t\n---\n')
}

/** A focused initiative with no autonomy block, which only seats mode dispatches from. */
function seatInitiative(tasks: Record<string, string>): void {
  write(path.join(world, 'aw', 'demo', 'brief.md'), '---\ntitle: demo\nstate: focused\n---\n# demo\n')
  for (const [id, text] of Object.entries(tasks))
    write(path.join(world, 'aw', 'demo', 'tasks', `${id}.yml`), text)
}

function sevenDayAt(used: number): void {
  const rate_limits = { seven_day: { used_percentage: used }, five_hour: { used_percentage: 10 } }
  write(
    path.join(accountPath(), 'status-cache', 'sessions', 's1.json'),
    JSON.stringify({ session_id: 's1', written_at: NOON.getTime() / 1000 - 30, rate_limits }),
  )
}

const seatTask = (id: string): string => task(id).replace('estimate: 1', 'estimate: 2')

describe('burndown tick in seats mode', () => {
  beforeEach(() => {
    seatPolicy()
    config({ seats: ['seat-t'] })
  })

  it("dispatches up to the seat's role cap on the pool's config dir, with seat claims", async () => {
    seatInitiative({ 'DM-1': seatTask('DM-1'), 'DM-2': seatTask('DM-2'), 'DM-3': seatTask('DM-3') })
    const fake = fakeBroker()

    const lines = await tick(fake)

    expect(fake.frames.map(f => [f.name, f.profile, f.configDir])).toEqual([
      ['st-dm-1', 'bd-implementer', accountPath()],
      ['st-dm-2', 'bd-implementer', accountPath()],
    ])
    expect(lines.join('\n')).toContain('refused demo DM-3 [role-cap]: seat seat-t holds 2 of 2 implementers')
    const ledger = readLedger(burndownLedgerPath())
    expect(ledger.claims.map(c => [c.taskId, c.seat, c.namePrefix])).toEqual([
      ['DM-1', 'seat-t', 'st'],
      ['DM-2', 'seat-t', 'st'],
    ])
    expect(ledger.seats).toEqual({ 'seat-t': { samples: [{ at: NOON.getTime(), sevenDay: 40 }] } })
  })

  it('stops at the pool gate with the BUDGET-PAUSE reason', async () => {
    seatInitiative({ 'DM-1': seatTask('DM-1') })
    sevenDayAt(75)
    const fake = fakeBroker()

    const lines = await tick(fake)

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('refused demo DM-1 [budget]: BUDGET-PAUSE pool pool-t: seven_day 75%')
  })

  it('keeps one pool sample per tick and prunes samples older than 26 hours', async () => {
    seatInitiative({})
    const hour = 3_600_000
    const old = { at: NOON.getTime() - 27 * hour, sevenDay: 20 }
    const recent = { at: NOON.getTime() - hour, sevenDay: 38 }
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [],
      seats: { 'seat-t': { samples: [old, recent] } },
    })

    await tick(fakeBroker())

    expect(readLedger(burndownLedgerPath()).seats?.['seat-t']?.samples).toEqual([
      recent,
      { at: NOON.getTime(), sevenDay: 40 },
    ])
  })

  it("counts the seat's prefixed worktrees against maxWorktreesPerRepo", async () => {
    config({ seats: ['seat-t'], maxWorktreesPerRepo: 1 })
    seatInitiative({ 'DM-1': seatTask('DM-1') })
    git(repo(), 'worktree', 'add', '-q', '-b', 'st-x-9', path.join('.worktrees', 'st-x-9'))
    const fake = fakeBroker()

    const lines = await tick(fake)

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('1 burndown worktrees under')
  })

  it('refuses with a config error when a brief also opts in with autonomy:', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const fake = fakeBroker()

    const lines = await tick(fake)

    expect(lines).toEqual([
      expect.stringMatching(/^config error: .* lists seats, and brief.md of demo has an autonomy: block/),
    ])
    expect(fake.rosterCalls).toBe(0)
  })

  it('skips a seat that cannot load or plan, logs it, and still advances claims and plans the others', async () => {
    config({ seats: ['nope', 'seat-e', 'seat-t'] })
    seatInitiative({ 'DM-1': seatTask('DM-1') })
    const inFlight: Claim = {
      taskId: 'DM-9',
      initiative: 'demo',
      seat: 'seat-t',
      namePrefix: 'st',
      spawnedAt: NOON.toISOString(),
      phase: 'spawning',
      phaseAt: NOON.toISOString(),
      nextPhase: 'implementing',
      agentName: 'st-dm-9',
      spawned: ['st-dm-9'],
    }
    writeLedger(burndownLedgerPath(), { version: 1, claims: [inFlight] })
    const logged: { event: string; detail: Record<string, unknown> }[] = []
    const fake = fakeBroker({ agents: [row('st-dm-9', 'live')] })

    const lines = await tick(fake, false, (event, detail) => logged.push({ event, detail }))

    expect(lines).toContain(
      `seat nope skipped: nope is not a seat in ${path.join(world, 'aw', 'claude-channels', 'sources', 'autonomy')}/charter.md`,
    )
    expect(lines).toContain('seat seat-e skipped: seat-e has no dispatch scope (hub seat)')
    expect(logged.filter(l => l.event === 'burndown_seat_skipped').map(l => l.detail.seat)).toEqual([
      'nope',
      'seat-e',
    ])
    expect(readLedger(burndownLedgerPath()).claims.find(c => c.taskId === 'DM-9')?.phase).toBe('implementing')
    expect(fake.frames.map(f => f.name)).toEqual(['st-dm-1'])
  })

  it('burndown plan --seat prints the seat dispatch plan and its refusals', () => {
    seatInitiative({ 'DM-1': seatTask('DM-1'), 'DM-2': seatTask('DM-2'), 'DM-3': seatTask('DM-3') })
    const root = path.join(world, 'aw')
    const autonomyRoot = path.join(root, 'claude-channels', 'sources', 'autonomy')

    const lines = renderPlan(seatPlanFromDisk({ seat: 'seat-t', now: NOON, root, autonomyRoot }), NOON)

    expect(lines.map(l => l.replace(/: score .*$/, ''))).toEqual([
      `burndown plan at ${NOON.toISOString()} (dry run: nothing spawned, nothing claimed)`,
      `would dispatch demo DM-1 as bd-implementer on pool-t in ${repo()}/.worktrees/st-dm-1`,
      `would dispatch demo DM-2 as bd-implementer on pool-t in ${repo()}/.worktrees/st-dm-2`,
      'refused demo DM-3 [role-cap]: seat seat-t holds 2 of 2 implementers',
    ])
    expect(() => seatPlanFromDisk({ seat: 'seat-e', now: NOON, root, autonomyRoot })).toThrow(
      'seat-e has no dispatch scope',
    )
  })

  it('dry run prints the seat dispatch and writes nothing', async () => {
    seatInitiative({ 'DM-1': seatTask('DM-1') })

    const lines = await tick(fakeBroker(), true)

    expect(lines.join('\n')).toContain(
      `would spawn st-dm-1 as bd-implementer (headless) on ${accountPath()} in ${repo()}`,
    )
    expect(fs.existsSync(burndownLedgerPath())).toBe(false)
  })

  it('tells the seat of its dispatches in one message and marks them notified', async () => {
    seatInitiative({ 'DM-1': seatTask('DM-1'), 'DM-2': seatTask('DM-2') })
    const fake = fakeBroker()

    const lines = await tick(fake)

    expect(fake.sends).toEqual([
      {
        to: 'seat-t',
        text: `Burndown events for seat-t at ${NOON.toISOString()}\ndispatched DM-1\ndispatched DM-2`,
      },
    ])
    expect(lines).toContain('told seat-t of 2 event(s)')
    expect(fake.senders).toEqual({ opened: 1, closed: 1 })
    expect(readLedger(burndownLedgerPath()).claims.map(c => c.notified)).toEqual([
      ['dispatched'],
      ['dispatched'],
    ])
  })

  it('leaves events unmarked on a failed send and delivers them on the next tick', async () => {
    seatInitiative({ 'DM-1': seatTask('DM-1') })
    let up = false
    const fake = fakeBroker({
      agents: [row('st-dm-1', 'live')],
      sendAs: () => (up ? { ok: true } : { ok: false, reason: 'broker gone' }),
    })

    const first = await tick(fake)
    expect(first).toContain('could not tell seat-t of 1 event(s): broker gone; retried next tick')
    expect(readLedger(burndownLedgerPath()).claims[0]?.notified).toBeUndefined()

    up = true
    await tick(fake)
    await tick(fake)

    expect(fake.sends.map(s => s.text.split('\n').slice(1))).toEqual([
      ['dispatched DM-1'],
      ['dispatched DM-1'],
    ])
    expect(readLedger(burndownLedgerPath()).claims[0]?.notified).toEqual(['dispatched'])
  })

  it('dry run prints the seat message instead of sending it', async () => {
    const claim: Claim = {
      taskId: 'DM-9',
      initiative: 'demo',
      seat: 'seat-t',
      spawnedAt: NOON.toISOString(),
      phase: 'parked',
      phaseAt: NOON.toISOString(),
      agentId: 'id-st-dm-9',
      notified: ['dispatched'],
    }
    seatInitiative({})
    writeLedger(burndownLedgerPath(), { version: 1, claims: [claim] })
    const fake = fakeBroker()

    const lines = await tick(fake, true)

    expect(fake.sends).toEqual([])
    expect(lines).toEqual(
      expect.arrayContaining([
        'would send to seat-t:',
        `  Burndown events for seat-t at ${NOON.toISOString()}`,
        '  parked DM-9',
      ]),
    )
  })

  it('sends nothing for a claim whose seat is not enabled', async () => {
    const claim: Claim = {
      taskId: 'DM-9',
      initiative: 'demo',
      seat: 'seat-off',
      spawnedAt: NOON.toISOString(),
      phase: 'parked',
      phaseAt: NOON.toISOString(),
      agentId: 'id-st-dm-9',
    }
    seatInitiative({})
    writeLedger(burndownLedgerPath(), { version: 1, claims: [claim] })
    const fake = fakeBroker()

    await tick(fake)
    const dry = await tick(fake, true)

    expect(fake.sends).toEqual([])
    expect(fake.senders.opened).toBe(0)
    expect(dry.join('\n')).not.toContain('would send')
    expect(readLedger(burndownLedgerPath()).claims[0]?.notified).toBeUndefined()
  })
})

describe('burndown tick advances a seat claim', () => {
  const seatClaim = (seat: string): { claim: Claim; worktree: string } => {
    const worktree = path.join(repo(), '.worktrees', 'st-dm-1')
    git(repo(), 'worktree', 'add', '-q', '-b', 'agent-chat/st-dm-1', worktree)
    git(worktree, 'commit', '-q', '--allow-empty', '-m', 'work')
    const claim: Claim = {
      taskId: 'DM-1',
      initiative: 'demo',
      seat,
      namePrefix: 'st',
      spawnedAt: NOON.toISOString(),
      phase: 'implementing',
      phaseAt: NOON.toISOString(),
      agentName: 'st-dm-1',
      spawned: ['st-dm-1'],
      worktree,
    }
    writeLedger(burndownLedgerPath(), { version: 1, claims: [claim] })
    return { claim, worktree }
  }

  beforeEach(() => {
    seatPolicy()
    config({ seats: ['seat-t'] })
    seatInitiative({ 'DM-1': seatTask('DM-1') })
  })

  it("spawns the reviewer on the seat's pool config dir without an autonomy block", async () => {
    const { worktree } = seatClaim('seat-t')
    const fake = fakeBroker({ agents: [row('st-dm-1', 'exited', worktree)] })

    await tick(fake)

    expect(fake.frames).toEqual([
      expect.objectContaining({
        name: 'st-dm-1-r0',
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

  it('does not spawn the reviewer while the seat pool gate is closed', async () => {
    const { worktree } = seatClaim('seat-t')
    sevenDayAt(75)
    const fake = fakeBroker({ agents: [row('st-dm-1', 'exited', worktree)] })

    const lines = await tick(fake)

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('deferred DM-1#: budget: BUDGET-PAUSE pool pool-t')
    expect(readLedger(burndownLedgerPath()).claims[0]?.stalledReason).toBeUndefined()
  })

  it('defers the reviewer without stalling the claim when its seat is skipped this tick', async () => {
    const { worktree } = seatClaim('nope')
    config({ seats: ['seat-t', 'nope'] })
    const fake = fakeBroker({ agents: [row('st-dm-1', 'exited', worktree)] })

    const lines = await tick(fake)

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('deferred DM-1#: seat nope skipped this tick')
    expect(readLedger(burndownLedgerPath()).claims[0]?.stalledReason).toBeUndefined()
  })

  it('defers the reviewer while the seat pool is within its sonnet-only band', async () => {
    const { worktree } = seatClaim('seat-t')
    sevenDayAt(65)
    const fake = fakeBroker({ agents: [row('st-dm-1', 'exited', worktree)] })

    const lines = await tick(fake)

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain(
      'deferred DM-1#: budget: pool-t is within 10 points of a stop, sonnet only',
    )
  })

  describe('with a second repo in the seat dispatch', () => {
    const reviewedClaim = (): { claim: Claim; worktree: string } => {
      const second = secondRepo()
      seatPolicy({ extraRepo: second, grants: 'merge' })
      const worktree = path.join(second, '.worktrees', 'st-dm-1')
      git(second, 'worktree', 'add', '-q', '-b', 'agent-chat/st-dm-1', worktree)
      const claim: Claim = {
        taskId: 'DM-1',
        initiative: 'demo',
        seat: 'seat-t',
        namePrefix: 'st',
        spawnedAt: NOON.toISOString(),
        phase: 'reviewing',
        phaseAt: NOON.toISOString(),
        agentName: 'st-dm-1-r0',
        spawned: ['st-dm-1', 'st-dm-1-r0'],
        worktree,
      }
      writeLedger(burndownLedgerPath(), { version: 1, claims: [claim] })
      return { claim, worktree }
    }

    it('spawns the successor from the repo holding the claim worktree, on the seat placement', async () => {
      const { worktree } = reviewedClaim()
      const fake = fakeBroker({ agents: [row('st-dm-1-r0', 'exited', worktree)] })

      await tick(fake)

      expect(fake.frames).toEqual([
        expect.objectContaining({
          name: 'st-dm-1-s1',
          profile: 'bd-implementer',
          cwd: path.join(world, 'repo2'),
          configDir: accountPath(),
          worktree,
          brief: expect.stringContaining('Grants in force: merge.'),
        }),
      ])
    })

    it('defers the successor while the seat pool gate is closed', async () => {
      const { worktree } = reviewedClaim()
      sevenDayAt(75)
      const fake = fakeBroker({ agents: [row('st-dm-1-r0', 'exited', worktree)] })

      const lines = await tick(fake)

      expect(fake.frames).toEqual([])
      expect(lines.join('\n')).toContain('deferred DM-1#: budget: BUDGET-PAUSE pool pool-t')
    })

    it('defers the successor while the seat pool is within its sonnet-only band', async () => {
      const { worktree } = reviewedClaim()
      sevenDayAt(65)
      const fake = fakeBroker({ agents: [row('st-dm-1-r0', 'exited', worktree)] })

      const lines = await tick(fake)

      expect(fake.frames).toEqual([])
      expect(lines.join('\n')).toContain('sonnet only')
    })
  })

  it('stalls the claim once, without spawning, when its seat is no longer in the config', async () => {
    const { worktree } = seatClaim('seat-gone')
    const fake = fakeBroker({ agents: [row('st-dm-1', 'exited', worktree)] })

    await tick(fake)
    await tick(fake)

    expect(fake.frames).toEqual([])
    expect(readLedger(burndownLedgerPath()).claims[0]?.stalledReason).toBe(
      'seat seat-gone is no longer in the burndown config; left for the owner',
    )
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

  it('refuses a task whose claim finished this tick while its agent is still live', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const merging: Claim = {
      taskId: 'DM-1',
      initiative: 'demo',
      spawnedAt: NOON.toISOString(),
      phase: 'awaiting-merge',
      phaseAt: NOON.toISOString(),
      agentName: 'bd-dm-1',
      spawned: ['bd-dm-1'],
      pr: 'https://example.test/demo/repo/pull/5',
    }
    writeLedger(burndownLedgerPath(), { version: 1, claims: [merging] })
    const merged = (args: string[]) =>
      args[0] === 'pr'
        ? { status: 0, stdout: JSON.stringify({ state: 'MERGED' }) }
        : { status: 0, stdout: '' }
    const fake = fakeBroker({
      agents: [row('bd-dm-1', 'live')],
      view: () => ({ names: ['bd-dm-1'], claims: [] }),
    })

    const lines = await tick(fake, false, () => {}, stubGh(merged))

    expect(readLedger(burndownLedgerPath()).claims[0]?.phase).toBe('done')
    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('refused demo DM-1 [claimed]: live agent bd-dm-1 carries DM-1')
  })

  it('logs a failed broker-view reader once per tick, not once per repo', async () => {
    const other = secondRepo()
    initiative({ 'DM-1': task('DM-1') })
    initiative({ 'OT-1': task('OT-1') }, { slug: 'other', at: other, rank: 2 })
    const logged: { event: string; detail: Record<string, unknown> }[] = []
    const fake = fakeBroker({
      view: () => {
        throw new Error('broker gone')
      },
    })

    await tick(fake, false, (event, detail) => logged.push({ event, detail }))

    expect(logged.filter(l => l.detail.reader === 'broker-view')).toHaveLength(1)
  })

  it('logs each opted-in initiative with no repo as skipping the collision check', async () => {
    write(
      path.join(world, 'aw', 'norepo', 'brief.md'),
      '---\ntitle: norepo\nstate: focused\nrank: 1\nprofile: agents\nautonomy:\n  mode: burndown\n  lanes: 1\n  accounts: [agents]\n  grants: []\n---\n# norepo\n',
    )
    const logged: { event: string; detail: Record<string, unknown> }[] = []

    await tick(fakeBroker(), false, (event, detail) => logged.push({ event, detail }))

    expect(logged.filter(l => l.event === 'burndown_collision_skipped')).toEqual([
      { event: 'burndown_collision_skipped', detail: { initiative: 'norepo', reason: 'no repo' } },
    ])
  })
})
