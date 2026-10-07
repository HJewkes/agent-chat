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
import type { AgentIdentity } from '../protocol.js'

/**
 * CC-660 E1 rung 1 through whole ticks, with `ladder.enabled` true: each tick
 * reads the ledger from disk, over a fixture seat world, a real git worktree
 * and a fake broker whose roster follows its own spawns and retires.
 */

let world: string
const saved = { ...process.env }
const NOON = new Date(2026, 8, 26, 12, 0)
const MIN = 60_000
const REFUSED: SpawnReply = { ok: false, reason: 'spawn failed: claude exited 1' }
const HEADLESS_LIMIT: SpawnReply = {
  ok: false,
  reason: 'machine headless limit reached',
  code: 'machine_headless_limit',
  retryable: true,
}

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })

const repo = (): string => path.join(world, 'repo')
const worktree = (): string => path.join(repo(), '.worktrees', 'st-dm-1')
const accountPath = (): string => path.join(world, 'profiles', 'agents')
const at = (minutes: number): Date => new Date(NOON.getTime() + minutes * MIN)

const TASK =
  'id: DM-1\ntitle: Do DM-1\npriority: 3\nestimate: 2\ndone_when: unit tests cover the new branch\nstatus: open\nupdated: 2026-09-20\ntags:\n  - agent-chat\n'

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

/** Seat `seat-t` (prefix `st`) on pool `pool-t`, with one implementing claim on DM-1 and no other open task. */
function seatWorld(): void {
  const root = path.join(world, 'aw', 'claude-channels', 'sources', 'autonomy')
  const pool = `pool-t: {config_dir: ${accountPath()}, human_uses: false, reserve_seven_day: 30, ceiling_five_hour: 75}`
  write(path.join(root, 'charter.md'), `---\nseats: [seat-t]\n${DEFAULTS}\npools:\n  ${pool}\n---\n`)
  write(
    path.join(root, 'seats', 'seat-t.md'),
    `---\nprefix: st\npool: pool-t\ninitiatives: {demo: 1.0}\nrepos:\n  - {path: ${repo()}, initiatives: [demo]}\nconcurrency: {implementers: 2, reviewers: 1, planners: 1}\n---\n`,
  )
  write(path.join(world, 'aw', 'demo', 'brief.md'), '---\ntitle: demo\nstate: focused\n---\n# demo\n')
  write(path.join(world, 'aw', 'demo', 'tasks', 'DM-1.yml'), TASK)
  const config = {
    enabled: true,
    reportTo: 'coord',
    maxAgents: 3,
    reserveSlots: 2,
    seats: ['seat-t'],
    ladder: { enabled: true },
  }
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
  retires: string[]
  agents: AgentIdentity[]
  sends: string[]
}

const nextReply = (replies: SpawnReply[], n: number): SpawnReply =>
  replies[Math.min(n, replies.length) - 1] ?? { ok: true }

/** A roster that follows the fake's own answers: an accepted spawn adds a live row, an accepted retire retires it. */
function fakeBroker(spawns: SpawnReply[], retires: SpawnReply[] = []): Fake {
  const fake: Fake = {
    frames: [],
    retires: [],
    agents: [row('st-dm-1', 'live', worktree())],
    sends: [],
    broker: {} as TickBroker,
  }
  fake.broker = {
    roster: async () => ({ agents: fake.agents.map(a => ({ ...a })), slots: { held: 4, cap: 36 } }),
    inboxSince: async () => [],
    spawn: async frame => {
      fake.frames.push(frame)
      const reply = nextReply(spawns, fake.frames.length)
      if (reply.ok) {
        // A name spawned again replaces its retired row, as the broker's roster does.
        fake.agents = fake.agents.filter(a => a.name !== frame.name)
        fake.agents.push(row(frame.name, 'live', worktree()))
      }
      return reply.ok ? { ok: true, agentId: `id-${frame.name}` } : reply
    },
    retire: async name => {
      fake.retires.push(name)
      const reply = nextReply(retires, fake.retires.length)
      const agent = fake.agents.find(a => a.name === name && a.state !== 'retired')
      // The real broker's byName skips retired rows, so a retired or unknown name is refused (supervisor.ts).
      if (agent === undefined) return { ok: false, reason: `no agent named "${name}"` }
      if (reply.ok) agent.state = 'retired'
      return reply
    },
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
  }
  return fake
}

const registers: string[][] = []

