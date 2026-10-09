import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run, type Runner } from '../agents/burndown/exec.js'
import type { SpawnFrame } from '../agents/burndown/execute.js'
import { writeLedger } from '../agents/burndown/ledger.js'
import { tickFromDisk, type TickBroker } from '../agents/burndown/run-tick.js'
import { readSeatLog } from '../agents/seats/stops.js'
import { TRUST_RULE_BASELINE_CLI_VERSION } from '../agents/trust.js'
import { burndownLedgerPath } from '../paths.js'

/**
 * CC-859: a seat tick that dispatches nothing writes one clock-stamped line to the seat's log naming
 * the machine stop, budget stop or full cap with its reading, or the refusal counts by kind. A
 * seats-mode fixture world with one synthetic seat and task; `git` runs for real.
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
const seatLog = (): string => path.join(autonomyRoot(), 'logs', 'seat-t', '2026-02-03.md')
const logLines = (): string[] =>
  fs.existsSync(seatLog()) ? fs.readFileSync(seatLog(), 'utf8').split('\n').filter(Boolean) : []

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

const READY_TASK =
  'id: T-1\ntitle: Do T-1\npriority: 3\nestimate: 2\ndone_when: unit tests cover the new branch\nstatus: open\ntags:\n  - agent-chat\n'
const UNTRIAGED_TASK = 'id: T-2\ntitle: Do T-2\npriority: 3\nstatus: open\ntags:\n  - agent-chat\n'

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
  task('T-1', READY_TASK)
  const config = { enabled: true, reportTo: 'coord', maxAgents: 3, reserveSlots: 2, seats: ['seat-t'] }
  write(path.join(world, 'home', 'burndown.config.json'), JSON.stringify(config))
  write(path.join(world, 'home', 'config.json'), JSON.stringify({ worktreeBudget: 10 }))
}

const task = (id: string, text: string): void =>
  write(path.join(world, 'aw', 'demo', 'tasks', `${id}.yml`), text)

function account(sevenDay: number): void {
  const rate_limits = { seven_day: { used_percentage: sevenDay }, five_hour: { used_percentage: 10 } }
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

/** Answers the service check with `cause`, Shepherd with no rows, and the origin lookup with a GitHub remote. */
function factory(cause: string | null): Runner {
  return (bin, args, cwd) => {
    if (bin === 'titan-factory' && args[0] === 'service') {
      const stdout = JSON.stringify({
        ok: cause === null,
        cause,
        message: 'synthetic',
        health: null,
        detail: {},
      })
      return { status: cause === null ? 0 : 1, stdout }
    }
    if (bin === 'titan-factory') return { status: 0, stdout: '[]' }
    if (bin === 'gh') return { status: 0, stdout: '' }
    if (bin === 'git' && args.includes('get-url'))
      return { status: 0, stdout: 'https://github.com/acme/widgets.git\n' }
    return run(bin, args, cwd)
  }
}

function fakeBroker(held: number): { broker: TickBroker; frames: SpawnFrame[] } {
  const frames: SpawnFrame[] = []
  const broker: TickBroker = {
    roster: async () => ({ agents: [], slots: { held, cap: 36 } }),
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

interface TickAt {
  now?: Date
  cause?: string | null
  held?: number
  dryRun?: boolean
}

async function tick({ now = NOW, cause = null, held = 4, dryRun = false }: TickAt = {}) {
  const fake = fakeBroker(held)
  const lines = await tickFromDisk({ dryRun, broker: fake.broker, now, log: () => {}, exec: factory(cause) })
  return { lines, frames: fake.frames }
}

/** A stopping service-check read on the last tick, so this tick's stopping read stops the line. */
const stoppingBefore = (): void =>
  writeLedger(burndownLedgerPath(), {
    version: 1,
    claims: [],
    serviceCheck: { at: new Date(NOW.getTime() - 300_000).toISOString(), cause: 'stale pid' },
  })

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-no-dispatch-')))
  process.env.AGENT_CHAT_HOME = path.join(world, 'home')
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(world, 'aw')
  process.env.CLAUDE_PROFILE_ROOT = path.join(world, 'profiles')
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.AGENT_CHAT_STATUS_CACHE
  gitRepo()
  seatWorld()
  installClaude()
  account(40)
})

