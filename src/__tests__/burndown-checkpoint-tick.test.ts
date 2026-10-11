import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run, type Runner } from '../agents/burndown/exec.js'
import { LEASE_MS } from '../agents/burndown/lease.js'
import { readLedger, writeLedger, type Claim } from '../agents/burndown/ledger.js'
import { SHEPHERD_BIN } from '../agents/burndown/shepherd.js'
import { tickFromDisk, type TickBroker } from '../agents/burndown/run-tick.js'
import { burndownLedgerPath } from '../paths.js'
import type { AgentIdentity } from '../protocol.js'

/**
 * CC-663: a dirty, uncommitted claim gets one checkpoint request before any notice,
 * through whole ticks that read the ledger from disk, over a fixture seat world,
 * a real git worktree and a fake broker that records every peer send.
 */

let world: string
const saved = { ...process.env }
const NOON = new Date(2026, 8, 26, 12, 0)
const MIN = 60_000
const AGENT = 'st-dm-1'
const SEAT = 'seat-t'

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })

const repo = (): string => path.join(world, 'repo')
const worktree = (): string => path.join(repo(), '.worktrees', AGENT)
const accountPath = (): string => path.join(world, 'profiles', 'agents')
const at = (minutes: number): Date => new Date(NOON.getTime() + minutes * MIN)

const TASK =
  'id: DM-1\ntitle: Do DM-1\npriority: 3\nestimate: 2\ndone_when: unit tests cover the new branch\nstatus: open\nupdated: 2026-09-20\ntags:\n  - agent-chat\n'

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

function freshAccount(now: Date): void {
  const rate_limits = { seven_day: { used_percentage: 40 }, five_hour: { used_percentage: 10 } }
  write(
    path.join(accountPath(), 'status-cache', 'sessions', 's1.json'),
    JSON.stringify({ session_id: 's1', written_at: now.getTime() / 1000 - 30, rate_limits }),
  )
}

function seatWorld(): void {
  const root = path.join(world, 'aw', 'claude-channels', 'sources', 'autonomy')
  const pool = `pool-t: {config_dir: ${accountPath()}, human_uses: false, reserve_seven_day: 30, ceiling_five_hour: 75}`
  write(path.join(root, 'charter.md'), `---\nseats: [${SEAT}]\n${DEFAULTS}\npools:\n  ${pool}\n---\n`)
  write(
    path.join(root, 'seats', `${SEAT}.md`),
    `---\nprefix: st\npool: pool-t\ninitiatives: {demo: 1.0}\nrepos:\n  - {path: ${repo()}, initiatives: [demo]}\nconcurrency: {implementers: 2, reviewers: 1, planners: 1}\n---\n`,
  )
  write(path.join(world, 'aw', 'demo', 'brief.md'), '---\ntitle: demo\nstate: focused\n---\n# demo\n')
  write(path.join(world, 'aw', 'demo', 'tasks', 'DM-1.yml'), TASK)
  const config = { enabled: true, reportTo: 'coord', maxAgents: 3, reserveSlots: 2, seats: [SEAT] }
  write(path.join(world, 'home', 'burndown.config.json'), JSON.stringify(config))
}

const liveRow = (): AgentIdentity => ({
  agentId: `id-${AGENT}`,
  name: AGENT,
  profile: 'bd-implementer',
  state: 'live',
  origin: 'spawned',
  spawnedBy: 'human',
  spawnedAt: NOON.getTime(),
  brief: '',
  cwd: worktree(),
  isolation: 'worktree',
  surface: 'headless',
  sessionId: '',
  configDir: accountPath(),
  lastEventAt: NOON.getTime(),
  generation: 1,
})

interface Send {
  to: string
  text: string
}

interface Fake {
  broker: TickBroker
  sends: Send[]
  /** Sends to the agent refused so far, until `refuseAgent` runs out. */
  refuseAgent: number
}

