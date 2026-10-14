import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readLedger, writeLedger, type Claim } from '../agents/burndown/ledger.js'
import { burndownLedgerPath } from '../paths.js'
import { run, type Runner } from '../agents/burndown/exec.js'
import type { SpawnFrame } from '../agents/burndown/execute.js'
import type { AgentIdentity } from '../protocol.js'
import { tickFromDisk, type TickBroker } from '../agents/burndown/run-tick.js'
import { SERVICE_CHECK_WINDOW_MS } from '../agents/burndown/service-check.js'
import { TRUST_RULE_BASELINE_CLI_VERSION } from '../agents/trust.js'
import { BrokerClient } from '../client/broker-client.js'
import { withBroker } from '../cli/client.js'
import { burndownPlanVerb } from '../cli/verbs/burndown.js'

/**
 * CC-350: with seats configured and an unusable seat-watchdog.json, the tick and `plan --seat`
 * skip the seat paths with one logged line and still run the legacy planner; no seat dispatches.
 */

let world: string
const saved = { ...process.env }
const NOW = new Date(2026, 1, 3, 12, 0)
const TICK_MS = SERVICE_CHECK_WINDOW_MS / 2
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString()

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })

const repo = (): string => path.join(world, 'repo')
const accountPath = (): string => path.join(world, 'profiles', 'agents')
const autonomyRoot = (): string => path.join(world, 'aw', 'claude-channels', 'sources', 'autonomy')

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
    `---\nseats: [seat-t]\n${DEFAULTS}\npools:\n  ${pool}\n---\n`,
  )
  write(
    path.join(autonomyRoot(), 'seats', 'seat-t.md'),
    `---\nprefix: st\npool: pool-t\ninitiatives: {demo: 1.0}\nrepos:\n  - {path: ${repo()}, initiatives: [demo]}\nconcurrency: {implementers: 2, reviewers: 1, planners: 1}\n---\n`,
  )
  write(path.join(world, 'aw', 'demo', 'brief.md'), '---\ntitle: demo\nstate: focused\n---\n# demo\n')
  write(
    path.join(world, 'aw', 'demo', 'tasks', 'T-1.yml'),
    'id: T-1\ntitle: Do T-1\npriority: 3\nestimate: 2\ndone_when: unit tests cover the new branch\nstatus: open\ntags:\n  - agent-chat\n',
  )
  const config = { enabled: true, reportTo: 'coord', maxAgents: 3, reserveSlots: 2, seats: ['seat-t'] }
  write(path.join(world, 'home', 'burndown.config.json'), JSON.stringify(config))
  write(path.join(world, 'home', 'config.json'), JSON.stringify({ worktreeBudget: 10 }))
}

function account(): void {
  const rate_limits = { seven_day: { used_percentage: 40 }, five_hour: { used_percentage: 10 } }
  write(
    path.join(accountPath(), 'status-cache', 'sessions', 's1.json'),
    JSON.stringify({ session_id: 's1', written_at: NOW.getTime() / 1000 - 30, rate_limits }),
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

const checkJson = (cause: string | null, message = 'synthetic message'): string =>
  JSON.stringify({ ok: cause === null, cause, message, health: null, detail: {} })

/** Answers the service check with `cause`, Shepherd with no rows, and the origin lookup with a GitHub remote; counts service checks. */
function factory(cause: string | null, message?: string) {
  const checks: string[][] = []
  const exec: Runner = (bin, args, cwd) => {
    if (bin === 'titan-factory' && args[0] === 'service') {
      checks.push(args)
      return { status: cause === null ? 0 : 1, stdout: checkJson(cause, message) }
    }
    if (bin === 'titan-factory') return { status: 0, stdout: '[]' }
    if (bin === 'gh') return { status: 0, stdout: '' }
    if (bin === 'git' && args.includes('get-url'))
      return { status: 0, stdout: 'https://github.com/acme/widgets.git\n' }
    return run(bin, args, cwd)
  }
  return { exec, checks }
}

function fakeBroker(agents: AgentIdentity[] = []): { broker: TickBroker; frames: SpawnFrame[] } {
  const frames: SpawnFrame[] = []
  const broker: TickBroker = {
    roster: async () => ({ agents, slots: { held: 4, cap: 36 } }),
    inboxSince: async () => [],
    spawn: async frame => (frames.push(frame), { ok: true, agentId: `id-${frame.name}` }),
    retire: async () => ({ ok: true }),
    queue: async () => [],
    resume: async name => ({ ok: true, agentId: `id-${name}` }),
    retireFinished: async () => ({ ok: true, plan: [], results: [] }),
    collisionView: async () => ({ names: [], claims: [] }),
    seatSender: async () => ({
      send: async () => ({ ok: true }),
      notify: async () => ({ ok: true }),
      close: () => undefined,
    }),
  }
  return { broker, frames }
}

const tick = (exec: Runner, dryRun = false) => {
  const fake = fakeBroker()
  return tickFromDisk({ dryRun, broker: fake.broker, now: NOW, log: () => {}, exec }).then(lines => ({
    lines,
    frames: fake.frames,
  }))
}

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-watchdog-unusable-')))
  process.env.AGENT_CHAT_HOME = path.join(world, 'home')
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(world, 'aw')
  process.env.CLAUDE_PROFILE_ROOT = path.join(world, 'profiles')
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.AGENT_CHAT_STATUS_CACHE
  gitRepo()
  seatWorld()
  installClaude()
  account()
})

