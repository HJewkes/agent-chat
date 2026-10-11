import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run, type Runner } from '../agents/burndown/exec.js'
import type { SpawnFrame, SpawnReply } from '../agents/burndown/execute.js'
import { readLedger, writeLedger, type Claim } from '../agents/burndown/ledger.js'
import { SHEPHERD_BIN } from '../agents/burndown/shepherd.js'
import { tickFromDisk, type TickBroker } from '../agents/burndown/run-tick.js'
import { TRUST_RULE_BASELINE_CLI_VERSION } from '../agents/trust.js'
import { burndownLedgerPath } from '../paths.js'
import { releaseTask } from '../cli/verbs/burndown-release.js'
import type { AgentIdentity } from '../protocol.js'

/**
 * CC-671 S2: a refused spawn spends the claim's liveness budget and is undone
 * so the next tick re-derives it; the third refusal with unchanged facts parks.
 * Each tick reads the ledger from disk, over a fixture seat world and a fake broker.
 */

let world: string
const saved = { ...process.env }
const NOON = new Date(2026, 8, 26, 12, 0)
const MIN = 60_000
const REFUSED: SpawnReply = { ok: false, reason: 'spawn failed: claude exited 1' }

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })

const repo = (): string => path.join(world, 'repo')
const accountPath = (): string => path.join(world, 'profiles', 'agents')
const taskFile = (): string => path.join(world, 'aw', 'demo', 'tasks', 'DM-1.yml')
const at = (minutes: number): Date => new Date(NOON.getTime() + minutes * MIN)

const task = ({ notes = 'first take', updated = '2026-09-20' } = {}): string =>
  `id: DM-1\ntitle: Do DM-1\npriority: 3\nestimate: 2\ndone_when: unit tests cover the new branch\nstatus: open\nnotes: ${notes}\nupdated: ${updated}\ntags:\n  - agent-chat\n`