function fakeBroker(refuseAgent = 0): Fake {
  const fake: Fake = { sends: [], refuseAgent, broker: {} as TickBroker }
  fake.broker = {
    roster: async () => ({ agents: [liveRow()], slots: { held: 4, cap: 36 } }),
    inboxSince: async () => [],
    spawn: async () => ({ ok: false, reason: 'no spawn expected' }),
    retire: async () => ({ ok: false, reason: 'no retire expected' }),
    queue: async () => [],
    resume: async name => ({ ok: true, agentId: `id-${name}` }),
    collisionView: async () => ({ names: [], claims: [] }),
    seatSender: async () => ({
      send: async (to, text) => {
        fake.sends.push({ to, text })
        if (to !== AGENT || fake.refuseAgent === 0) return { ok: true }
        fake.refuseAgent -= 1
        return { ok: false, reason: 'no session named st-dm-1' }
      },
      notify: async () => ({ ok: true }),
      close: () => {},
    }),
  }
  return fake
}

const SERVICE_OK = JSON.stringify({ ok: true, cause: null, message: 'ok', health: null, detail: {} })

const exec: Runner = (bin, args, cwd) =>
  bin === 'gh'
    ? { status: 0, stdout: '' }
    : bin === SHEPHERD_BIN
      ? { status: 0, stdout: args[0] === 'service' ? SERVICE_OK : '[]' }
      : bin === 'git' && args.includes('remote') && args.includes('get-url')
        ? { status: 0, stdout: 'https://github.com/Acme/Widgets.git\n' }
        : run(bin, args, cwd)

const ledger = () => readLedger(burndownLedgerPath())
const heldClaim = (): Claim | undefined => ledger().claims.find(c => c.taskId === 'DM-1')

async function tickAt(fake: Fake, minutes: number): Promise<void> {
  freshAccount(at(minutes))
  await tickFromDisk({ dryRun: false, broker: fake.broker, now: at(minutes), exec })
}

const checkpointSends = (fake: Fake): Send[] => fake.sends.filter(s => s.to === AGENT)
const seatLines = (fake: Fake, kind: string): string[] =>
  fake.sends.filter(s => s.to === SEAT).flatMap(s => s.text.split('\n').filter(l => l.startsWith(`${kind} `)))

/** DM-1 implementing for an hour with one commit and an edit left uncommitted, its lease ended 20 min ago. */
function dirtyClaim(): Claim {
  git(repo(), 'worktree', 'add', '-q', '-b', `agent-chat/${AGENT}`, worktree())
  write(path.join(worktree(), 'src', 'a.ts'), 'one\n')
  git(worktree(), 'add', '.')
  git(worktree(), 'commit', '-q', '-m', 'start DM-1')
  write(path.join(worktree(), 'src', 'a.ts'), 'two\n')
  const head = git(worktree(), 'rev-parse', 'HEAD').trim()
  const progressAt = at(-60).getTime()
  return {
    taskId: 'DM-1',
    initiative: 'demo',
    seat: SEAT,
    namePrefix: 'st',
    agentId: `id-${AGENT}`,
    agentName: AGENT,
    spawned: [AGENT],
    worktree: worktree(),
    spawnedAt: at(-60).toISOString(),
    phase: 'implementing',
    phaseAt: at(-60).toISOString(),
    notified: ['dispatched'],
    lease: {
      progressAt: new Date(progressAt).toISOString(),
      leaseUntil: new Date(progressAt + LEASE_MS + 10 * MIN).toISOString(),
      renewals: 0,
      head,
    },
  }
}

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-checkpoint-tick-')))
  process.env.AGENT_CHAT_HOME = path.join(world, 'home')
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(world, 'aw')
  process.env.CLAUDE_PROFILE_ROOT = path.join(world, 'profiles')
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.AGENT_CHAT_STATUS_CACHE
  write(path.join(world, 'home', 'config.json'), JSON.stringify({ worktreeBudget: 10 }))
  fs.mkdirSync(repo(), { recursive: true })
  git(repo(), 'init', '-q', '-b', 'main')
  git(repo(), 'commit', '-q', '--allow-empty', '-m', 'init')
  seatWorld()
})

afterEach(() => {
  process.env = { ...saved }
  fs.rmSync(world, { recursive: true, force: true })
})

