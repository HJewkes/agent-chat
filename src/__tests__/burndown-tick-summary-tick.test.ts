import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run, type Runner } from '../agents/burndown/exec.js'
import { readLedger } from '../agents/burndown/ledger.js'
import { tickFromDisk, type TickBroker } from '../agents/burndown/run-tick.js'
import { readTickStatus } from '../agents/burndown/tick-status.js'
import { TRUST_RULE_BASELINE_CLI_VERSION } from '../agents/trust.js'
import type { AgentIdentity } from '../protocol.js'

/** CC-929: the live tick appends one summary row, and a summary it cannot write never fails it. `git` runs for real. */

let world: string
const saved = { ...process.env }
const NOW = new Date(2026, 1, 3, 12, 0)

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })

const home = (): string => path.join(world, 'home')
const repo = (): string => path.join(world, 'repo')
const accountPath = (): string => path.join(world, 'profiles', 'agents')
const autonomyRoot = (): string => path.join(world, 'aw', 'claude-channels', 'sources', 'autonomy')
const ticksFile = (): string => path.join(home(), 'burndown-ticks.jsonl')

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

const readyTask = (id: string, tag: string): string =>
  `id: ${id}\ntitle: Do ${id}\npriority: 3\nestimate: 2\ndone_when: unit tests cover the new branch\nstatus: open\ntags:\n  - agent-chat\n  - ${tag}\n`

function seatWorld(): void {
  const pool = `pool-t: {config_dir: ${accountPath()}, human_uses: false, reserve_seven_day: 30, ceiling_five_hour: 75}`
  write(
    path.join(autonomyRoot(), 'charter.md'),
    `---\nseats: [seat-t]\n${DEFAULTS}\npools:\n  ${pool}\n---\n`,
  )
  write(
    path.join(autonomyRoot(), 'seats', 'seat-t.md'),
    `---\nprefix: st\npool: pool-t\ninitiatives: {demo: 1.0}\nrepos:\n  - {path: ${repo()}, initiatives: [demo]}\nconcurrency: {implementers: 1, reviewers: 1, planners: 1}\n---\n`,
  )
  write(path.join(world, 'aw', 'demo', 'brief.md'), '---\ntitle: demo\nstate: focused\n---\n# demo\n')
  const tasks = path.join(world, 'aw', 'demo', 'tasks')
  write(path.join(tasks, 'T-1.yml'), readyTask('T-1', 'brief:ready=2026-02-02'))
  write(path.join(tasks, 'T-2.yml'), readyTask('T-2', 'brief:ready=2026-01-01'))
  write(
    path.join(tasks, 'T-3.yml'),
    'id: T-3\ntitle: Do T-3\npriority: 3\nstatus: open\ntags:\n  - agent-chat\n',
  )
  const config = { enabled: true, reportTo: 'coord', maxAgents: 3, reserveSlots: 2, seats: ['seat-t'] }
  write(path.join(home(), 'burndown.config.json'), JSON.stringify(config))
  write(path.join(home(), 'config.json'), JSON.stringify({ worktreeBudget: 10 }))
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

/** One open seat PR on T-4 that changes only a test, for the adopt path to register (CC-861). */
const SEAT_PULL = JSON.stringify({
  number: 7,
  title: 'T-4: Cover the edge',
  branch: 'agent-chat/st-t-4',
  headRepo: 'acme/widgets',
  updatedAt: NOW.toISOString(),
})
const PULL_FILES = JSON.stringify({ path: 'src/__tests__/edge.test.ts', additions: 3, deletions: 0 })

/** Answers `gh api` for the seat's open pulls and their files, and nothing else. */
const adoptGh = (args: readonly string[]): string => {
  const url = args.find(a => a.startsWith('repos/')) ?? ''
  if (url.includes('/files')) return PULL_FILES
  return url.includes('/pulls?') ? SEAT_PULL : ''
}

/** A healthy service check, Shepherd with no rows that accepts every register, and a GitHub remote. */
const factoryWith =
  (gh: (args: readonly string[]) => string): Runner =>
  (bin, args, cwd) => {
    if (bin === 'titan-factory' && args[0] === 'service')
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, cause: null, message: 'ok', health: null, detail: {} }),
      }
    if (bin === 'titan-factory') return { status: 0, stdout: '[]' }
    if (bin === 'gh') return { status: 0, stdout: gh(args) }
    if (bin === 'git' && args.includes('get-url'))
      return { status: 0, stdout: 'https://github.com/acme/widgets.git\n' }
    return run(bin, args, cwd)
  }