/** The account's status cache, written as fresh at `now` so the pool gate stays open on every tick. */
function freshAccount(now: Date): void {
  const rate_limits = { seven_day: { used_percentage: 40 }, five_hour: { used_percentage: 10 } }
  write(
    path.join(accountPath(), 'status-cache', 'sessions', 's1.json'),
    JSON.stringify({ session_id: 's1', written_at: now.getTime() / 1000 - 30, rate_limits }),
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

/** Seat `seat-t` (prefix `st`) on pool `pool-t`, dispatching the focused initiative `demo` into the fixture repo. */
function seatWorld(): void {
  const root = path.join(world, 'aw', 'claude-channels', 'sources', 'autonomy')
  const pool = `pool-t: {config_dir: ${accountPath()}, human_uses: false, reserve_seven_day: 30, ceiling_five_hour: 75}`
  write(path.join(root, 'charter.md'), `---\nseats: [seat-t]\n${DEFAULTS}\npools:\n  ${pool}\n---\n`)
  write(
    path.join(root, 'seats', 'seat-t.md'),
    `---\nprefix: st\npool: pool-t\ninitiatives: {demo: 1.0}\nrepos:\n  - {path: ${repo()}, initiatives: [demo]}\nconcurrency: {implementers: 2, reviewers: 1, planners: 1}\n---\n`,
  )
  write(path.join(world, 'aw', 'demo', 'brief.md'), '---\ntitle: demo\nstate: focused\n---\n# demo\n')
  write(taskFile(), task())
  const config = { enabled: true, reportTo: 'coord', maxAgents: 3, reserveSlots: 2, seats: ['seat-t'] }
  write(path.join(world, 'home', 'burndown.config.json'), JSON.stringify(config))
}

const row = (name: string, state: AgentIdentity['state'], cwd: string): AgentIdentity => ({
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
  sends: string[]
}

/** Answers each spawn with the next reply in `replies`, the last one repeating. */
function fakeBroker(replies: SpawnReply[], agents: AgentIdentity[] = []): Fake {
  const fake: Fake = {
    frames: [],
    sends: [],
    broker: {
      roster: async () => ({ agents, slots: { held: 4, cap: 36 } }),
      inboxSince: async () => [],
      spawn: async frame => {
        fake.frames.push(frame)
        return replies[Math.min(fake.frames.length, replies.length) - 1] ?? { ok: true }
      },
      retire: async () => ({ ok: true }),
      queue: async () => [],
      resume: async name => ({ ok: true, agentId: `id-${name}` }),
      collisionView: async () => ({ names: [], claims: [] }),
      seatSender: async () => ({
        send: async (_to, text) => {
          fake.sends.push(text)
          return { ok: true }
        },
        notify: async () => ({ ok: true }),
        close: () => {},
      }),
    },
  }
  return fake
}

/** A passing `service check --json`, so the CC-785 two-read rule never stops the line here. */
const SERVICE_OK = JSON.stringify({ ok: true, cause: null, message: 'ok', health: null, detail: {} })

/** `gh` and `titan-factory` answer from stubs; `git` runs for real against the fixture repo. */
const exec: Runner = (bin, args, cwd) =>
  bin === 'gh'
    ? { status: 0, stdout: '' }
    : bin === SHEPHERD_BIN
      ? { status: 0, stdout: args[0] === 'service' ? SERVICE_OK : '[]' }
      : bin === 'git' && args.includes('remote') && args.includes('get-url')
        ? { status: 0, stdout: 'https://github.com/Acme/Widgets.git\n' }
        : run(bin, args, cwd)

async function tickAt(fake: Fake, minutes: number): Promise<void> {
  freshAccount(at(minutes))
  await tickFromDisk({ dryRun: false, broker: fake.broker, now: at(minutes), log: () => {}, exec })
}

const ledger = () => readLedger(burndownLedgerPath())
const heldClaim = (): Claim | undefined => ledger().claims.find(c => c.phase !== 'done')
const liveness = () => Object.values(ledger().liveness ?? {})
const stalledSends = (fake: Fake): string[] =>
  fake.sends.flatMap(text => text.split('\n').filter(l => l.startsWith('stalled ')))

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-liveness-tick-')))
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
  const trusted = { hasTrustDialogAccepted: true }
  write(path.join(accountPath(), '.claude.json'), JSON.stringify({ projects: { [repo()]: trusted } }))
  installClaude()
  seatWorld()
})

afterEach(() => {
  process.env = { ...saved }
  fs.rmSync(world, { recursive: true, force: true })
})

describe('burndown tick spends a refused spawn against the liveness budget (CC-671 S2)', () => {
  it('drops a refused fresh dispatch twice and parks it on the third refusal, telling the seat once', async () => {
    const fake = fakeBroker([REFUSED])

    await tickAt(fake, 0)
    const afterFirst = heldClaim()
    await tickAt(fake, 10)
    const afterSecond = heldClaim()
    const sendsBeforePark = stalledSends(fake)
    await tickAt(fake, 20)

    expect(fake.frames.map(f => f.name)).toEqual(['st-dm-1', 'st-dm-1', 'st-dm-1'])
    expect(afterFirst).toBeUndefined()
    expect(afterSecond).toBeUndefined()
    expect(sendsBeforePark).toEqual([])
    const parked = heldClaim()
    expect(parked?.stalledReason).toMatch(/^retry-spent: /)
    expect(parked).toMatchObject({ stalledClass: 'failed', stallCode: 'retry-spent' })
    expect(stalledSends(fake)).toHaveLength(1)
    expect(stalledSends(fake)[0]).toMatch(/^stalled DM-1: retry-spent: /)
  })

  it('puts a refused queued slice back in queued with its original phaseAt and no agent name', async () => {
    const queued: Claim = {
      taskId: 'DM-1',
      initiative: 'demo',
      seat: 'seat-t',
      namePrefix: 'st',
      slice: 'a',
      owns: ['src/x.ts'],
      spawnedAt: at(-60).toISOString(),
      phase: 'queued',
      phaseAt: at(-60).toISOString(),
    }
    writeLedger(burndownLedgerPath(), { version: 1, claims: [queued] })
    const fake = fakeBroker([REFUSED])

    await tickAt(fake, 0)

    expect(fake.frames.map(f => f.name)).toEqual(['st-dm-1-a'])
    expect(ledger().claims).toEqual([queued])
  })

  it('reverts a refused successor so each retry sends the same successor name and parks on the third', async () => {
    const worktree = path.join(repo(), '.worktrees', 'st-dm-1')
    git(repo(), 'worktree', 'add', '-q', '-b', 'agent-chat/st-dm-1', worktree)
    const reviewing: Claim = {
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
    writeLedger(burndownLedgerPath(), { version: 1, claims: [reviewing] })
    const fake = fakeBroker([REFUSED], [row('st-dm-1-r0', 'exited', worktree)])

    await tickAt(fake, 0)
    const afterFirst = heldClaim()
    await tickAt(fake, 10)
    await tickAt(fake, 20)

    expect(afterFirst).toEqual(reviewing)
    expect(fake.frames.map(f => f.name)).toEqual(['st-dm-1-s1', 'st-dm-1-s1', 'st-dm-1-s1'])
    expect(heldClaim()).toMatchObject({ stallCode: 'retry-spent', attempt: 1 })
  })

  it('restarts the count when the task notes change before the third refusal', async () => {
    const fake = fakeBroker([REFUSED])

    await tickAt(fake, 0)
    await tickAt(fake, 10)
    write(taskFile(), task({ notes: 'second take with the cause fixed' }))
    await tickAt(fake, 20)

    expect(fake.frames).toHaveLength(3)
    expect(heldClaim()).toBeUndefined()
    expect(liveness().flatMap(r => Object.values(r.byFact).map(f => f.n))).toEqual([2, 1])
  })

  it('parks on the third refusal when only the task updated: line changed', async () => {
    const fake = fakeBroker([REFUSED])

    await tickAt(fake, 0)
    await tickAt(fake, 10)
    write(taskFile(), task({ updated: '2026-09-26' }))
    await tickAt(fake, 20)

    expect(heldClaim()).toMatchObject({ stallCode: 'retry-spent' })
  })

  it('waits on a retryable refusal for three ticks without spending or stalling', async () => {
    const fake = fakeBroker([
      { ok: false, code: 'machine_headless_limit', retryable: true, reason: 'too many headless agents' },
    ])

    await tickAt(fake, 0)
    await tickAt(fake, 10)
    await tickAt(fake, 20)

    expect(fake.frames).toHaveLength(3)
    expect(ledger().liveness ?? {}).toEqual({})
    expect(heldClaim()).toBeUndefined()
    expect(stalledSends(fake)).toEqual([])
  })

  it('parks on the first refusal after a release and re-dispatch with the same facts', async () => {
    const fake = fakeBroker([REFUSED])
    await tickAt(fake, 0)
    await tickAt(fake, 10)
    await tickAt(fake, 20)
    await releaseTask('DM-1', async () => ({ ok: true }), at(21))

    await tickAt(fake, 40)

    expect(fake.frames).toHaveLength(4)
    expect(heldClaim()).toMatchObject({ agentName: 'st-dm-1', stallCode: 'retry-spent' })
  })

  it('clears the record on a success, so a later refusal counts from one', async () => {
    const fake = fakeBroker([REFUSED, REFUSED, { ok: true, agentId: 'a-1' }, REFUSED])
    await tickAt(fake, 0)
    await tickAt(fake, 10)
    await tickAt(fake, 20)
    const afterSuccess = liveness()
    await releaseTask('DM-1', async () => ({ ok: true }), at(21))

    await tickAt(fake, 40)

    expect(afterSuccess).toEqual([])
    expect(heldClaim()).toBeUndefined()
    expect(liveness().flatMap(r => Object.values(r.byFact).map(f => f.n))).toEqual([1])
  })
})