afterEach(() => {
  process.env = { ...saved }
  fs.rmSync(world, { recursive: true, force: true })
})

describe('a seat tick that dispatches nothing', () => {
  it('names the machine stop with its reading', async () => {
    stoppingBefore()

    const { frames } = await tick({ cause: 'crash loop' })

    expect(frames).toEqual([])
    expect(logLines()).toEqual([
      expect.stringMatching(
        /^12:00 burndown: dispatched nothing; machine stop: service check failed twice \(stale pid, then crash loop\).*; refusals stop-line 1$/,
      ),
    ])
  })

  it('names the budget stop with its reading', async () => {
    account(95)

    const { frames } = await tick()

    expect(frames).toEqual([])
    expect(logLines()).toEqual([
      expect.stringMatching(/^12:00 burndown: dispatched nothing; budget stop: .*95.*; refusals budget 1$/),
    ])
  })

  it('names the full cap with its reading', async () => {
    const { frames } = await tick({ held: 36 })

    expect(frames).toEqual([])
    expect(logLines()).toEqual([
      expect.stringMatching(
        /^12:00 burndown: dispatched nothing; full cap: .*broker slots 36\/36 held.*; refusals slots 1$/,
      ),
    ])
  })

  it('gives the refusal counts by kind when no stop applied', async () => {
    fs.rmSync(path.join(world, 'aw', 'demo', 'tasks', 'T-1.yml'))
    task('T-2', UNTRIAGED_TASK)

    await tick()

    expect(logLines()).toEqual(['12:00 burndown: dispatched nothing; refusals untriaged 1'])
  })

  it('says scope is exhausted when nothing was refused', async () => {
    fs.rmSync(path.join(world, 'aw', 'demo', 'tasks', 'T-1.yml'))

    await tick()

    expect(logLines()).toEqual(['12:00 burndown: dispatched nothing; scope exhausted: no open task in scope'])
  })

  it('writes nothing again for the same reasons inside the hour', async () => {
    await tick({ held: 36 })

    await tick({ now: later(10), held: 36 })
    await tick({ now: later(50), held: 36 })

    expect(logLines()).toHaveLength(1)
  })

  it('writes again once the hour has passed', async () => {
    await tick({ held: 36 })

    await tick({ now: later(60), held: 36 })

    expect(logLines().map(l => l.slice(0, 5))).toEqual(['12:00', '13:00'])
  })

  it('writes again when the reasons change', async () => {
    await tick({ held: 36 })
    account(95)

    await tick({ now: later(10), held: 4 })

    expect(logLines()).toEqual([
      expect.stringMatching(/^12:00 .*full cap/),
      expect.stringMatching(/^12:10 .*budget stop/),
    ])
  })

  it('never starts a line with a seat stop marker, and a PARKED seat stays parked', async () => {
    write(seatLog(), '11:50 PARKED owner asked\n')
    account(95)

    await tick()

    const lines = logLines()
    expect(lines).toHaveLength(2)
    expect(lines.some(l => /^\d\d:\d\d (WRAP|PARKED|BUDGET-PAUSE)\b/.test(l) && !l.startsWith('11:50'))).toBe(
      false,
    )
    expect(readSeatLog(fs.readFileSync(seatLog(), 'utf8'), NOW).stop).toMatch(/PARKED/)
  })
})

describe('a seat tick that dispatches', () => {
  it('writes no reason line', async () => {
    const { frames } = await tick()

    expect(frames.map(f => f.name)).toEqual(['st-t-1'])
    expect(logLines().filter(l => l.includes('dispatched nothing'))).toEqual([])
  })
})

describe('a dry-run tick', () => {
  it('shows the line and writes nothing', async () => {
    const { lines } = await tick({ held: 36, dryRun: true })

    expect(lines).toContainEqual(
      expect.stringMatching(/^would log for seat seat-t: burndown: dispatched nothing; full cap: /),
    )
    expect(logLines()).toEqual([])
  })
})