afterEach(() => {
  process.env = { ...saved }
  fs.rmSync(world, { recursive: true, force: true })
})

const exitedRow = (name: string, cwd: string): AgentIdentity => ({
  agentId: `id-${name}`,
  name,
  profile: 'bd-implementer',
  state: 'exited',
  origin: 'spawned',
  spawnedBy: 'human',
  spawnedAt: NOW.getTime(),
  brief: '',
  cwd,
  isolation: 'worktree',
  surface: 'headless',
  sessionId: '',
  configDir: accountPath(),
  lastEventAt: NOW.getTime(),
  generation: 1,
})

const BROKEN = '{ not json'

describe('a usable seat-watchdog.json (control)', () => {
  it('lets the seat dispatch, so the skip above is the file and nothing else', async () => {
    write(path.join(world, 'home', 'seat-watchdog.json'), '{}')
    const fake = fakeBroker()

    await tickFromDisk({
      dryRun: false,
      broker: fake.broker,
      now: NOW,
      log: () => {},
      exec: factory(null).exec,
    })

    expect(fake.frames.map(f => f.name)).toEqual(['st-t-1'])
  })
})

describe('an unusable seat-watchdog.json with seats configured', () => {
  beforeEach(() => write(path.join(world, 'home', 'seat-watchdog.json'), BROKEN))

  it('the tick logs one line naming the file, dispatches no seat, and still completes', async () => {
    const fake = fakeBroker()
    const events: [string, Record<string, unknown>][] = []

    const lines = await tickFromDisk({
      dryRun: false,
      broker: fake.broker,
      now: NOW,
      log: (event, detail) => events.push([event, detail]),
      exec: factory(null).exec,
    })

    const skipped = events.filter(([event]) => event === 'burndown_seat_paths_skipped')
    expect(skipped).toHaveLength(1)
    expect(String(skipped[0]?.[1].reason)).toContain('seat-watchdog.json is unusable')
    expect(fake.frames).toEqual([])
    expect(lines[0]).toContain('burndown tick at')
  })

  it('defers a held seat claim without stalling it or touching it', async () => {
    const worktree = path.join(repo(), '.worktrees', 'st-t-1')
    git(repo(), 'worktree', 'add', '-q', '-b', 'agent-chat/st-t-1', worktree)
    const reviewing: Claim = {
      taskId: 'T-1',
      initiative: 'demo',
      seat: 'seat-t',
      namePrefix: 'st',
      spawnedAt: NOW.toISOString(),
      phase: 'reviewing',
      phaseAt: NOW.toISOString(),
      agentName: 'st-t-1-r0',
      spawned: ['st-t-1', 'st-t-1-r0'],
      worktree,
    }
    writeLedger(burndownLedgerPath(), { version: 1, claims: [reviewing] })
    const fake = fakeBroker([exitedRow('st-t-1-r0', worktree)])

    await tickFromDisk({
      dryRun: false,
      broker: fake.broker,
      now: NOW,
      log: () => {},
      exec: factory(null).exec,
    })

    expect(fake.frames).toEqual([])
    expect(readLedger(burndownLedgerPath()).claims).toEqual([reviewing])
  })

  it('plan --seat falls back to the legacy plan and dispatches no seat', async () => {
    vi.spyOn(BrokerClient.prototype, 'connect').mockRejectedValue(new Error('no broker'))

    const report = await burndownPlanVerb.run(
      { seat: 'seat-t' },
      { warnings: [], format: 'human', withBroker },
    )

    expect(report.ok).toBe(true)
    expect(report.lines[0]).toContain('seat paths skipped')
    expect(report.lines.join('\n')).toContain('not opted in (1 focused')
    expect(report.lines.join('\n')).not.toContain('would dispatch demo')
  })
})