const factory = factoryWith(() => '')

let agents: AgentIdentity[] = []

const broker: TickBroker = {
  roster: async () => ({ agents, slots: { held: 4, cap: 36 } }),
  inboxSince: async () => [],
  spawn: async frame => ({ ok: true, agentId: `id-${frame.name}` }),
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

async function tick(log: (event: string) => void = () => {}, exec: Runner = factory): Promise<void> {
  await tickFromDisk({
    dryRun: false,
    broker,
    now: NOW,
    log: event => log(event),
    exec,
    ownerQueueDir: path.join(world, 'spool'),
  })
}

beforeEach(() => {
  agents = []
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-tick-summary-')))
  process.env.AGENT_CHAT_HOME = home()
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

describe('the burndown tick summary in the live tick', () => {
  it('appends one row with the seat brief counts, dispatches, refusals, roles and registrations', async () => {
    await tick()

    const lines = fs.readFileSync(ticksFile(), 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toEqual({
      v: 1,
      ts: NOW.toISOString(),
      registrations: { ok: 0, refused: 0, failed: 0 },
      seats: {
        'seat-t': {
          ready: 1,
          unbriefed: 1,
          stale: 1,
          dispatched: 1,
          refusals: { 'role-cap': 1, untriaged: 1 },
          roles: {
            used: { implementers: 1, reviewers: 0, planners: 0 },
            cap: { implementers: 1, reviewers: 1, planners: 1 },
          },
          registrations: { ok: 0, refused: 0, failed: 0 },
        },
      },
    })
  })

  it('counts a live hand-spawned seat agent in roles used, as the role cap does', async () => {
    agents = [{ name: 'st-hand', profile: 'bd-reviewer', state: 'live', cwd: '/elsewhere' } as AgentIdentity]

    await tick()

    const row = JSON.parse(fs.readFileSync(ticksFile(), 'utf8'))
    expect(row.seats['seat-t'].roles.used).toEqual({ implementers: 1, reviewers: 1, planners: 0 })
  })

  it('counts a seat PR the adopt path registered, for the seat and the tick', async () => {
    write(
      path.join(world, 'aw', 'demo', 'tasks', 'T-4.yml'),
      'id: T-4\ntitle: Cover the edge\npriority: 3\nstatus: done\ntags:\n  - kind:correctness\n',
    )

    await tick(() => {}, factoryWith(adoptGh))

    const row = JSON.parse(fs.readFileSync(ticksFile(), 'utf8'))
    expect(row.registrations).toEqual({ ok: 1, refused: 0, failed: 0 })
    expect(row.seats['seat-t'].registrations).toEqual({ ok: 1, refused: 0, failed: 0 })
  })

  it('still writes the ledger and records an ok tick when the summary cannot be written', async () => {
    fs.mkdirSync(ticksFile(), { recursive: true })
    const events: string[] = []

    await tick(e => events.push(e))
    await tick(e => events.push(e))

    expect(readTickStatus(path.join(home(), 'burndown-status.json'))).toEqual({
      consecutiveFailures: 0,
      lastOkAt: NOW.toISOString(),
    })
    expect(readLedger(path.join(home(), 'burndown.json')).lastTickAt).toBe(NOW.toISOString())
    expect(events.filter(e => e === 'burndown_tick_summary_failed')).toHaveLength(1)
  })
})