/** `gh` and `titan-factory` answer from stubs, with every Shepherd register recorded; `git` runs for real. */
const exec: Runner = (bin, args, cwd) => {
  if (bin === 'git' && /\b(branch -D|worktree remove|push --delete)\b/.test(args.join(' ')))
    gitWrites.push(args.join(' '))
  if (bin === SHEPHERD_BIN && args.includes('register')) registers.push(args)
  return bin === 'gh'
    ? { status: 0, stdout: '' }
    : bin === SHEPHERD_BIN
      ? { status: 0, stdout: '[]' }
      : bin === 'git' && args.includes('remote') && args.includes('get-url')
        ? { status: 0, stdout: 'https://github.com/Acme/Widgets.git\n' }
        : run(bin, args, cwd)
}

const ledger = () => readLedger(burndownLedgerPath())
const heldClaim = (): Claim | undefined => ledger().claims.find(c => c.phase !== 'done')
const names = (fake: Fake): string[] => fake.frames.map(f => f.name)
const liveAgents = (fake: Fake): string[] => fake.agents.filter(a => a.state === 'live').map(a => a.name)

const logged: { event: string; detail: Record<string, unknown> }[] = []
const gitWrites: string[] = []

/** One tick at `minutes`, returning the claim's live agents once it ends. */
async function tickAt(fake: Fake, minutes: number): Promise<string[]> {
  freshAccount(at(minutes))
  const logRow = (event: string, detail: Record<string, unknown>): void => void logged.push({ event, detail })
  await tickFromDisk({ dryRun: false, broker: fake.broker, now: at(minutes), log: logRow, exec })
  return liveAgents(fake)
}

const timedOutClaimShape = (): Claim => ({
  taskId: 'DM-1',
  initiative: 'demo',
  seat: 'seat-t',
  namePrefix: 'st',
  agentId: 'id-st-dm-1',
  agentName: 'st-dm-1',
  spawned: ['st-dm-1'],
  worktree: worktree(),
  spawnedAt: at(-300).toISOString(),
  phase: 'implementing',
  phaseAt: at(-300).toISOString(),
  notified: ['dispatched'],
})

/** DM-1 implementing for five hours (past its four-hour timeout), with a commit and an edit left in its worktree. */
function timedOutClaim(): void {
  git(repo(), 'worktree', 'add', '-q', '-b', 'agent-chat/st-dm-1', worktree())
  write(path.join(worktree(), 'src', 'a.ts'), 'one\n')
  git(worktree(), 'add', '.')
  git(worktree(), 'commit', '-q', '-m', 'start DM-1')
  write(path.join(worktree(), 'src', 'a.ts'), 'two\n')
  writeLedger(burndownLedgerPath(), { version: 1, claims: [timedOutClaimShape()] })
}

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ladder-tick-')))
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
  timedOutClaim()
  registers.length = 0
  logged.length = 0
  gitWrites.length = 0
})

afterEach(() => {
  process.env = { ...saved }
  fs.rmSync(world, { recursive: true, force: true })
})

describe('a refused rung-1 respawn (CC-660 E1)', () => {
  it.each([
    ['refused', REFUSED],
    ['retryable', HEADLESS_LIMIT],
  ])(
    'retries rung 1 after a %s spawn rather than reading the retired agent as finished',
    async (_, reply) => {
      const fake = fakeBroker([reply, { ok: true }])

      for (const minutes of [0, 10, 20, 30]) await tickAt(fake, minutes)

      expect(names(fake)).toEqual(['st-dm-1-s1', 'st-dm-1-s1'])
      expect(registers).toEqual([])
      expect(heldClaim()).toMatchObject({ phase: 'implementing', agentName: 'st-dm-1-s1', attempt: 1 })
      expect(heldClaim()?.stalledReason).toBeUndefined()
      expect(ledger().ladder?.['DM-1#']).toMatchObject({ respawns: 1 })
    },
  )

  it('counts no respawn while the successor has not spawned', async () => {
    const fake = fakeBroker([REFUSED])

    for (const minutes of [0, 10]) await tickAt(fake, minutes)

    expect(names(fake)).toEqual(['st-dm-1-s1'])
    expect(ledger().ladder?.['DM-1#']).toMatchObject({ respawns: 0 })
  })
})

const stalledSends = (fake: Fake): string[] =>
  fake.sends.flatMap(text => text.split('\n').filter(l => l.startsWith('stalled ')))

const retireBudget = (): unknown => ledger().liveness?.['DM-1#|retire:st-dm-1']