describe('a dirty, uncommitted claim (CC-663)', () => {
  beforeEach(() => writeLedger(burndownLedgerPath(), { version: 1, claims: [dirtyClaim()] }))

  it('asks its agent for one checkpoint and tells the seat nothing on that tick', async () => {
    const fake = fakeBroker()

    await tickAt(fake, 0)

    expect(heldClaim()?.finding?.code).toBe('dirty-uncommitted')
    expect(checkpointSends(fake)).toHaveLength(1)
    expect(checkpointSends(fake)[0]?.text).toContain('git commit')
    expect(checkpointSends(fake)[0]?.text).toContain('DM-1')
    expect(seatLines(fake, 'stalled-after-claim')).toEqual([])
    expect(heldClaim()?.checkpoint?.sentAt).toBe(at(0).toISOString())
  })

  // The fixture agent has no transcript, so once the commit lifts the lease CC-653's read opens its own
  // `no-progress` (silent) finding; only the dirty-uncommitted notice is this test's concern.
  it('gives no dirty-uncommitted notice when the agent commits before the next tick', async () => {
    const fake = fakeBroker()
    await tickAt(fake, 0)
    git(worktree(), 'commit', '-q', '-am', 'WIP checkpoint')

    await tickAt(fake, 10)
    await tickAt(fake, 20)

    expect(seatLines(fake, 'stalled-after-claim').filter(l => l.includes('dirty-uncommitted'))).toEqual([])
    expect(checkpointSends(fake)).toHaveLength(1)
    expect(heldClaim()?.finding?.code).not.toBe('dirty-uncommitted')
    expect(heldClaim()?.checkpoint).toBeUndefined()
  })

  it('gives one dirty-uncommitted notice when no commit comes, and nothing on a repeat tick', async () => {
    const fake = fakeBroker()

    for (const minutes of [0, 10, 20, 30]) await tickAt(fake, minutes)

    expect(checkpointSends(fake)).toHaveLength(1)
    expect(seatLines(fake, 'stalled-after-claim')).toHaveLength(1)
    expect(seatLines(fake, 'stalled-after-claim')[0]).toMatch(
      /^stalled-after-claim DM-1: dirty-uncommitted: /,
    )
    expect(seatLines(fake, 'stalled-after-claim')[0]).not.toContain('checkpoint undeliverable')
  })

  it('gives the notice with the checkpoint undeliverable after two refused sends, then sends nothing more', async () => {
    const fake = fakeBroker(2)

    await tickAt(fake, 0)
    await tickAt(fake, 10)
    const heldBack = seatLines(fake, 'stalled-after-claim')
    await tickAt(fake, 20)
    await tickAt(fake, 30)

    expect(heldBack).toEqual([])
    expect(checkpointSends(fake)).toHaveLength(2)
    expect(seatLines(fake, 'stalled-after-claim')).toHaveLength(1)
    expect(seatLines(fake, 'stalled-after-claim')[0]).toContain('checkpoint undeliverable')
  })
})

describe('a dry run over a dirty, uncommitted claim (CC-663)', () => {
  it('names the checkpoint request it would send and sends nothing', async () => {
    writeLedger(burndownLedgerPath(), { version: 1, claims: [dirtyClaim()] })
    const fake = fakeBroker()
    freshAccount(at(0))

    const lines = await tickFromDisk({ dryRun: true, broker: fake.broker, now: at(0), exec })

    expect(lines).toContain(`would ask ${AGENT} for a checkpoint of DM-1`)
    expect(lines.some(l => l.includes('stalled-after-claim'))).toBe(false)
    expect(fake.sends).toEqual([])
  })
})

describe('a claim stalled before stall codes (CC-663 slice A)', () => {
  it('loads from the ledger file and sends nothing through a tick', async () => {
    const claim = dirtyClaim()
    const { lease: _lease, ...rest } = claim
    const old = {
      ...rest,
      stalledReason: 'implementing past its timeout',
      notified: ['dispatched', 'stalled'],
    }
    writeLedger(burndownLedgerPath(), { version: 1, claims: [old] })
    const fake = fakeBroker()

    await tickAt(fake, 0)
    await tickAt(fake, 10)

    expect(fake.sends).toEqual([])
    expect(heldClaim()?.stallCode).toBeUndefined()
    expect(heldClaim()?.stalledReason).toBe('implementing past its timeout')
  })
})
