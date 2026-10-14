import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dailyRetire, dailyRetireDue, type RetireFinishedReply } from '../agents/burndown/daily-retire.js'
import { run, type Runner } from '../agents/burndown/exec.js'
import { tickFromDisk, type TickBroker } from '../agents/burndown/run-tick.js'
import { seatLogPath } from '../agents/seats/io.js'
import { TRUST_RULE_BASELINE_CLI_VERSION } from '../agents/trust.js'

/**
 * TP-1974 c: the tick retires each enrolled seat's finished agents once a day after 07:00 local.
 * The tick cases run a seats-mode fixture world with a fake broker; `git` runs for real.
 */

const at = (hour: number, minute: number, day = 3): Date => new Date(2026, 1, day, hour, minute)

const REPLY: RetireFinishedReply = {
  ok: true,
  plan: [
    { name: 'st-a', action: 'retire' },
    { name: 'st-b', action: 'retire' },
    { name: 'st-c', action: 'skip', reason: 'unpushed work' },
  ],
  results: [
    { name: 'st-a', ok: true },
    { name: 'st-b', ok: true },
  ],
}

describe('dailyRetireDue', () => {
  it('returns nothing before 07:00 even when the last run was days ago', () => {
    expect(dailyRetireDue(['seat-t'], { 'seat-t': at(7, 10, 1).toISOString() }, at(6, 50))).toEqual([])
  })

  it('returns a seat never run, or last run before today 07:00', () => {
    const last = { 'seat-u': at(23, 0, 2).toISOString() }

    expect(dailyRetireDue(['seat-t', 'seat-u'], last, at(7, 0))).toEqual(['seat-t', 'seat-u'])
  })

  it('returns nothing for a seat already run since today 07:00', () => {
    expect(dailyRetireDue(['seat-t'], { 'seat-t': at(7, 10).toISOString() }, at(7, 40))).toEqual([])
  })
})

describe('dailyRetire', () => {
  const deps = (retireFinished: (spawner: string) => Promise<RetireFinishedReply>) => {
    const events: Array<[string, Record<string, unknown>]> = []
    const seatLines: string[] = []
    return {
      events,
      seatLines,
      deps: {
        retireFinished,
        seatLog: (seat: string, text: string) => void seatLines.push(`${seat}: ${text}`),
        log: (event: string, detail: Record<string, unknown>) => void events.push([event, detail]),
        now: at(7, 10),
      },
    }
  }

  it('logs the retired count to the seat log and the event log, and stamps the seat', async () => {
    const fake = deps(async () => REPLY)

    const done = await dailyRetire(['seat-t'], undefined, fake.deps)

    expect(fake.seatLines).toEqual(['seat-t: burndown: retired 2 finished (seat-t)'])
    expect(fake.events).toEqual([
      ['burndown_daily_retire', { seat: 'seat-t', retired: 2, skipped: 1, failed: 0 }],
    ])
    expect(done.stamps).toEqual({ 'seat-t': at(7, 10).toISOString() })
  })

  it('stamps a seat with nothing to retire but writes no seat-log line for it', async () => {
    const fake = deps(async () => ({ ok: true, plan: [], results: [] }))

    const done = await dailyRetire(['seat-t'], undefined, fake.deps)

    expect(fake.seatLines).toEqual([])
    expect(fake.events).toEqual([
      ['burndown_daily_retire', { seat: 'seat-t', retired: 0, skipped: 0, failed: 0 }],
    ])
    expect(done.stamps).toEqual({ 'seat-t': at(7, 10).toISOString() })
  })

  it('leaves a seat due when the broker refuses or throws', async () => {
    const fake = deps(async seat => {
      if (seat === 'seat-t') throw new Error('broker did not answer')
      return { ok: false, reason: 'refused', plan: [], results: [] }
    })

    const done = await dailyRetire(['seat-t', 'seat-u'], undefined, fake.deps)

    expect(done.stamps).toEqual({})
    expect(fake.seatLines).toEqual([])
    expect(fake.events.map(([event, d]) => [event, d.seat])).toEqual([
      ['burndown_daily_retire_failed', 'seat-t'],
      ['burndown_daily_retire_failed', 'seat-u'],
    ])
  })
})

let world: string
const saved = { ...process.env }

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })

const repo = (): string => path.join(world, 'repo')
const accountPath = (): string => path.join(world, 'profiles', 'agents')
const autonomyRoot = (): string => path.join(world, 'aw', 'claude-channels', 'sources', 'autonomy')
const configPath = (): string => path.join(world, 'home', 'burndown.config.json')

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

function seatWorld(): void {
  const pool = `pool-t: {config_dir: ${accountPath()}, human_uses: false, reserve_seven_day: 30, ceiling_five_hour: 75}`
  write(
    path.join(autonomyRoot(), 'charter.md'),
    `---\nseats: [seat-t, seat-u]\n${DEFAULTS}\npools:\n  ${pool}\n---\n`,
  )
  for (const [seat, prefix] of [
    ['seat-t', 'st'],
    ['seat-u', 'su'],
  ])
    write(
      path.join(autonomyRoot(), 'seats', `${seat}.md`),
      `---\nprefix: ${prefix}\npool: pool-t\ninitiatives: {demo: 1.0}\nrepos:\n  - {path: ${repo()}, initiatives: [demo]}\nconcurrency: {implementers: 2, reviewers: 1, planners: 1}\n---\n`,
    )
  write(path.join(world, 'aw', 'demo', 'brief.md'), '---\ntitle: demo\nstate: focused\n---\n# demo\n')
  tickConfig({ enabled: true })
  write(path.join(world, 'home', 'config.json'), JSON.stringify({ worktreeBudget: 10 }))
}

