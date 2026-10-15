import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run, type Runner } from '../agents/burndown/exec.js'
import type { SpawnFrame } from '../agents/burndown/execute.js'
import { writeLedger, type Claim } from '../agents/burndown/ledger.js'
import { tickFromDisk, type TickBroker } from '../agents/burndown/run-tick.js'
import { TRUST_RULE_BASELINE_CLI_VERSION } from '../agents/trust.js'
import { BrokerTimeoutError } from '../client/broker-client.js'
import { burndownLedgerPath, burndownTickStatusPath } from '../paths.js'

/**
 * CC-1343: a broker too slow to answer `inbox_since` costs the parked claim it was reading, not the
 * tick. A seats-mode fixture world with one synthetic seat, one parked claim and ready tasks; `git`
 * runs for real.
 */

let world: string
const saved = { ...process.env }
const NOW = new Date(2026, 1, 3, 12, 0)
const later = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000)

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
  worktrees_per_repo_per_seat: 5
  worktrees_left_free_per_repo: 0`

const readyTask = (id: string): string =>
  `id: ${id}\ntitle: Do ${id}\npriority: 3\nestimate: 2\ndone_when: unit tests cover the new branch\nstatus: open\ntags:\n  - agent-chat\n`

const task = (id: string): void => write(path.join(world, 'aw', 'demo', 'tasks', `${id}.yml`), readyTask(id))

const PARKED: Claim = {
  taskId: 'T-9',
  initiative: 'demo',
  seat: 'seat-t',
  namePrefix: 'st',
  spawnedAt: NOW.toISOString(),
  phase: 'parked',
  phaseAt: NOW.toISOString(),
  agentName: 'st-t-9',
  spawned: ['st-t-9'],
  inboxCursor: '0',
  notified: ['dispatched'],
}

function seatWorld(): void {
  const pool = `pool-t: {config_dir: ${accountPath()}, human_uses: false, reserve_seven_day: 30, ceiling_five_hour: 75}`
  write(
    path.join(autonomyRoot(), 'charter.md'),
    `---\nseats: [seat-t]\n${DEFAULTS}\npools:\n  ${pool}\n---\n`,
  )
  write(
    path.join(autonomyRoot(), 'seats', 'seat-t.md'),
    `---\nprefix: st\npool: pool-t\ninitiatives: {demo: 1.0}\nrepos:\n  - {path: ${repo()}, initiatives: [demo]}\nconcurrency: {implementers: 4, reviewers: 1, planners: 1}\n---\n`,
  )
  write(path.join(world, 'aw', 'demo', 'brief.md'), '---\ntitle: demo\nstate: focused\n---\n# demo\n')
  task('T-9')
  task('T-1')
  const config = { enabled: true, reportTo: 'coord', maxAgents: 6, reserveSlots: 2, seats: ['seat-t'] }
  write(path.join(world, 'home', 'burndown.config.json'), JSON.stringify(config))
  write(path.join(world, 'home', 'config.json'), JSON.stringify({ worktreeBudget: 10 }))
  writeLedger(burndownLedgerPath(), { version: 1, claims: [PARKED] })
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

/** Answers the service check healthy, Shepherd with no rows, and the origin lookup with a GitHub remote. */
const factory: Runner = (bin, args, cwd) => {
  if (bin === 'titan-factory' && args[0] === 'service')
    return {
      status: 0,
      stdout: JSON.stringify({ ok: true, cause: null, message: 'ok', health: null, detail: {} }),
    }
  if (bin === 'titan-factory') return { status: 0, stdout: '[]' }
  if (bin === 'gh') return { status: 0, stdout: '' }
  if (bin === 'git' && args.includes('get-url'))
    return { status: 0, stdout: 'https://github.com/acme/widgets.git\n' }
  return run(bin, args, cwd)
}

/** A broker whose `inbox_since` never answers in time; `roster` too when `rosterTimesOut`. */
function slowBroker(frames: SpawnFrame[], rosterTimesOut = false): TickBroker {
  return {
    roster: async () => {
      if (rosterTimesOut) throw new BrokerTimeoutError('agents_result')
      return { agents: [], slots: { held: 4, cap: 36 } }
    },
    inboxSince: async () => {
      throw new BrokerTimeoutError('inbox_since_result')
    },
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
}

async function tick(now: Date, rosterTimesOut = false): Promise<{ lines: string[]; frames: SpawnFrame[] }> {
  const frames: SpawnFrame[] = []
  const broker = slowBroker(frames, rosterTimesOut)
  const lines = await tickFromDisk({ dryRun: false, broker, now, log: () => {}, exec: factory })
  return { lines, frames }
}

const status = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(burndownTickStatusPath(), 'utf8')) as Record<string, unknown>

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-tick-broker-timeout-')))
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

describe('two ticks whose inbox_since times out', () => {
  // Mutation caught: reverting observe's inbox catch (both ticks fail, count 2, no spawn).
  it('both end ok with no failures counted, and the second still dispatches', async () => {
    const first = await tick(NOW)
    expect(first.frames.map(f => f.name)).toEqual(['st-t-1'])
    expect(status()).toMatchObject({ outcome: 'ok', consecutiveFailures: 0 })
    task('T-2')

    const second = await tick(later(10))

    expect(second.frames.map(f => f.name)).toEqual(['st-t-2'])
    expect(status()).toMatchObject({ outcome: 'ok', consecutiveFailures: 0 })
    expect(second.lines).toContainEqual(
      expect.stringMatching(/^unread T-9.*inbox unread \(broker did not answer inbox_since_result\)$/),
    )
  })
})

describe('a tick whose roster read times out', () => {
  // Mutation caught: a timeout thrown as a plain Error, which records lastErrorClass Error.
  it('fails with lastErrorClass BrokerTimeoutError', async () => {
    const { frames } = await tick(NOW, true)

    expect(frames).toEqual([])
    expect(status()).toMatchObject({
      outcome: 'failed',
      consecutiveFailures: 1,
      lastErrorClass: 'BrokerTimeoutError',
    })
  })
})
