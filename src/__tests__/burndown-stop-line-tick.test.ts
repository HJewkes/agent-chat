import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run, type Runner } from '../agents/burndown/exec.js'
import type { SpawnFrame } from '../agents/burndown/execute.js'
import { readLedger, writeLedger, type Ledger } from '../agents/burndown/ledger.js'
import { tickFromDisk, type TickBroker } from '../agents/burndown/run-tick.js'
import { seatCompareFromDisk } from '../agents/burndown/seat-compare.js'
import { SERVICE_CHECK_WINDOW_MS } from '../agents/burndown/service-check.js'
import { seatPlanFromDisk } from '../agents/burndown/tick.js'
import { TRUST_RULE_BASELINE_CLI_VERSION } from '../agents/trust.js'
import { burndownLedgerPath } from '../paths.js'

/**
 * CC-785: the tick reads `titan-factory service check --json` once, persists the read, and stops
 * the line only on two stopping reads in a row. A seats-mode fixture world with one synthetic seat
 * and task; the fake runner answers `titan-factory` and the origin lookup, and `git` runs for real.
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

function fakeBroker(): { broker: TickBroker; frames: SpawnFrame[] } {
  const frames: SpawnFrame[] = []
  const broker: TickBroker = {
    roster: async () => ({ agents: [], slots: { held: 4, cap: 36 } }),
    inboxSince: async () => [],
    spawn: async frame => (frames.push(frame), { ok: true, agentId: `id-${frame.name}` }),
    retire: async () => ({ ok: true }),
    queue: async () => [],
    resume: async name => ({ ok: true, agentId: `id-${name}` }),
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

const ledger = (): Ledger => readLedger(burndownLedgerPath())
const previous = (cause: string | null, at = ago(TICK_MS)): void =>
  writeLedger(burndownLedgerPath(), { version: 1, claims: [], serviceCheck: { at, cause } })

const STOP_REASON =
  'service check failed twice (stale pid, then crash loop): serve restarted 3 times; only cos:expedite dispatches'

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-stop-line-')))
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

describe('the tick under the two-read rule', () => {
  it('one stopping read does not stop the line, and the read is persisted', async () => {
    const fake = factory('stale pid')

    const { frames } = await tick(fake.exec)

    expect(frames.map(f => f.name)).toEqual(['st-t-1'])
    expect(fake.checks).toEqual([['service', 'check', '--json']])
    expect(ledger().serviceCheck).toEqual({ at: NOW.toISOString(), cause: 'stale pid' })
  })

  it('two consecutive stopping reads stop it', async () => {
    previous('stale pid')
    const fake = factory('crash loop', 'serve restarted 3 times')

    const { lines, frames } = await tick(fake.exec)

    expect(frames).toEqual([])
    expect(lines).toContain(`refused demo T-1 [stop-line]: ${STOP_REASON}`)
    expect(ledger().serviceCheck).toEqual({ at: NOW.toISOString(), cause: 'crash loop' })
  })

  it('an ok read clears a stop', async () => {
    previous('crash loop')

    const { frames } = await tick(factory(null).exec)

    expect(frames.map(f => f.name)).toEqual(['st-t-1'])
    expect(ledger().serviceCheck).toEqual({ at: NOW.toISOString(), cause: null })
  })

  it('a previous read older than two tick intervals does not count', async () => {
    previous('stale pid', ago(SERVICE_CHECK_WINDOW_MS + 60_000))

    const { frames } = await tick(factory('crash loop').exec)

    expect(frames.map(f => f.name)).toEqual(['st-t-1'])
  })

  it.each(['stale build', 'tick failing', 'tick stale'])('%s is a note, not a stop', async cause => {
    previous(cause)

    const { lines, frames } = await tick(factory(cause, 'synthetic note').exec)

    expect(frames.map(f => f.name)).toEqual(['st-t-1'])
    expect(lines).toContain(`service check: ${cause} (a note, the line runs): synthetic note`)
  })

  it('a dry-run tick reads once and does not write the ledger', async () => {
    previous('stale pid')
    const before = fs.readFileSync(burndownLedgerPath(), 'utf8')
    const fake = factory('crash loop', 'serve restarted 3 times')

    const { lines } = await tick(fake.exec, true)

    expect(lines).toContain(`refused demo T-1 [stop-line]: ${STOP_REASON}`)
    expect(fake.checks).toHaveLength(1)
    expect(fs.readFileSync(burndownLedgerPath(), 'utf8')).toBe(before)
  })
})

describe('the dry-run seat verbs', () => {
  const opts = (exec: Runner) => ({
    seat: 'seat-t',
    now: NOW,
    root: path.join(world, 'aw'),
    autonomyRoot: autonomyRoot(),
    exec,
  })

  it('plan --seat does not write the ledger', () => {
    previous('stale pid')
    const before = fs.readFileSync(burndownLedgerPath(), 'utf8')
    const fake = factory('crash loop', 'serve restarted 3 times')

    const planned = seatPlanFromDisk(opts(fake.exec))

    expect(planned.dispatch).toEqual([])
    expect(planned.refusals).toEqual([
      expect.objectContaining({ task: 'T-1', kind: 'stop-line', reason: STOP_REASON }),
    ])
    expect(fake.checks).toHaveLength(1)
    expect(fs.readFileSync(burndownLedgerPath(), 'utf8')).toBe(before)
  })

  it('seats compare reads the check once and does not write the ledger', () => {
    previous('stale pid')
    const before = fs.readFileSync(burndownLedgerPath(), 'utf8')
    const fake = factory('crash loop')
    const scorePy: Runner = () => ({ status: 0, stdout: JSON.stringify({ order: [] }), stderr: '' })

    seatCompareFromDisk({ ...opts(fake.exec), runner: scorePy })

    expect(fake.checks).toHaveLength(1)
    expect(fs.readFileSync(burndownLedgerPath(), 'utf8')).toBe(before)
  })
})
