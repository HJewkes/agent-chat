import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run, type Runner } from '../agents/burndown/exec.js'
import { writeLedger, type Claim } from '../agents/burndown/ledger.js'
import { burndownRefusalsPath, type RefusalSnapshot } from '../agents/burndown/refusal-snapshot.js'
import { tickFromDisk, type TickBroker } from '../agents/burndown/run-tick.js'
import { TRUST_RULE_BASELINE_CLI_VERSION } from '../agents/trust.js'
import { burndownLedgerPath } from '../paths.js'

/**
 * CC-1241: each tick overwrites `burndown-refusals.json` with every seat refusal and the task or PR it waits on.
 * A seats-mode fixture world with one synthetic seat; `git` runs for real and `gh` answers one open PR.
 */

let world: string
const saved = { ...process.env }
const NOW = new Date(2026, 1, 3, 12, 0)
const LATER = new Date(2026, 1, 3, 12, 10)

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

const ready = (id: string, tags: string[] = []): string =>
  `id: ${id}\ntitle: Do ${id}\npriority: 3\nestimate: 2\ndone_when: unit tests cover it\nstatus: open\ntags:\n${['agent-chat', ...tags].map(t => `  - ${t}\n`).join('')}`

const task = (id: string, text: string): void =>
  write(path.join(world, 'aw', 'demo', 'tasks', `${id}.yml`), text)

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
  const config = { enabled: true, reportTo: 'coord', maxAgents: 3, reserveSlots: 2, seats: ['seat-t'] }
  write(path.join(world, 'home', 'burndown.config.json'), JSON.stringify(config))
  write(path.join(world, 'home', 'config.json'), JSON.stringify({ worktreeBudget: 10 }))
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

/** Shepherd with no rows, one open PR #7 touching `src/widget.ts`, and the origin lookup with a GitHub remote. */
const factory: Runner = (bin, args, cwd) => {
  if (bin === 'titan-factory' && args[0] === 'service')
    return {
      status: 0,
      stdout: JSON.stringify({ ok: true, cause: null, message: 'synthetic', health: null, detail: {} }),
    }
  if (bin === 'titan-factory') return { status: 0, stdout: '[]' }
  const endpoint = args[2] ?? ''
  if (bin === 'gh' && endpoint.includes('/pulls?state=open'))
    return {
      status: 0,
      stdout: `${JSON.stringify({ number: 7, title: 'Other work', branch: 'feat/other', body: '' })}\n`,
    }
  if (bin === 'gh' && endpoint.includes('/pulls/7/files'))
    return { status: 0, stdout: `${JSON.stringify({ filename: 'src/widget.ts', previous: null })}\n` }
  if (bin === 'gh') return { status: 0, stdout: '' }
  if (bin === 'git' && args.includes('get-url'))
    return { status: 0, stdout: 'https://github.com/acme/widgets.git\n' }
  return run(bin, args, cwd)
}

const broker: TickBroker = {
  roster: async () => ({ agents: [], slots: { held: 4, cap: 36 } }),
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

const queuedSlice: Claim = {
  taskId: 'T-4',
  initiative: 'demo',
  seat: 'seat-t',
  namePrefix: 'st',
  spawnedAt: NOW.toISOString(),
  phase: 'queued',
  phaseAt: NOW.toISOString(),
  slice: 'a',
  dependsOn: [],
  owns: ['src/widget.ts'],
}

const tick = (now: Date): Promise<string[]> =>
  tickFromDisk({ dryRun: false, broker, now, log: () => {}, exec: factory })

const isSnapshot = (value: unknown): value is RefusalSnapshot =>
  typeof value === 'object' &&
  value !== null &&
  'ts' in value &&
  typeof value.ts === 'string' &&
  'refusals' in value &&
  Array.isArray(value.refusals)

function readSnapshot(): RefusalSnapshot {
  const parsed: unknown = JSON.parse(fs.readFileSync(burndownRefusalsPath(), 'utf8'))
  if (!isSnapshot(parsed)) throw new Error('burndown-refusals.json is not a snapshot')
  return parsed
}

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-refusal-snapshot-')))
  process.env.AGENT_CHAT_HOME = path.join(world, 'home')
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(world, 'aw')
  process.env.CLAUDE_PROFILE_ROOT = path.join(world, 'profiles')
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.AGENT_CHAT_STATUS_CACHE
  gitRepo()
  seatWorld()
  installClaude()
  task('T-1', ready('T-1', ['dep:T-3']))
  task('T-3', 'id: T-3\ntitle: Do T-3\npriority: 3\nstatus: open\ntags:\n  - agent-chat\n')
  task('T-4', ready('T-4'))
  writeLedger(burndownLedgerPath(), { version: 1, claims: [queuedSlice] })
})

afterEach(() => {
  process.env = { ...saved }
  fs.rmSync(world, { recursive: true, force: true })
})

describe('the refusal snapshot', () => {
  // Mutation caught: dropping the dep ids from the dep-blocked reason fails the reason assertion.
  it('writes a dep-blocked task and a file-overlap slice with their blockers', async () => {
    await tick(NOW)

    const { ts, refusals } = readSnapshot()
    expect(ts).toBe(NOW.toISOString())
    expect(refusals).toContainEqual({
      seat: 'seat-t',
      initiative: 'demo',
      task: 'T-1',
      kind: 'plan-blocked',
      reason: 'dep-blocked: T-3 (open, no claim)',
      blocker: { task: 'T-3', state: 'open, no claim' },
    })
    expect(refusals).toContainEqual({
      seat: 'seat-t',
      initiative: 'demo',
      task: 'T-4',
      slice: 'a',
      kind: 'file-overlap',
      reason: '#7 touches src/widget.ts',
      blocker: { pr: 7, repo: repo() },
    })
  })

  it('replaces the last tick snapshot rather than appending to it', async () => {
    await tick(NOW)
    fs.rmSync(path.join(world, 'aw', 'demo', 'tasks', 'T-1.yml'))

    await tick(LATER)

    const { ts, refusals } = readSnapshot()
    expect(ts).toBe(LATER.toISOString())
    expect(refusals.filter(r => r.task === 'T-1')).toEqual([])
    expect(refusals.filter(r => r.kind === 'file-overlap')).toHaveLength(1)
  })
})