describe('a rung-1 retire against the liveness budget (CC-660 E1)', () => {
  it('parks the claim retry-spent on the third refusal, with one stalled notice and no spawn', async () => {
    const fake = fakeBroker([{ ok: true }], [{ ok: false, reason: 'worktree holds unmerged work' }])

    for (const minutes of [0, 10, 20, 30, 40]) await tickAt(fake, minutes)

    expect(fake.retires).toEqual(['st-dm-1', 'st-dm-1', 'st-dm-1'])
    expect(names(fake)).toEqual([])
    expect(heldClaim()).toMatchObject({ stallCode: 'retry-spent', stalledClass: 'failed' })
    expect(heldClaim()?.stalledReason).toContain('st-dm-1')
    expect(heldClaim()?.stalledReason).toContain(worktree())
    expect(heldClaim()?.respawn).toBeUndefined()
    expect(stalledSends(fake)).toHaveLength(1)
    expect(stalledSends(fake)[0]).toMatch(/^stalled DM-1: retry-spent: /)
  })

  it('spawns the successor after a retire refused twice is accepted, and forgets the refusals', async () => {
    const busy: SpawnReply = { ok: false, reason: 'worktree holds unmerged work' }
    const fake = fakeBroker([{ ok: true }], [busy, busy, { ok: true }])

    await tickAt(fake, 0)
    await tickAt(fake, 10)
    const spentAfterTwo = retireBudget()
    await tickAt(fake, 20)
    await tickAt(fake, 30)

    expect(spentAfterTwo).toMatchObject({ byFact: expect.any(Object) })
    expect(Object.values((spentAfterTwo as { byFact: Record<string, { n: number }> }).byFact)[0]?.n).toBe(2)
    expect(names(fake)).toEqual(['st-dm-1-s1'])
    expect(retireBudget()).toBeUndefined()
    expect(heldClaim()?.stalledReason).toBeUndefined()
  })

  it('counts no respawn when the successor spawn parks retry-spent', async () => {
    const fake = fakeBroker([REFUSED])

    for (const minutes of [0, 10, 20, 30, 40, 50]) await tickAt(fake, minutes)

    expect(names(fake)).toEqual(['st-dm-1-s1', 'st-dm-1-s1', 'st-dm-1-s1'])
    expect(heldClaim()).toMatchObject({ stallCode: 'retry-spent' })
    expect(ledger().ladder?.['DM-1#']).toMatchObject({ respawns: 0 })
  })
})

describe('a spawn that never lands (CC-660 E1)', () => {
  it('respawns once, then stalls for the owner once', async () => {
    const stuck: Claim = {
      ...(heldClaim() as Claim),
      agentId: undefined,
      phase: 'spawning',
      phaseAt: at(-30).toISOString(),
      nextPhase: 'implementing',
    }
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [stuck],
      ladder: { 'DM-1#': { respawns: 0, releases: 1, lastAt: at(-60).toISOString() } },
    })
    const fake = fakeBroker([{ ok: true }])
    fake.agents.length = 0
    fake.broker.spawn = async frame => {
      fake.frames.push(frame)
      return { ok: true, agentId: `id-${frame.name}` }
    }

    for (const minutes of [0, 10, 20, 30, 40, 50, 60]) await tickAt(fake, minutes)

    expect(names(fake)).toEqual(['st-dm-1-s1'])
    expect(heldClaim()).toMatchObject({ stallCode: 'spawn-never-landed', stalledClass: 'stalled' })
    expect(heldClaim()?.stalledReason).toMatch(/^spawn-never-landed: ladder exhausted after a respawn/)
    expect(ledger().ladder?.['DM-1#']).toMatchObject({ respawns: 1, owner: at(30).toISOString() })
  })
})

describe('a refused rung-1 retire (CC-660 E1)', () => {
  it('spawns nothing that tick, retries the retire next tick, then spawns the successor', async () => {
    const fake = fakeBroker([{ ok: true }], [{ ok: false, reason: 'agent busy' }, { ok: true }])

    await tickAt(fake, 0)
    const afterRefusal = { frames: names(fake), claim: heldClaim() }
    await tickAt(fake, 10)
    await tickAt(fake, 20)

    expect(afterRefusal.frames).toEqual([])
    expect(afterRefusal.claim?.unretired).toMatchObject([{ name: 'st-dm-1', reason: 'agent busy' }])
    expect(fake.retires).toEqual(['st-dm-1', 'st-dm-1'])
    expect(names(fake)).toEqual(['st-dm-1-s1'])
    expect(heldClaim()?.unretired).toBeUndefined()
  })

  it('never has two live agents on the claim while its retire keeps refusing', async () => {
    const fake = fakeBroker([{ ok: true }], [{ ok: false, reason: 'agent busy' }])

    const live = []
    for (const minutes of [0, 10, 20, 30]) live.push(await tickAt(fake, minutes))

    expect(live).toEqual([['st-dm-1'], ['st-dm-1'], ['st-dm-1'], ['st-dm-1']])
    expect(names(fake)).toEqual([])
  })
})