const tickConfig = (over: { enabled: boolean }): void =>
  write(
    configPath(),
    JSON.stringify({
      reportTo: 'coord',
      maxAgents: 3,
      reserveSlots: 2,
      seats: ['seat-t', 'seat-u'],
      ...over,
    }),
  )

function account(now: Date): void {
  const rate_limits = { seven_day: { used_percentage: 40 }, five_hour: { used_percentage: 10 } }
  write(
    path.join(accountPath(), 'status-cache', 'sessions', 's1.json'),
    JSON.stringify({ session_id: 's1', written_at: now.getTime() / 1000 - 30, rate_limits }),
  )
  write(
    path.join(accountPath(), '.claude.json'),
    JSON.stringify({ projects: { [repo()]: { hasTrustDialogAccepted: true } } }),
  )
}

function installClaude(): void {
  const target = path.join(world, 'claude', 'versions', TRUST_RULE_BASELINE_CLI_VERSION)
  write(target, '')
  fs.chmodSync(target, 0o755)
  const link = path.join(world, 'bin', 'claude')
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(target, link)
  process.env.AGENT_CHAT_CLAUDE = link
}

function gitRepo(): void {
  fs.mkdirSync(repo(), { recursive: true })
  git(repo(), 'init', '-q', '-b', 'main')
  git(repo(), 'commit', '-q', '--allow-empty', '-m', 'init')
  git(world, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
  git(repo(), 'remote', 'add', 'origin', path.join(world, 'origin.git'))
  git(repo(), 'push', '-q', 'origin', 'main')
}

const factory: Runner = (bin, args, cwd) => {
  if (bin === 'titan-factory' && args[0] === 'service') {
    const stdout = JSON.stringify({ ok: true, cause: null, message: 'synthetic', health: null, detail: {} })
    return { status: 0, stdout }
  }
  if (bin === 'titan-factory') return { status: 0, stdout: '[]' }
  if (bin === 'gh') return { status: 0, stdout: '' }
  if (bin === 'git' && args.includes('get-url'))
    return { status: 0, stdout: 'https://github.com/acme/widgets.git\n' }
  return run(bin, args, cwd)
}

function fakeBroker(spawners: string[]): TickBroker {
  return {
    roster: async () => ({ agents: [], slots: { held: 4, cap: 36 } }),
    inboxSince: async () => [],
    spawn: async frame => ({ ok: true, agentId: `id-${frame.name}` }),
    retire: async () => ({ ok: true }),
    retireFinished: async spawner => (spawners.push(spawner), REPLY),
    queue: async () => [],
    resume: async name => ({ ok: true, agentId: `id-${name}` }),
    collisionView: async () => ({ names: [], claims: [] }),
    seatSender: async () => ({
      send: async () => ({ ok: true }),
      notify: async () => ({ ok: true }),
      close: () => undefined,
    }),
  }
}

async function tick(now: Date, dryRun = false): Promise<{ spawners: string[]; lines: string[] }> {
  account(now)
  const spawners: string[] = []
  const lines = await tickFromDisk({
    dryRun,
    broker: fakeBroker(spawners),
    now,
    log: () => {},
    exec: factory,
    ownerQueueDir: path.join(world, 'spool'),
  })
  return { spawners, lines }
}

describe('the daily retire in the live tick', () => {
  beforeEach(() => {
    world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-daily-retire-')))
    process.env.AGENT_CHAT_HOME = path.join(world, 'home')
    process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(world, 'aw')
    process.env.CLAUDE_PROFILE_ROOT = path.join(world, 'profiles')
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.AGENT_CHAT_STATUS_CACHE
    gitRepo()
    seatWorld()
    installClaude()
  })

  afterEach(() => {
    process.env = { ...saved }
    fs.rmSync(world, { recursive: true, force: true })
  })

  it('retires once per enrolled seat at 07:10, with the seat as spawner, and logs it to the seat log', async () => {
    const { spawners } = await tick(at(7, 10))

    expect(spawners).toEqual(['seat-t', 'seat-u'])
    const seatLog = fs.readFileSync(seatLogPath(autonomyRoot(), 'seat-t', at(7, 10)), 'utf8')
    expect(seatLog).toContain('burndown: retired 2 finished (seat-t)')
  })

  it('retires nothing at 07:40 the same day, reading the stamp back from the ledger on disk', async () => {
    await tick(at(7, 10))

    const { spawners } = await tick(at(7, 40))

    expect(spawners).toEqual([])
  })

  it('retires again on the first tick after 07:00 the next day, and not at 06:50 before it', async () => {
    await tick(at(7, 10))

    expect((await tick(at(6, 50, 4))).spawners).toEqual([])
    expect((await tick(at(7, 5, 4))).spawners).toEqual(['seat-t', 'seat-u'])
  })

  it('retires nothing when the tick is paused or disabled', async () => {
    write(path.join(world, 'home', 'burndown.paused'), 'paused\n')
    const paused = await tick(at(7, 10))
    expect(paused).toMatchObject({ spawners: [], lines: [expect.stringMatching(/paused/)] })

    fs.rmSync(path.join(world, 'home', 'burndown.paused'))
    tickConfig({ enabled: false })
    const disabled = await tick(at(7, 20))
    expect(disabled).toMatchObject({ spawners: [], lines: [expect.stringMatching(/disabled/)] })
  })

  it('only prints the would-line under --dry-run, and leaves the seat due', async () => {
    const dry = await tick(at(7, 10), true)

    expect(dry.spawners).toEqual([])
    expect(dry.lines).toEqual(
      expect.arrayContaining(['would retire finished (seat-t)', 'would retire finished (seat-u)']),
    )
    expect((await tick(at(7, 20))).spawners).toEqual(['seat-t', 'seat-u'])
  })
})