const releasedSends = (fake: Fake): string[] =>
  fake.sends.flatMap(text => text.split('\n').filter(l => l.startsWith('released ')))

describe('rung 2, release with the branch kept (CC-698)', () => {
  it('keeps the claim held and both agents live while the release retire is refused, then parks it retry-spent', async () => {
    const fake = fakeBroker([{ ok: true }])
    for (const minutes of [0, 10, 20]) await tickAt(fake, minutes)
    fake.broker.retire = async name => {
      fake.retires.push(name)
      return { ok: false, reason: 'worktree holds unmerged work' }
    }

    const afterFirst = (await tickAt(fake, 320), { claim: heldClaim(), live: liveAgents(fake) })
    for (const minutes of [330, 340]) await tickAt(fake, minutes)

    expect(afterFirst.claim).toMatchObject({
      phase: 'implementing',
      unretired: expect.arrayContaining([expect.objectContaining({ name: 'st-dm-1-s1' })]),
    })
    expect(afterFirst.live).toEqual(['st-dm-1-s1'])
    expect(ledger().releases).toBeUndefined()
    expect(heldClaim()).toMatchObject({ stallCode: 'retry-spent' })
    expect(stalledSends(fake)).toHaveLength(1)
    expect(ledger().liveness?.['DM-1#|retire:st-dm-1-s1']).toBeDefined()
  })

  it('respawns, releases, re-dispatches onto the kept branch once the backoff ends, then tells the owner once, re-reading the ledger every tick', async () => {
    const fake = fakeBroker([{ ok: true }])

    for (const minutes of [0, 10, 20]) await tickAt(fake, minutes)
    const respawned = { names: names(fake), claim: heldClaim() }
    await tickAt(fake, 320)
    const released = { claim: heldClaim(), ladder: ledger().ladder?.['DM-1#'], releases: ledger().releases }
    await tickAt(fake, 330)
    const heldBack = { names: names(fake), claim: heldClaim() }
    for (const minutes of [340, 350, 600]) await tickAt(fake, minutes)

    expect(respawned.names).toEqual(['st-dm-1-s1'])
    expect(respawned.claim).toMatchObject({ phase: 'implementing', agentName: 'st-dm-1-s1' })
    expect(released.claim).toBeUndefined()
    expect(released.ladder).toMatchObject({ respawns: 1, releases: 1, branch: 'agent-chat/st-dm-1' })
    expect(released.releases?.['DM-1']).toMatchObject({ n: 1 })
    expect(heldBack).toEqual({ names: ['st-dm-1-s1'], claim: undefined })
    expect(names(fake)).toEqual(['st-dm-1-s1', 'st-dm-1'])
    expect(fake.frames[1]?.brief).toContain('A previous attempt left branch agent-chat/st-dm-1')
    expect(heldClaim()).toMatchObject({ stallCode: expect.any(String), stalledClass: 'stalled' })
    expect(heldClaim()?.stalledReason).toMatch(/ladder exhausted after a respawn/)
    expect(stalledSends(fake)).toHaveLength(1)
    expect(ledger().ladder?.['DM-1#']).toMatchObject({ releases: 1, owner: at(600).toISOString() })
  })

  it('writes no branch deletion, worktree removal or remote branch delete, and keeps the branch', async () => {
    const fake = fakeBroker([{ ok: true }])

    for (const minutes of [0, 10, 20, 320]) await tickAt(fake, minutes)

    expect(gitWrites).toEqual([])
    expect(git(repo(), 'branch', '--list', 'agent-chat/st-dm-1')).toContain('agent-chat/st-dm-1')
    expect(fs.existsSync(worktree())).toBe(true)
  })

  it('logs burndown_release and tells the seat, both naming the branch', async () => {
    const fake = fakeBroker([{ ok: true }])

    for (const minutes of [0, 10, 20, 320]) await tickAt(fake, minutes)

    const rows = logged.filter(l => l.event === 'burndown_release')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.detail).toMatchObject({ task: 'DM-1', branch: 'agent-chat/st-dm-1', n: 1 })
    expect(releasedSends(fake)).toHaveLength(1)
    expect(releasedSends(fake)[0]).toContain('agent-chat/st-dm-1')
  })
})
