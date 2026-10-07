import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrokerView } from '../agents/burndown/collision.js'
import { run, type Runner } from '../agents/burndown/exec.js'
import { execute, spawnFrame, type SpawnFrame, type SpawnReply } from '../agents/burndown/execute.js'
import { readLedger, writeLedger, type Claim } from '../agents/burndown/ledger.js'
import { SHEPHERD_BIN } from '../agents/burndown/shepherd.js'
import { tickFromDisk, type TickBroker } from '../agents/burndown/run-tick.js'
import { renderPlan, renderStatus, seatPlanFromDisk } from '../agents/burndown/tick.js'
import { TRUST_RULE_BASELINE_CLI_VERSION } from '../agents/trust.js'
import { transcriptPath } from '../agents/transcript.js'
import { burndownLedgerPath, burndownPausePath, configPath } from '../paths.js'
import { tickBroker } from '../cli/burndown-broker.js'
import type { BrokerClient } from '../client/broker-client.js'
import type { AgentIdentity, QueueItem } from '../protocol.js'
import { writePoolCharter } from './helpers/pool-charter.js'

/**
 * `burndown tick` over a fixture world: a real git repo, an active-work root,
 * one account's status cache and trust file, and a fake broker that records
 * every frame. Nothing here reaches the live broker or the developer's files.
 */

let world: string
const saved = { ...process.env }
const NOON = new Date(2026, 8, 26, 12, 0)

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })

const repo = (): string => path.join(world, 'repo')
const accountPath = (): string => path.join(world, 'profiles', 'agents')

const task = (id: string, priority = 3): string =>
  `id: ${id}\ntitle: Do ${id}\npriority: ${priority}\nestimate: 1\ndone_when: unit tests cover the new branch\nstatus: open\ntags:\n  - agent-chat\n`

function initiative(
  tasks: Record<string, string>,
  { slug = 'demo', at = repo(), lanes = 1, rank = 1 } = {},
): void {
  const autonomy = `autonomy:\n  mode: burndown\n  lanes: ${lanes}\n  accounts: [agents]\n  grants: []\n  repo: ${at}\n`
  write(
    path.join(world, 'aw', slug, 'brief.md'),
    `---\ntitle: ${slug}\nstate: focused\nrank: ${rank}\nprofile: agents\n${autonomy}---\n# ${slug}\n`,
  )
  for (const [id, text] of Object.entries(tasks))
    write(path.join(world, 'aw', slug, 'tasks', `${id}.yml`), text)
}

/** A second repo with its own bare origin, for checks that must stay scoped to one repo. */
function secondRepo(): string {
  const at = path.join(world, 'repo2')
  fs.mkdirSync(at, { recursive: true })
  git(at, 'init', '-q', '-b', 'main')
  git(at, 'commit', '-q', '--allow-empty', '-m', 'init')
  git(world, 'init', '-q', '--bare', '-b', 'main', 'origin2.git')
  git(at, 'remote', 'add', 'origin', path.join(world, 'origin2.git'))
  git(at, 'push', '-q', 'origin', 'main')
  return at
}

function account(): void {
  const rate_limits = { seven_day: { used_percentage: 40 }, five_hour: { used_percentage: 10 } }
  write(
    path.join(accountPath(), 'status-cache', 'sessions', 's1.json'),
    JSON.stringify({ session_id: 's1', written_at: NOON.getTime() / 1000 - 30, rate_limits }),
  )
  const trusted = { hasTrustDialogAccepted: true }
  const projects = { [repo()]: trusted, [path.join(world, 'repo2')]: trusted }
  write(path.join(accountPath(), '.claude.json'), JSON.stringify({ projects }))
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

function config(extra: Record<string, unknown> = {}): void {
  const base = { enabled: true, reportTo: 'coord', maxAgents: 3, reserveSlots: 2 }
  write(path.join(world, 'home', 'burndown.config.json'), JSON.stringify({ ...base, ...extra }))
}

const row = (name: string, state: AgentIdentity['state'], cwd = repo()): AgentIdentity => ({
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

const shepherdRow = (phase: string) => ({
  repo: 'demo/repo',
  pr: 5,
  branch: 'agent-chat/bd-dm-1',
  runId: 'run-5',
  task: 'demo/DM-1',
  phase,
  headSha: 'h5',
  phaseSince: NOON.toISOString(),
  nextAction: 'none',
  pendingGate: null,
  held: null,
  stalled: null,
})

interface Fake {
  broker: TickBroker
  frames: SpawnFrame[]
  rosterCalls: number
  resumes: { name: string; message: string }[]
  retires: string[]
  sends: { to: string; text: string }[]
  notices: string[]
  senders: { opened: number; closed: number }
}

function fakeBroker(
  opts: {
    agents?: AgentIdentity[]
    slots?: { held: number; cap: number }
    spawn?: (frame: SpawnFrame) => SpawnReply
    queue?: QueueItem[]
    resume?: (name: string) => SpawnReply
    retire?: (name: string) => SpawnReply
    view?: () => BrokerView
    sendAs?: (to: string) => SpawnReply
  } = {},
): Fake {
  const fake: Fake = {
    frames: [],
    rosterCalls: 0,
    resumes: [],
    retires: [],
    sends: [],
    notices: [],
    senders: { opened: 0, closed: 0 },
    broker: {
      roster: async () => {
        fake.rosterCalls += 1
        return { agents: opts.agents ?? [], slots: opts.slots ?? { held: 4, cap: 36 } }
      },
      inboxSince: async () => [],
      spawn: async frame => {
        fake.frames.push(frame)
        return opts.spawn?.(frame) ?? { ok: true, agentId: `id-${frame.name}` }
      },
      retire: async name => {
        fake.retires.push(name)
        return opts.retire?.(name) ?? { ok: true }
      },
      queue: async () => opts.queue ?? [],
      resume: async (name, message) => {
        fake.resumes.push({ name, message })
        return opts.resume?.(name) ?? { ok: true, agentId: `id-${name}` }
      },
      collisionView: async () => opts.view?.() ?? { names: [], claims: [] },
      seatSender: async () => {
        fake.senders.opened += 1
        return {
          send: async (to, text) => {
            fake.sends.push({ to, text })
            return opts.sendAs?.(to) ?? { ok: true }
          },
          notify: async text => {
            fake.notices.push(text)
            return { ok: true }
          },
          close: () => {
            fake.senders.closed += 1
          },
        }
      },
    },
  }
  return fake
}

type Answer = { status: number; stdout: string; stderr?: string }

/** `gh` and `titan-factory` answer per call from stubs, so no test reaches GitHub or Shepherd; `git` runs for real against the fixture repo and its bare origin. */
const stubGh =
  (
    gh: (args: string[], cwd?: string) => Answer = () => ({ status: 0, stdout: '' }),
    factory: (args: string[]) => Answer = () => ({ status: 0, stdout: '[]' }),
  ): Runner =>
  (bin, args, cwd) =>
    bin === 'gh'
      ? gh(args, cwd)
      : bin === SHEPHERD_BIN
        ? factory(args)
        : isOriginLookup(bin, args)
          ? { status: 0, stdout: 'https://github.com/Acme/Widgets.git\n' }
          : run(bin, args, cwd)

/** The downstream WIP read asks the fixture checkout for its origin, which is a local bare repo; the stub names a GitHub one. */
const isOriginLookup = (bin: string, args: string[]): boolean =>
  bin === 'git' && args.includes('remote') && args.includes('get-url')

const tick = (
  fake: Fake,
  dryRun = false,
  log: (e: string, d: Record<string, unknown>) => void = () => {},
  exec: Runner = stubGh(),
) => tickFromDisk({ dryRun, broker: fake.broker, now: NOON, log, exec })

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-tick-')))
  process.env.AGENT_CHAT_HOME = path.join(world, 'home')
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(world, 'aw')
  process.env.CLAUDE_PROFILE_ROOT = path.join(world, 'profiles')
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.AGENT_CHAT_STATUS_CACHE
  // CC-801: the gate reads the charter's pools; these are the numbers the retired default rules held.
  writePoolCharter(path.join(world, 'aw', 'claude-channels', 'sources', 'autonomy'), {
    agents: {
      config_dir: path.join(world, 'profiles', 'agents'),
      human_uses: true,
      reserve_seven_day: 25,
      ceiling_five_hour: 70,
    },
  })
  write(path.join(world, 'home', 'config.json'), JSON.stringify({ worktreeBudget: 10 }))
  fs.mkdirSync(repo(), { recursive: true })
  git(repo(), 'init', '-q', '-b', 'main')
  git(repo(), 'commit', '-q', '--allow-empty', '-m', 'init')
  git(world, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
  git(repo(), 'remote', 'add', 'origin', path.join(world, 'origin.git'))
  git(repo(), 'push', '-q', 'origin', 'main')
  installClaude()
  account()
  config()
})

afterEach(() => {
  process.env = { ...saved }
  fs.rmSync(world, { recursive: true, force: true })
})

describe('burndown tick spawns', () => {
  it('sends configDir for the chosen account even when CLAUDE_CONFIG_DIR is unset, headless', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const fake = fakeBroker()

    await tick(fake)

    expect(fake.frames).toEqual([
      expect.objectContaining({
        t: 'spawn',
        name: 'bd-dm-1',
        profile: 'bd-implementer-lite',
        cwd: repo(),
        configDir: accountPath(),
        surface: 'headless',
        briefing: 'demo',
        tags: ['burndown', 'task:DM-1'],
      }),
    ])
    expect(fake.frames[0]?.brief).toContain('`chat_send` to coord')
  })

  it('records the claim in spawning and logs the intent before the frame is sent', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const logged: string[] = []
    let seenAtSend: Claim | undefined
    let loggedAtSend: string[] = []
    const fake = fakeBroker({
      spawn: () => {
        seenAtSend = readLedger(burndownLedgerPath()).claims[0]
        loggedAtSend = [...logged]
        return { ok: true, agentId: 'a-1' }
      },
    })

    await tick(fake, false, event => logged.push(event))

    expect(seenAtSend).toMatchObject({ taskId: 'DM-1', phase: 'spawning', agentName: 'bd-dm-1' })
    expect(loggedAtSend).toEqual(['burndown_spawn_intent'])
    const after = readLedger(burndownLedgerPath())
    expect(after.claims[0]).toMatchObject({
      agentId: 'a-1',
      worktree: path.join(repo(), '.worktrees', 'bd-dm-1'),
    })
    expect(after.lastTickAt).toBe(NOON.toISOString())
  })

  it("marks its spawn frame as burndown's, so the dispatch row does not record the human (CC-802)", () => {
    const frame = spawnFrame({
      name: 'bd-x',
      profile: 'bd-implementer',
      brief: 'b',
      cwd: repo(),
      configDir: accountPath(),
      initiative: 'demo',
      taskId: 'X',
    })

    expect(frame.spawnedAs).toBe('burndown')
  })

  it('refuses to send a spawn whose claim was never recorded', async () => {
    const frames: SpawnFrame[] = []
    const frame = spawnFrame({
      name: 'bd-x',
      profile: 'bd-implementer',
      brief: 'b',
      cwd: repo(),
      configDir: accountPath(),
      initiative: 'demo',
      taskId: 'X',
    })

    const result = await execute(
      [{ kind: 'spawn', key: { taskId: 'X' }, frame }],
      { version: 1, claims: [] },
      {
        ledgerFile: burndownLedgerPath(),
        spawn: async f => (frames.push(f), { ok: true }),
        retire: async () => ({ ok: true }),
        register: () => ({ ok: true }),
        log: () => {},
        now: NOON,
      },
    )

    expect(frames).toEqual([])
    expect(result.lines[0]).toContain('no spawning claim recorded')
  })

  it('parks the claim on the third failed spawn and names the leftover worktree', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const fake = fakeBroker({ spawn: () => ({ ok: false, reason: 'spawn failed: claude exited 1' }) })

    await tick(fake)
    await tick(fake)
    await tick(fake)

    const claim = readLedger(burndownLedgerPath()).claims[0]
    expect(claim?.stallCode).toBe('retry-spent')
    expect(claim?.stalledReason).toContain(`${repo()}/.worktrees/bd-dm-1 may be left behind`)
  })
})

/** TP-469: Shepherd owns CI, review and merge; the tick registers a finished worker's PR and reads Shepherd's status. */
describe('burndown tick hands a finished PR to Shepherd', () => {
  const PR = 'https://github.com/demo/repo/pull/5'
  const REGISTER = [
    'shepherd',
    'register',
    'demo/repo#5',
    '--task',
    'demo/DM-1',
    '--implementer',
    'bd-dm-1',
    '--json',
  ]

  function finishedWorker(): Fake {
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [
        {
          taskId: 'DM-1',
          initiative: 'demo',
          agentId: 'id-bd-dm-1',
          agentName: 'bd-dm-1',
          spawned: ['bd-dm-1'],
          spawnedAt: NOON.toISOString(),
          phase: 'implementing',
          phaseAt: NOON.toISOString(),
        },
      ],
    })
    const worker = { ...row('bd-dm-1', 'exited'), sessionId: 'sess-dm-1' }
    const file = transcriptPath(worker.cwd, worker.sessionId, worker.configDir)
    const text = `Status: DONE\nPR: ${PR}\nHead: h5`
    write(file, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`)
    return fakeBroker({ agents: [worker] })
  }

  /** Shepherd as the CLI answers it: `status` lists what `register` has enrolled. */
  function shepherd(register: () => Answer = () => ({ status: 0, stdout: '{}' })) {
    const calls: string[][] = []
    let enrolled = false
    const factory = (args: string[]): Answer => {
      calls.push(args)
      if (args[1] === 'status')
        return { status: 0, stdout: JSON.stringify(enrolled ? [shepherdRow('ci')] : []) }
      const answer = register()
      enrolled ||= answer.status === 0
      return answer
    }
    return { calls, factory, registers: () => calls.filter(c => c[1] === 'register') }
  }

  it('registers once across two ticks and never asks gh for the PR', async () => {
    const fake = finishedWorker()
    const factory = shepherd()
    const seen: string[][] = []
    const stub = stubGh(undefined, factory.factory)
    const exec: Runner = (bin, args, cwd) => (seen.push([bin, ...args]), stub(bin, args, cwd))

    const first = await tick(fake, false, () => {}, exec)
    await tick(fake, false, () => {}, exec)

    expect(factory.registers()).toEqual([REGISTER])
    expect(first.join('\n')).toContain('registered demo/repo#5 with Shepherd for DM-1#')
    expect(readLedger(burndownLedgerPath()).claims[0]).toMatchObject({ phase: 'shepherding', pr: PR })
    expect(seen.filter(([bin, ...args]) => bin === 'gh' && args[0] === 'pr' && args[1] === 'view')).toEqual(
      [],
    )
    expect(seen.filter(argv => argv.includes('graphql'))).toEqual([])
  })

  it('stalls the claim for the owner when Shepherd refuses the repo three times, and does not ask again', async () => {
    const fake = finishedWorker()
    const refused = 'Error: registration refused: demo/repo is in denyRepos'
    const factory = shepherd(() => ({ status: 65, stdout: '', stderr: `${refused}\n` }))

    for (let i = 0; i < 4; i++) await tick(fake, false, () => {}, stubGh(undefined, factory.factory))

    expect(factory.registers()).toHaveLength(3)
    expect(readLedger(burndownLedgerPath()).claims[0]?.stalledReason).toBe(
      `retry-spent: Shepherd refused demo/repo#5 3 times with unchanged facts (${refused}); burndown does not merge, so the PR is left for the owner`,
    )
    expect(readLedger(burndownLedgerPath()).claims[0]?.stalledClass).toBe('gate-trip')
  })

  it('registers again next tick after Shepherd was down, and reads nothing while its status cannot be read', async () => {
    const fake = finishedWorker()
    let up = false
    const factory = shepherd(() => (up ? { status: 0, stdout: '{}' } : { status: 69, stdout: '' }))
    const down = (args: string[]): Answer =>
      args[1] === 'status' ? { status: 1, stdout: '' } : factory.factory(args)

    const failed = await tick(fake, false, () => {}, stubGh(undefined, factory.factory))
    const unread = await tick(fake, false, () => {}, stubGh(undefined, down))
    up = true
    await tick(fake, false, () => {}, stubGh(undefined, factory.factory))

    expect(failed.join('\n')).toContain(
      'register demo/repo#5 with Shepherd failed (exit 69); retried next tick',
    )
    expect(unread.join('\n')).toContain(`unread DM-1#: could not read Shepherd's status for ${PR}`)
    expect(factory.registers()).toEqual([REGISTER, REGISTER])
    expect(readLedger(burndownLedgerPath()).claims[0]).toMatchObject({ phase: 'shepherding' })
    expect(readLedger(burndownLedgerPath()).claims[0]?.stalledReason).toBeUndefined()
  })
})

/** CC-182: a retire refused after the claim is done must stay visible and be tried again. */
describe('burndown tick retires refused after a claim is done', () => {
  const doneClaim = (extra: Partial<Claim> = {}): Claim => ({
    taskId: 'DM-1',
    initiative: 'demo',
    spawnedAt: NOON.toISOString(),
    phase: 'done',
    phaseAt: NOON.toISOString(),
    spawned: ['bd-dm-1', 'bd-dm-1-s1'],
    ...extra,
  })
  const TENANCY = 'bd-dm-1 allocated the worktree, and heir (not retired) is working in it'
  const REFUSED = NOON.toISOString()

  it('records the refused name on the done claim and says it will retry', async () => {
    const retired: string[] = []
    const result = await execute(
      [{ kind: 'retire', key: { taskId: 'DM-1' }, names: ['bd-dm-1-s1', 'bd-dm-1'] }],
      { version: 1, claims: [doneClaim()] },
      {
        ledgerFile: burndownLedgerPath(),
        spawn: async () => ({ ok: true }),
        retire: async name =>
          name === 'bd-dm-1' ? { ok: false, reason: TENANCY } : (retired.push(name), { ok: true }),
        register: () => ({ ok: true }),
        log: () => {},
        now: NOON,
      },
    )

    expect(retired).toEqual(['bd-dm-1-s1'])
    expect(result.lines).toContain(`left bd-dm-1: ${TENANCY}; recorded on DM-1#, retried next tick`)
    expect(readLedger(burndownLedgerPath()).claims[0]?.unretired).toEqual([
      { name: 'bd-dm-1', reason: TENANCY, at: REFUSED },
    ])
  })

  it('retries it on the next tick and clears it once the retire succeeds', async () => {
    initiative({})
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [doneClaim({ unretired: [{ name: 'bd-dm-1', reason: TENANCY, at: REFUSED }] })],
    })
    const fake = fakeBroker({ agents: [row('bd-dm-1', 'exited')] })

    const lines = await tick(fake)

    expect(fake.retires).toEqual(['bd-dm-1'])
    expect(lines).toContain('retired bd-dm-1')
    expect(readLedger(burndownLedgerPath()).claims[0]?.unretired).toBeUndefined()
  })

  it('keeps it recorded while the retire still refuses', async () => {
    initiative({})
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [doneClaim({ unretired: [{ name: 'bd-dm-1', reason: TENANCY, at: REFUSED }] })],
    })
    const fake = fakeBroker({
      agents: [row('bd-dm-1', 'exited')],
      retire: () => ({ ok: false, reason: TENANCY }),
    })

    await tick(fake)

    expect(fake.retires).toEqual(['bd-dm-1'])
    expect(readLedger(burndownLedgerPath()).claims[0]?.unretired).toEqual([
      { name: 'bd-dm-1', reason: TENANCY, at: REFUSED },
    ])
  })

  it('shows the unretired agent in burndown status', () => {
    const ledger = {
      version: 1 as const,
      claims: [doneClaim({ unretired: [{ name: 'bd-dm-1', reason: TENANCY, at: REFUSED }] })],
    }

    const lines = renderStatus(ledger, NOON)

    expect(lines).toContain(`DM-1 (demo) done, UNRETIRED bd-dm-1: ${TENANCY}`)
  })

  it('shows the unretired agent of a claim mid-respawn in burndown status', () => {
    const marked = doneClaim({
      phase: 'implementing',
      respawn: { code: 'phase-timeout', occurrence: NOON.toISOString() },
      unretired: [{ name: 'bd-dm-1', reason: TENANCY, at: REFUSED }],
    })

    const lines = renderStatus({ version: 1, claims: [marked] }, NOON)

    expect(lines).toContain(`DM-1 (demo) respawning, UNRETIRED bd-dm-1: ${TENANCY}`)
  })

  it('retries in the recorded order, so a successor still goes before its predecessor', async () => {
    initiative({})
    const unretired = ['bd-dm-1-s1', 'bd-dm-1'].map(name => ({ name, reason: TENANCY, at: REFUSED }))
    writeLedger(burndownLedgerPath(), { version: 1, claims: [doneClaim({ unretired })] })
    const fake = fakeBroker({ agents: [row('bd-dm-1-s1', 'exited'), row('bd-dm-1', 'exited')] })

    await tick(fake)

    expect(fake.retires).toEqual(['bd-dm-1-s1', 'bd-dm-1'])
  })

  it('does not retire a hand-spawned agent that took the name after the refusal', async () => {
    initiative({})
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [doneClaim({ unretired: [{ name: 'bd-dm-1', reason: TENANCY, at: REFUSED }] })],
    })
    const newer = { ...row('bd-dm-1', 'live'), agentId: 'id-hand', spawnedAt: NOON.getTime() + 60_000 }
    const fake = fakeBroker({ agents: [newer] })

    await tick(fake)

    expect(fake.retires).toEqual([])
    expect(readLedger(burndownLedgerPath()).claims[0]?.unretired).toBeUndefined()
  })

  /** A pre-CC-185 entry has no refusal time, so only the held-claim check stands between it and a reused name. */
  it('does not retire a name a held claim reused, even without a refusal time', async () => {
    initiative({})
    const rerun: Claim = {
      ...doneClaim({ phase: 'implementing', agentName: 'bd-dm-1', spawned: ['bd-dm-1'] }),
      agentId: 'id-bd-dm-1',
    }
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [doneClaim({ unretired: [{ name: 'bd-dm-1', reason: TENANCY }] }), rerun],
    })
    const fake = fakeBroker({ agents: [row('bd-dm-1', 'live')] })

    await tick(fake)

    expect(fake.retires).toEqual([])
    expect(readLedger(burndownLedgerPath()).claims[0]?.unretired).toBeUndefined()
  })

  it('skips a name whose refusal time cannot be read rather than risk retiring a reused name', async () => {
    initiative({})
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [doneClaim({ unretired: [{ name: 'bd-dm-1', reason: TENANCY, at: 'not-a-date' }] })],
    })
    const fake = fakeBroker({ agents: [row('bd-dm-1', 'exited')] })

    await tick(fake)

    expect(fake.retires).toEqual([])
  })

  it('drops a name retired by hand without retiring anything', async () => {
    initiative({})
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [doneClaim({ unretired: [{ name: 'bd-dm-1', reason: TENANCY, at: REFUSED }] })],
    })
    const fake = fakeBroker({ agents: [row('bd-dm-1', 'retired')] })

    await tick(fake)

    expect(fake.retires).toEqual([])
    expect(readLedger(burndownLedgerPath()).claims[0]?.unretired).toBeUndefined()
  })
})

describe('burndown tick ceilings', () => {
  it('refuses with kind slots when the broker has no free slot beyond the reserve', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const fake = fakeBroker({ slots: { held: 34, cap: 36 } })

    const lines = await tick(fake)

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('refused demo DM-1 [slots]')
  })

  it('counts live burndown agents against maxAgents', async () => {
    config({ maxAgents: 1 })
    initiative({ 'DM-1': task('DM-1') })
    const done: Claim = {
      taskId: 'OLD',
      initiative: 'other',
      spawnedAt: NOON.toISOString(),
      phase: 'done',
      phaseAt: NOON.toISOString(),
      spawned: ['bd-old'],
    }
    writeLedger(burndownLedgerPath(), { version: 1, claims: [done] })
    const fake = fakeBroker({ agents: [row('bd-old', 'live')] })

    const lines = await tick(fake)

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('1 of maxAgents 1 burndown agents alive')
  })

  it('refuses with kind worktrees at 7 of a budget of 10 with a reserve of 3', async () => {
    initiative({ 'DM-1': task('DM-1') })
    for (let i = 0; i < 7; i++)
      git(repo(), 'worktree', 'add', '-q', '-b', `w${i}`, path.join('.worktrees', `w${i}`))
    const fake = fakeBroker()

    const lines = await tick(fake)

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('refused demo DM-1 [worktrees]: 7 worktrees')
  })

  it('reports a branch left by a failed spawn and dispatches the next task instead', async () => {
    initiative({ 'DM-1': task('DM-1', 1), 'DM-2': task('DM-2', 2) })
    git(repo(), 'branch', 'agent-chat/bd-dm-1')
    const fake = fakeBroker()

    const lines = await tick(fake)

    expect(lines.join('\n')).toContain('refused demo DM-1 [orphan]: branch agent-chat/bd-dm-1')
    expect(fake.frames.map(f => f.name)).toEqual(['bd-dm-2'])
  })
})

/** CC-661: the release count survives a restart because it lives in the ledger file. */
describe('burndown tick release backoff', () => {
  const MINUTE = 60_000
  const releasedAt = (minutesAgo: number): string =>
    new Date(NOON.getTime() - minutesAgo * MINUTE).toISOString()

  it('refuses a task released three times inside its hold and dispatches another task', async () => {
    initiative({ 'DM-1': task('DM-1', 1), 'DM-2': task('DM-2', 2) })
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [],
      releases: { 'DM-1': { n: 3, at: releasedAt(30) } },
    })
    const fake = fakeBroker()

    const lines = await tick(fake)

    const until = new Date(NOON.getTime() + 30 * MINUTE).toISOString()
    expect(lines.join('\n')).toContain(`refused demo DM-1 [backoff]: released 3 times; held until ${until}`)
    expect(fake.frames.map(f => f.name)).toEqual(['bd-dm-2'])
    expect(readLedger(burndownLedgerPath()).releases).toEqual({ 'DM-1': { n: 3, at: releasedAt(30) } })
  })

  it('dispatches the task once its hold has passed', async () => {
    initiative({ 'DM-1': task('DM-1') })
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [],
      releases: { 'DM-1': { n: 3, at: releasedAt(61) } },
    })
    const fake = fakeBroker()

    await tick(fake)

    expect(fake.frames.map(f => f.name)).toEqual(['bd-dm-1'])
  })
})

describe('burndown tick gates', () => {
  it('does nothing while another tick holds the lock', async () => {
    initiative({ 'DM-1': task('DM-1') })
    write(`${burndownLedgerPath()}.lock`, `${process.pid}\n`)
    const fake = fakeBroker()

    const lines = await tick(fake)

    expect(lines.join('\n')).toContain('another tick holds the ledger lock')
    expect(fake.rosterCalls).toBe(0)
    expect(fs.existsSync(burndownLedgerPath())).toBe(false)
  })

  it('does nothing when disabled, paused, or without a reportTo', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const fake = fakeBroker()

    config({ enabled: false })
    expect((await tick(fake))[0]).toContain('disabled')
    config({ reportTo: undefined })
    expect((await tick(fake))[0]).toContain('no reportTo')
    config()
    write(burndownPausePath(), 'now')
    expect((await tick(fake))[0]).toContain('paused')

    expect(fake.rosterCalls).toBe(0)
  })

  it('dry run prints the spawn and writes and sends nothing', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const fake = fakeBroker()

    const lines = await tick(fake, true)

    expect(lines.join('\n')).toContain(
      `would spawn bd-dm-1 as bd-implementer-lite (headless) on ${accountPath()}`,
    )
    expect(fake.frames).toEqual([])
    expect(fs.existsSync(burndownLedgerPath())).toBe(false)
  })

  it('pins the dry-run output of a tick with no seats configured', async () => {
    // The brief names the fixture repo twice, so its length moves with the temp dir.
    const BRIEF_CHARS_BESIDE_PATHS = 1918
    initiative({ 'DM-1': task('DM-1', 1), 'DM-2': task('DM-2', 2), 'DM-3': 'id: DM-3\nstatus: open\n' })
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [
        {
          taskId: 'DM-2',
          initiative: 'demo',
          spawnedAt: NOON.toISOString(),
          phase: 'parked',
          phaseAt: NOON.toISOString(),
        },
      ],
    })

    const lines = await tick(fakeBroker(), true)

    expect(lines).toEqual([
      `burndown tick at ${NOON.toISOString()} (dry run)`,
      `would record add DM-1`,
      `would spawn bd-dm-1 as bd-implementer-lite (headless) on ${accountPath()} in ${repo()}; brief ${BRIEF_CHARS_BESIDE_PATHS + 2 * world.length} chars`,
      'refused demo DM-2 [claimed]: held in the burndown claim ledger',
      'refused demo DM-3 [no-done-when]: no done_when, so no return contract',
    ])
  })
})

describe('burndown tick advances claims', () => {
  it('spawns a reviewer in the worktree of an implementer that exited with commits', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const worktree = path.join(repo(), '.worktrees', 'bd-dm-1')
    git(repo(), 'worktree', 'add', '-q', '-b', 'agent-chat/bd-dm-1', worktree)
    git(worktree, 'commit', '-q', '--allow-empty', '-m', 'work')
    const claim: Claim = {
      taskId: 'DM-1',
      initiative: 'demo',
      spawnedAt: NOON.toISOString(),
      phase: 'implementing',
      phaseAt: NOON.toISOString(),
      agentName: 'bd-dm-1',
      spawned: ['bd-dm-1'],
      worktree,
    }
    writeLedger(burndownLedgerPath(), { version: 1, claims: [claim] })
    const fake = fakeBroker({ agents: [row('bd-dm-1', 'exited', worktree)] })

    await tick(fake)

    expect(fake.frames).toEqual([
      expect.objectContaining({
        name: 'bd-dm-1-r0',
        profile: 'bd-reviewer',
        cwd: worktree,
        configDir: accountPath(),
      }),
    ])
    expect(readLedger(burndownLedgerPath()).claims[0]).toMatchObject({
      phase: 'spawning',
      nextPhase: 'reviewing',
    })
  })
})

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

/** A synthetic charter with seat `seat-t` (prefix `st`) on pool `pool-t`, whose config dir is the fixture account. */
function seatPolicy({
  implementers = 2,
  extraSeats = '',
  poolExtra = '',
  extraRepo = '',
  grants = '',
  hub = '',
} = {}): void {
  const root = path.join(world, 'aw', 'claude-channels', 'sources', 'autonomy')
  const pool = `pool-t: {config_dir: ${accountPath()}, human_uses: false, reserve_seven_day: 30, ceiling_five_hour: 75${poolExtra}}`
  write(
    path.join(root, 'charter.md'),
    `---\nseats: [seat-t, seat-e${extraSeats}]\n${hub === '' ? '' : `hub: ${hub}\n`}${DEFAULTS}\npools:\n  ${pool}\n---\n`,
  )
  const concurrency = `concurrency: {implementers: ${implementers}, reviewers: 1, planners: 1}`
  const more = extraRepo === '' ? '' : `\n  - {path: ${extraRepo}, initiatives: [demo]}`
  const granted = grants === '' ? '' : `\ngrants_extra: [${grants}]`
  const role = hub === 'seat-t' ? 'role: coordinator\n' : ''
  write(
    path.join(root, 'seats', 'seat-t.md'),
    `---\n${role}prefix: st\npool: pool-t\ninitiatives: {demo: 1.0}\nrepos:\n  - {path: ${repo()}, initiatives: [demo]}${more}\n${concurrency}${granted}\n---\n`,
  )
  write(path.join(root, 'seats', 'seat-e.md'), '---\nprefix: se\npool: pool-t\n---\n')
}

/** A focused initiative with no autonomy block, which only seats mode dispatches from. */
function seatInitiative(tasks: Record<string, string>): void {
  write(path.join(world, 'aw', 'demo', 'brief.md'), '---\ntitle: demo\nstate: focused\n---\n# demo\n')
  for (const [id, text] of Object.entries(tasks))
    write(path.join(world, 'aw', 'demo', 'tasks', `${id}.yml`), text)
}

function sevenDayAt(used: number): void {
  const rate_limits = { seven_day: { used_percentage: used }, five_hour: { used_percentage: 10 } }
  write(
    path.join(accountPath(), 'status-cache', 'sessions', 's1.json'),
    JSON.stringify({ session_id: 's1', written_at: NOON.getTime() / 1000 - 30, rate_limits }),
  )
}

const seatTask = (id: string): string => task(id).replace('estimate: 1', 'estimate: 2')

/** `shepherd status --json` with one acme/widgets PR per phase; the stub names that repo as the fixture's origin. */
const shepherdStatus = (phases: readonly string[]): string =>
  JSON.stringify(
    phases.map((phase, i) => ({
      repo: 'acme/widgets',
      pr: i + 1,
      runId: `run-${i + 1}`,
      phase,
      headSha: null,
      stalled: null,
    })),
  )

describe('burndown tick in seats mode', () => {
  beforeEach(() => {
    seatPolicy()
    config({ seats: ['seat-t'] })
  })

  it("dispatches up to the seat's role cap on the pool's config dir, with seat claims", async () => {
    seatInitiative({ 'DM-1': seatTask('DM-1'), 'DM-2': seatTask('DM-2'), 'DM-3': seatTask('DM-3') })
    const fake = fakeBroker()

    const lines = await tick(fake)

    expect(fake.frames.map(f => [f.name, f.profile, f.configDir])).toEqual([
      ['st-dm-1', 'bd-implementer', accountPath()],
      ['st-dm-2', 'bd-implementer', accountPath()],
    ])
    expect(lines.join('\n')).toContain('refused demo DM-3 [role-cap]: seat seat-t holds 2 of 2 implementers')
    const ledger = readLedger(burndownLedgerPath())
    expect(ledger.claims.map(c => [c.taskId, c.seat, c.namePrefix])).toEqual([
      ['DM-1', 'seat-t', 'st'],
      ['DM-2', 'seat-t', 'st'],
    ])
    expect(ledger.seats).toEqual({ 'seat-t': { samples: [{ at: NOON.getTime(), sevenDay: 40 }] } })
  })

  it('one tick reads Shepherd status once for observe and planning', async () => {
    seatInitiative({ 'DM-1': seatTask('DM-1') })
    const inFlight: Claim = {
      taskId: 'DM-9',
      initiative: 'demo',
      seat: 'seat-t',
      namePrefix: 'st',
      spawnedAt: NOON.toISOString(),
      agentId: 'a9',
      agentName: 'st-dm-9',
      spawned: ['st-dm-9'],
      phase: 'shepherding',
      phaseAt: NOON.toISOString(),
      pr: 'https://github.com/acme/widgets/pull/1',
    }
    writeLedger(burndownLedgerPath(), { version: 1, claims: [inFlight] })
    const statusReads: string[][] = []
    const exec = stubGh(
      undefined,
      args => (args[1] === 'status' && statusReads.push(args), { status: 0, stdout: '[]' }),
    )

    await tick(fakeBroker(), true, () => {}, exec)

    expect(statusReads).toHaveLength(1)
  })

  it('refuses the implementer when Shepherd holds the repo at its downstream WIP limit', async () => {
    seatInitiative({ 'DM-1': seatTask('DM-1') })
    const exec = stubGh(undefined, () => ({ status: 0, stdout: shepherdStatus(['review', 'merging', 'ci']) }))
    const root = path.join(world, 'aw')
    const autonomyRoot = path.join(root, 'claude-channels', 'sources', 'autonomy')

    const lines = await tick(fakeBroker(), true, () => {}, exec)
    const planned = seatPlanFromDisk({ seat: 'seat-t', now: NOON, root, autonomyRoot, exec })

    const reason =
      'acme/widgets has 2 PRs in review or waiting, at its WIP limit of 2 (2x concurrency.reviewers, at least 2)'
    expect(lines).toContainEqual(expect.stringContaining(`refused demo DM-1 [wip]: ${reason}`))
    expect(lines.join('\n')).not.toContain('would spawn st-dm-1')
    expect(planned.dispatch).toEqual([])
    expect(planned.refusals).toEqual([expect.objectContaining({ task: 'DM-1', kind: 'wip', reason })])
  })

  it('refuses the implementer as unknown downstream WIP when Shepherd status fails', async () => {
    seatInitiative({ 'DM-1': seatTask('DM-1') })
    const exec = stubGh(undefined, () => ({ status: 1, stdout: '', stderr: 'shepherd down' }))
    const root = path.join(world, 'aw')
    const autonomyRoot = path.join(root, 'claude-channels', 'sources', 'autonomy')

    const lines = await tick(fakeBroker(), true, () => {}, exec)
    const planned = seatPlanFromDisk({ seat: 'seat-t', now: NOON, root, autonomyRoot, exec })

    const reason = `could not read Shepherd status, so downstream WIP for ${repo()} is unknown`
    expect(lines).toContainEqual(expect.stringContaining(`refused demo DM-1 [wip]: ${reason}`))
    expect(planned.dispatch).toEqual([])
    expect(planned.refusals).toEqual([expect.objectContaining({ task: 'DM-1', kind: 'wip', reason })])
  })

  it('stops at the pool gate with the BUDGET-PAUSE reason', async () => {
    seatInitiative({ 'DM-1': seatTask('DM-1') })
    sevenDayAt(75)
    const fake = fakeBroker()

    const lines = await tick(fake)

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('refused demo DM-1 [budget]: BUDGET-PAUSE pool pool-t: seven_day 75%')
  })

  it('keeps one pool sample per tick and prunes samples older than 26 hours', async () => {
    seatInitiative({})
    const hour = 3_600_000
    const old = { at: NOON.getTime() - 27 * hour, sevenDay: 20 }
    const recent = { at: NOON.getTime() - hour, sevenDay: 38 }
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [],
      seats: { 'seat-t': { samples: [old, recent] } },
    })

    await tick(fakeBroker())

    expect(readLedger(burndownLedgerPath()).seats?.['seat-t']?.samples).toEqual([
      recent,
      { at: NOON.getTime(), sevenDay: 40 },
    ])
  })

  it("counts the seat's prefixed worktrees against maxWorktreesPerRepo", async () => {
    config({ seats: ['seat-t'], maxWorktreesPerRepo: 1 })
    seatInitiative({ 'DM-1': seatTask('DM-1') })
    git(repo(), 'worktree', 'add', '-q', '-b', 'st-x-9', path.join('.worktrees', 'st-x-9'))
    const fake = fakeBroker()

    const lines = await tick(fake)

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('1 burndown worktrees under')
  })

  it('refuses with a config error when a brief also opts in with autonomy:', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const fake = fakeBroker()

    const lines = await tick(fake)

    expect(lines).toEqual([
      expect.stringMatching(/^config error: .* lists seats, and brief.md of demo has an autonomy: block/),
    ])
    expect(fake.rosterCalls).toBe(0)
  })

  it('skips a seat that cannot load or plan, logs it, and still advances claims and plans the others', async () => {
    config({ seats: ['nope', 'seat-e', 'seat-t'] })
    seatInitiative({ 'DM-1': seatTask('DM-1') })
    const inFlight: Claim = {
      taskId: 'DM-9',
      initiative: 'demo',
      seat: 'seat-t',
      namePrefix: 'st',
      spawnedAt: NOON.toISOString(),
      phase: 'spawning',
      phaseAt: NOON.toISOString(),
      nextPhase: 'implementing',
      agentName: 'st-dm-9',
      spawned: ['st-dm-9'],
    }
    writeLedger(burndownLedgerPath(), { version: 1, claims: [inFlight] })
    const logged: { event: string; detail: Record<string, unknown> }[] = []
    const fake = fakeBroker({ agents: [row('st-dm-9', 'live')] })

    const lines = await tick(fake, false, (event, detail) => logged.push({ event, detail }))

    expect(lines).toContain(
      `seat nope skipped: nope is not a seat in ${path.join(world, 'aw', 'claude-channels', 'sources', 'autonomy')}/charter.md`,
    )
    expect(lines).toContain('seat seat-e skipped: seat-e has no dispatch scope (hub seat)')
    expect(logged.filter(l => l.event === 'burndown_seat_skipped').map(l => l.detail.seat)).toEqual([
      'nope',
      'seat-e',
    ])
    expect(readLedger(burndownLedgerPath()).claims.find(c => c.taskId === 'DM-9')?.phase).toBe('implementing')
    expect(fake.frames.map(f => f.name)).toEqual(['st-dm-1'])
  })

  it('burndown plan --seat prints the seat dispatch plan and its refusals', () => {
    seatInitiative({ 'DM-1': seatTask('DM-1'), 'DM-2': seatTask('DM-2'), 'DM-3': seatTask('DM-3') })
    const root = path.join(world, 'aw')
    const autonomyRoot = path.join(root, 'claude-channels', 'sources', 'autonomy')

    const lines = renderPlan(
      seatPlanFromDisk({ seat: 'seat-t', now: NOON, root, autonomyRoot, exec: stubGh() }),
      NOON,
    )

    expect(lines.map(l => l.replace(/: score .*$/, ''))).toEqual([
      `burndown plan at ${NOON.toISOString()} (dry run: nothing spawned, nothing claimed)`,
      `would dispatch demo DM-1 as bd-implementer on pool-t in ${repo()}/.worktrees/st-dm-1`,
      `would dispatch demo DM-2 as bd-implementer on pool-t in ${repo()}/.worktrees/st-dm-2`,
      'refused demo DM-3 [role-cap]: seat seat-t holds 2 of 2 implementers',
      'scorer skipped: 0',
    ])
    expect(() => seatPlanFromDisk({ seat: 'seat-e', now: NOON, root, autonomyRoot })).toThrow(
      'seat-e has no dispatch scope',
    )
  })

  it("burndown plan --seat plans the charter's hub seat from its seat file when its role is not hub", () => {
    seatPolicy({ hub: 'seat-t' })
    seatInitiative({ 'DM-1': seatTask('DM-1') })
    const root = path.join(world, 'aw')
    const autonomyRoot = path.join(root, 'claude-channels', 'sources', 'autonomy')

    const lines = renderPlan(
      seatPlanFromDisk({ seat: 'seat-t', now: NOON, root, autonomyRoot, exec: stubGh() }),
      NOON,
    )

    expect(lines).toContainEqual(
      expect.stringMatching(
        `^would dispatch demo DM-1 as bd-implementer on pool-t in ${repo()}/.worktrees/st-dm-1`,
      ),
    )
  })

  it('burndown plan --seat still refuses a seat whose role is hub', () => {
    seatPolicy({ hub: 'seat-t' })
    const root = path.join(world, 'aw')
    const autonomyRoot = path.join(root, 'claude-channels', 'sources', 'autonomy')
    write(path.join(autonomyRoot, 'seats', 'seat-e.md'), '---\nrole: hub\nprefix: se\npool: pool-t\n---\n')

    expect(() => seatPlanFromDisk({ seat: 'seat-e', now: NOON, root, autonomyRoot })).toThrow(
      'seat-e is the hub seat and dispatches nothing',
    )
  })

  it('burndown plan --seat and the tick report a malformed task the scorer skipped', async () => {
    seatInitiative({ 'DM-1': seatTask('DM-1'), 'DM-2': seatTask('DM-2').replace('priority: 3\n', '') })
    const root = path.join(world, 'aw')
    const autonomyRoot = path.join(root, 'claude-channels', 'sources', 'autonomy')

    const plan = renderPlan(
      seatPlanFromDisk({ seat: 'seat-t', now: NOON, root, autonomyRoot, exec: stubGh() }),
      NOON,
    )
    const ticked = await tick(fakeBroker(), true)

    expect(plan).toContain('scorer skipped: 1 (demo/DM-2.yml)')
    expect(ticked).toContain('seat seat-t scorer skipped: 1 (demo/DM-2.yml)')
  })

  it('burndown plan --seat counts only active trees when it has a roster, and every held tree without one', () => {
    seatPolicy({ implementers: 1 })
    seatInitiative({ 'DM-2': seatTask('DM-2') })
    const root = path.join(world, 'aw')
    const autonomyRoot = path.join(root, 'claude-channels', 'sources', 'autonomy')
    const worktree = path.join(repo(), '.worktrees', 'st-dm-1')
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [
        {
          taskId: 'DM-1',
          initiative: 'demo',
          seat: 'seat-t',
          namePrefix: 'st',
          spawnedAt: NOON.toISOString(),
          phase: 'awaiting-merge',
          phaseAt: NOON.toISOString(),
          agentName: 'st-dm-1',
          spawned: ['st-dm-1'],
          worktree,
        },
      ],
    })
    const dry = (roster?: { agents: AgentIdentity[] }) =>
      seatPlanFromDisk({
        seat: 'seat-t',
        now: NOON,
        root,
        autonomyRoot,
        exec: stubGh(),
        ...(roster ? { roster } : {}),
      })

    expect(dry().refusals.map(r => r.kind)).toEqual(['worktrees'])
    const parked = dry({ agents: [row('st-dm-1', 'exited', worktree)] })
    expect(parked.dispatch.map(d => d.task)).toEqual(['DM-2'])
    expect(dry({ agents: [row('st-dm-1', 'live', worktree)] }).refusals.map(r => r.kind)).toEqual([
      'worktrees',
    ])
  })

  it('dry run prints the seat dispatch and writes nothing', async () => {
    seatInitiative({ 'DM-1': seatTask('DM-1') })

    const lines = await tick(fakeBroker(), true)

    expect(lines.join('\n')).toContain(
      `would spawn st-dm-1 as bd-implementer (headless) on ${accountPath()} in ${repo()}`,
    )
    expect(fs.existsSync(burndownLedgerPath())).toBe(false)
  })

  it('tells the seat of its dispatches in one message and marks them notified', async () => {
    seatInitiative({ 'DM-1': seatTask('DM-1'), 'DM-2': seatTask('DM-2') })
    const fake = fakeBroker()

    const lines = await tick(fake)

    expect(fake.sends).toEqual([
      {
        to: 'seat-t',
        text: `Burndown events for seat-t at ${NOON.toISOString()}\ndispatched DM-1\ndispatched DM-2`,
      },
    ])
    expect(lines).toContain('told seat-t of 2 event(s)')
    expect(fake.senders).toEqual({ opened: 1, closed: 1 })
    expect(readLedger(burndownLedgerPath()).claims.map(c => c.notified)).toEqual([
      ['dispatched'],
      ['dispatched'],
    ])
  })

  it('leaves events unmarked on a failed send and delivers them on the next tick', async () => {
    seatInitiative({ 'DM-1': seatTask('DM-1') })
    let up = false
    const fake = fakeBroker({
      agents: [row('st-dm-1', 'live')],
      sendAs: () => (up ? { ok: true } : { ok: false, reason: 'broker gone' }),
    })

    const first = await tick(fake)
    expect(first).toContain('could not tell seat-t of 1 event(s): broker gone; retried next tick')
    expect(readLedger(burndownLedgerPath()).claims[0]?.notified).toBeUndefined()

    up = true
    await tick(fake)
    await tick(fake)

    expect(fake.sends.map(s => s.text.split('\n').slice(1))).toEqual([
      ['dispatched DM-1'],
      ['dispatched DM-1'],
    ])
    expect(readLedger(burndownLedgerPath()).claims[0]?.notified).toEqual(['dispatched'])
  })

  it('dry run prints the seat message instead of sending it', async () => {
    const claim: Claim = {
      taskId: 'DM-9',
      initiative: 'demo',
      seat: 'seat-t',
      spawnedAt: NOON.toISOString(),
      phase: 'parked',
      phaseAt: NOON.toISOString(),
      agentId: 'id-st-dm-9',
      notified: ['dispatched'],
    }
    seatInitiative({})
    writeLedger(burndownLedgerPath(), { version: 1, claims: [claim] })
    const fake = fakeBroker()

    const lines = await tick(fake, true)

    expect(fake.sends).toEqual([])
    expect(lines).toEqual(
      expect.arrayContaining([
        'would send to seat-t:',
        `  Burndown events for seat-t at ${NOON.toISOString()}`,
        '  parked DM-9',
      ]),
    )
  })

  it('sends nothing for a claim whose seat is not enabled', async () => {
    const claim: Claim = {
      taskId: 'DM-9',
      initiative: 'demo',
      seat: 'seat-off',
      spawnedAt: NOON.toISOString(),
      phase: 'parked',
      phaseAt: NOON.toISOString(),
      agentId: 'id-st-dm-9',
    }
    seatInitiative({})
    writeLedger(burndownLedgerPath(), { version: 1, claims: [claim] })
    const fake = fakeBroker()

    await tick(fake)
    const dry = await tick(fake, true)

    expect(fake.sends).toEqual([])
    expect(fake.senders.opened).toBe(0)
    expect(dry.join('\n')).not.toContain('would send')
    expect(readLedger(burndownLedgerPath()).claims[0]?.notified).toBeUndefined()
  })
})

describe('burndown tick with two seats on one pool (CC-275)', () => {
  const autonomy = () => path.join(world, 'aw', 'claude-channels', 'sources', 'autonomy')
  /** seat-u (prefix `su`) on pool-t with seat-t's scope and repo. */
  function secondSeat(): void {
    const concurrency = 'concurrency: {implementers: 2, reviewers: 1, planners: 1}'
    write(
      path.join(autonomy(), 'seats', 'seat-u.md'),
      `---\nprefix: su\npool: pool-t\ninitiatives: {demo: 1.0}\nrepos:\n  - {path: ${repo()}, initiatives: [demo]}\n${concurrency}\n---\n`,
    )
    config({ seats: ['seat-t', 'seat-u'] })
  }
  const queued = (taskId: string, seat: string, owns: string[]): Claim => ({
    taskId,
    initiative: 'demo',
    seat,
    namePrefix: seat === 'seat-t' ? 'st' : 'su',
    slice: 'a',
    owns,
    spawnedAt: NOON.toISOString(),
    phase: 'queued',
    phaseAt: NOON.toISOString(),
  })

  it("charges the first seat's dispatch against the pool, so the second seat cannot overshoot per_day", async () => {
    seatPolicy({
      implementers: 1,
      extraSeats: ', seat-u',
      poolExtra: ', per_day_points: 3, dispatch_seven_day_points: 2',
    })
    secondSeat()
    seatInitiative({ 'DM-1': seatTask('DM-1'), 'DM-2': seatTask('DM-2') })
    const before7 = { at: NOON.getTime() - 6 * 3_600_000, sevenDay: 39 }
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [],
      seats: { 'seat-t': { samples: [before7] }, 'seat-u': { samples: [before7] } },
    })
    const fake = fakeBroker()

    const lines = await tick(fake)

    expect(fake.frames.map(f => f.name)).toEqual(['st-dm-1'])
    expect(lines).toContain(
      'refused demo DM-1 [claimed]: seat seat-t dispatched it earlier this tick as st-dm-1',
    )
    expect(lines).toContain(
      "refused demo DM-2 [budget]: BUDGET-PAUSE pool pool-t: day spend 3 points since 07:00 at or above the pool pool-t's per_day_points 3; charged 1 dispatch(es) this tick at +2 seven_day, +10 five_hour",
    )
  })

  it("refuses the second seat's slice whose owns overlap the first seat's same-tick slice", async () => {
    seatPolicy({ extraSeats: ', seat-u' })
    secondSeat()
    seatInitiative({ 'DM-1': seatTask('DM-1'), 'DM-2': seatTask('DM-2') })
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [queued('DM-1', 'seat-t', ['src/x.ts']), queued('DM-2', 'seat-u', ['src/**'])],
    })
    const fake = fakeBroker()

    const lines = await tick(fake)

    expect(fake.frames.map(f => f.name)).toEqual(['st-dm-1-a'])
    expect(lines).toContain(
      "refused demo DM-2 [claimed]: src/** is under st-dm-1-a's owns, dispatched by seat seat-t earlier this tick",
    )
  })
})

describe('burndown tick advances a seat claim', () => {
  const seatClaim = (seat: string, over: Partial<Claim> = {}): { claim: Claim; worktree: string } => {
    const worktree = path.join(repo(), '.worktrees', 'st-dm-1')
    git(repo(), 'worktree', 'add', '-q', '-b', 'agent-chat/st-dm-1', worktree)
    git(worktree, 'commit', '-q', '--allow-empty', '-m', 'work')
    const claim: Claim = {
      taskId: 'DM-1',
      initiative: 'demo',
      seat,
      namePrefix: 'st',
      spawnedAt: NOON.toISOString(),
      phase: 'implementing',
      phaseAt: NOON.toISOString(),
      agentName: 'st-dm-1',
      spawned: ['st-dm-1'],
      worktree,
      ...over,
    }
    writeLedger(burndownLedgerPath(), { version: 1, claims: [claim] })
    return { claim, worktree }
  }

  beforeEach(() => {
    seatPolicy()
    config({ seats: ['seat-t'] })
    seatInitiative({ 'DM-1': seatTask('DM-1') })
  })

  it("spawns the reviewer on the seat's pool config dir without an autonomy block", async () => {
    const { worktree } = seatClaim('seat-t')
    const fake = fakeBroker({ agents: [row('st-dm-1', 'exited', worktree)] })

    await tick(fake)

    expect(fake.frames).toEqual([
      expect.objectContaining({
        name: 'st-dm-1-r0',
        profile: 'bd-reviewer',
        cwd: worktree,
        configDir: accountPath(),
      }),
    ])
    expect(readLedger(burndownLedgerPath()).claims[0]).toMatchObject({
      phase: 'spawning',
      nextPhase: 'reviewing',
    })
  })

  it('does not spawn the reviewer while the seat pool gate is closed', async () => {
    const { worktree } = seatClaim('seat-t')
    sevenDayAt(75)
    const fake = fakeBroker({ agents: [row('st-dm-1', 'exited', worktree)] })

    const lines = await tick(fake)

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('deferred DM-1#: budget: BUDGET-PAUSE pool pool-t')
    expect(readLedger(burndownLedgerPath()).claims[0]?.stalledReason).toBeUndefined()
  })

  it('defers the reviewer without stalling the claim when its seat is skipped this tick', async () => {
    const { worktree } = seatClaim('nope')
    config({ seats: ['seat-t', 'nope'] })
    const fake = fakeBroker({ agents: [row('st-dm-1', 'exited', worktree)] })

    const lines = await tick(fake)

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('deferred DM-1#: seat nope skipped this tick')
    expect(readLedger(burndownLedgerPath()).claims[0]?.stalledReason).toBeUndefined()
  })

  it('defers the reviewer while the seat pool is within its sonnet-only band', async () => {
    const { worktree } = seatClaim('seat-t')
    sevenDayAt(65)
    const fake = fakeBroker({ agents: [row('st-dm-1', 'exited', worktree)] })

    const lines = await tick(fake)

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain(
      'deferred DM-1#: budget: pool-t is within 10 points of a stop, sonnet only',
    )
  })

  describe('with a second repo in the seat dispatch', () => {
    const reviewedClaim = (): { claim: Claim; worktree: string } => {
      const second = secondRepo()
      seatPolicy({ extraRepo: second, grants: 'merge' })
      const worktree = path.join(second, '.worktrees', 'st-dm-1')
      git(second, 'worktree', 'add', '-q', '-b', 'agent-chat/st-dm-1', worktree)
      const claim: Claim = {
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
      writeLedger(burndownLedgerPath(), { version: 1, claims: [claim] })
      return { claim, worktree }
    }

    it('spawns the successor from the repo holding the claim worktree, on the seat placement', async () => {
      const { worktree } = reviewedClaim()
      const fake = fakeBroker({ agents: [row('st-dm-1-r0', 'exited', worktree)] })

      await tick(fake)

      expect(fake.frames).toEqual([
        expect.objectContaining({
          name: 'st-dm-1-s1',
          profile: 'bd-implementer',
          cwd: path.join(world, 'repo2'),
          configDir: accountPath(),
          worktree,
          brief: expect.stringContaining('Grants in force: merge.'),
        }),
      ])
    })

    it('defers the successor while the seat pool gate is closed', async () => {
      const { worktree } = reviewedClaim()
      sevenDayAt(75)
      const fake = fakeBroker({ agents: [row('st-dm-1-r0', 'exited', worktree)] })

      const lines = await tick(fake)

      expect(fake.frames).toEqual([])
      expect(lines.join('\n')).toContain('deferred DM-1#: budget: BUDGET-PAUSE pool pool-t')
    })

    it('defers the successor while the seat pool is within its sonnet-only band', async () => {
      const { worktree } = reviewedClaim()
      sevenDayAt(65)
      const fake = fakeBroker({ agents: [row('st-dm-1-r0', 'exited', worktree)] })

      const lines = await tick(fake)

      expect(fake.frames).toEqual([])
      expect(lines.join('\n')).toContain('sonnet only')
    })
  })

  const finding: NonNullable<Claim['finding']> = {
    kind: 'stalled-after-claim',
    reason: 'idle',
    since: NOON.toISOString(),
    openedAt: NOON.toISOString(),
    checkedAt: NOON.toISOString(),
    detail: `idle: no agent event for 6 min since ${NOON.toISOString()}`,
  }

  it('closes an open finding in the tick that defers the reviewer', async () => {
    const { worktree } = seatClaim('seat-t', { finding })
    sevenDayAt(75)
    const fake = fakeBroker({ agents: [row('st-dm-1', 'exited', worktree)] })

    const lines = await tick(fake)

    expect(lines.join('\n')).toContain('deferred DM-1#: budget: BUDGET-PAUSE pool pool-t')
    expect(readLedger(burndownLedgerPath()).claims[0]?.finding).toBeUndefined()
  })

  it('closes an open finding in the tick that stalls the reviewer spawn', async () => {
    const { worktree } = seatClaim('seat-gone', { finding })
    const fake = fakeBroker({ agents: [row('st-dm-1', 'exited', worktree)] })

    await tick(fake)

    expect(readLedger(burndownLedgerPath()).claims[0]).toMatchObject({
      stalledReason: 'seat seat-gone is no longer in the burndown config; left for the owner',
    })
    expect(readLedger(burndownLedgerPath()).claims[0]?.finding).toBeUndefined()
  })

  it('stalls the claim once, without spawning, when its seat is no longer in the config', async () => {
    const { worktree } = seatClaim('seat-gone')
    const fake = fakeBroker({ agents: [row('st-dm-1', 'exited', worktree)] })

    await tick(fake)
    await tick(fake)

    expect(fake.frames).toEqual([])
    expect(readLedger(burndownLedgerPath()).claims[0]?.stalledReason).toBe(
      'seat seat-gone is no longer in the burndown config; left for the owner',
    )
  })
})

describe('burndown tick leak check', () => {
  const PR = 'https://github.com/example/demo/pull/7'
  const PRIVATE = 'quokkaproject'

  beforeEach(() => {
    seatPolicy()
    config({ seats: ['seat-t'] })
    seatInitiative({ 'DM-1': seatTask('DM-1') })
    write(path.join(world, 'home', 'private-denylist.json'), JSON.stringify({ 'private-name': [PRIVATE] }))
  })

  function claimWithPr(): string {
    const worktree = path.join(repo(), '.worktrees', 'st-dm-1')
    git(repo(), 'worktree', 'add', '-q', '-b', 'agent-chat/st-dm-1', worktree)
    git(worktree, 'commit', '-q', '--allow-empty', '-m', 'work')
    git(worktree, 'push', '-q', 'origin', 'agent-chat/st-dm-1')
    const claim: Claim = {
      taskId: 'DM-1',
      initiative: 'demo',
      seat: 'seat-t',
      namePrefix: 'st',
      spawnedAt: NOON.toISOString(),
      phase: 'implementing',
      phaseAt: NOON.toISOString(),
      agentName: 'st-dm-1',
      spawned: ['st-dm-1'],
      worktree,
      pr: PR,
      notified: ['dispatched'],
    }
    writeLedger(burndownLedgerPath(), { version: 1, claims: [claim] })
    return worktree
  }

  const pulls = (...rows: Record<string, unknown>[]): Runner =>
    stubGh(args =>
      args[2]?.startsWith('repos/example/demo/pulls') === true
        ? { status: 0, stdout: rows.map(r => JSON.stringify(r)).join('\n') }
        : { status: 0, stdout: '' },
    )

  const openPr = (over: Record<string, unknown> = {}) => ({
    number: 7,
    url: PR,
    title: 'Add a thing',
    body: '',
    branch: 'agent-chat/st-dm-1',
    headRepo: 'example/demo',
    base: 'main',
    private: false,
    ...over,
  })

  it('delivers one redacted leak event to the seat, and nothing new on the next tick', async () => {
    const worktree = claimWithPr()
    const fake = fakeBroker({ agents: [row('st-dm-1', 'live', worktree)] })
    const exec = pulls(openPr({ body: `Imports the ${PRIVATE} tables` }))

    await tick(fake, false, () => {}, exec)
    await tick(fake, false, () => {}, exec)

    expect(fake.sends).toHaveLength(1)
    expect(fake.sends[0]?.to).toBe('seat-t')
    expect(fake.sends[0]?.text).toContain(`leak DM-1: ${PR}: body:1 private-name`)
    expect(fake.sends[0]?.text).not.toContain(PRIVATE)
    expect(readLedger(burndownLedgerPath()).claims[0]?.notified).toEqual(['dispatched', 'leak'])
  })

  it('scans the pushed branch through private refs, leaving origin/* and no scan refs behind', async () => {
    const worktree = claimWithPr()
    write(path.join(worktree, 'notes.md'), `see ${PRIVATE}\n`)
    git(worktree, 'add', 'notes.md')
    git(worktree, 'commit', '-q', '-m', 'notes')
    git(worktree, 'push', '-q', 'origin', 'agent-chat/st-dm-1')
    git(repo(), 'update-ref', '-d', 'refs/remotes/origin/agent-chat/st-dm-1')
    const refsBefore = git(repo(), 'for-each-ref', '--format=%(refname) %(objectname)')
    const fake = fakeBroker({ agents: [row('st-dm-1', 'live', worktree)] })

    await tick(fake, false, () => {}, pulls(openPr()))

    expect(fake.sends).toHaveLength(1)
    expect(fake.sends[0]?.text).toMatch(/leak DM-1: .*: [0-9a-f]{12} notes\.md:1 private-name/)
    expect(fake.sends[0]?.text).not.toContain(PRIVATE)
    expect(git(repo(), 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(refsBefore)
  })

  it('files one human-queue item for an unclaimed agent PR', async () => {
    const worktree = claimWithPr()
    const fake = fakeBroker({ agents: [row('st-dm-1', 'live', worktree)] })
    const stray = openPr({
      number: 9,
      url: PR.replace('/7', '/9'),
      branch: 'agent-chat/lone',
      title: PRIVATE,
    })
    const exec = pulls(openPr(), stray)

    await tick(fake, false, () => {}, exec)
    await tick(fake, false, () => {}, exec)

    expect(fake.notices).toHaveLength(1)
    expect(fake.notices[0]).toContain('title private-name')
    expect(fake.notices[0]).not.toContain(PRIVATE)
    expect(fake.sends).toEqual([])
  })
})

describe('burndown tick charges seat claim spawns to their pool (CC-292)', () => {
  const autonomy = () => path.join(world, 'aw', 'claude-channels', 'sources', 'autonomy')
  const before7 = { at: NOON.getTime() - 6 * 3_600_000, sevenDay: 40 }
  const implemented = (taskId: string, seat: string): { claim: Claim; name: string; worktree: string } => {
    const name = `st-${taskId.toLowerCase()}`
    const worktree = path.join(repo(), '.worktrees', name)
    git(repo(), 'worktree', 'add', '-q', '-b', `agent-chat/${name}`, worktree)
    git(worktree, 'commit', '-q', '--allow-empty', '-m', 'work')
    const claim: Claim = {
      taskId,
      initiative: 'demo',
      seat,
      namePrefix: 'st',
      spawnedAt: NOON.toISOString(),
      phase: 'implementing',
      phaseAt: NOON.toISOString(),
      agentName: name,
      spawned: [name],
      worktree,
    }
    return { claim, name, worktree }
  }

  it('lets one reviewer spawn and refuses the new dispatch when the pool has headroom for one', async () => {
    seatPolicy({ poolExtra: ', per_day_points: 2' })
    config({ seats: ['seat-t'] })
    seatInitiative({ 'DM-1': seatTask('DM-1'), 'DM-2': seatTask('DM-2') })
    const due = implemented('DM-1', 'seat-t')
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [due.claim],
      seats: { 'seat-t': { samples: [before7] } },
    })
    const fake = fakeBroker({ agents: [row(due.name, 'exited', due.worktree)] })

    const lines = await tick(fake)

    expect(fake.frames.map(f => f.name)).toEqual(['st-dm-1-r0'])
    expect(lines).toContain(
      "refused demo DM-2 [budget]: BUDGET-PAUSE pool pool-t: day spend 2 points since 07:00 at or above the pool pool-t's per_day_points 2; charged 1 dispatch(es) this tick at +2 seven_day, +10 five_hour",
    )
  })

  it('defers the second of two reviewers on one pool without stalling its claim', async () => {
    seatPolicy({ poolExtra: ', per_day_points: 2' })
    config({ seats: ['seat-t'] })
    seatInitiative({ 'DM-1': seatTask('DM-1'), 'DM-2': seatTask('DM-2') })
    const first = implemented('DM-1', 'seat-t')
    const second = implemented('DM-2', 'seat-t')
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [first.claim, second.claim],
      seats: { 'seat-t': { samples: [before7] } },
    })
    const agents = [row(first.name, 'exited', first.worktree), row(second.name, 'exited', second.worktree)]
    const fake = fakeBroker({ agents })

    const lines = await tick(fake)

    expect(fake.frames.map(f => f.name)).toEqual(['st-dm-1-r0'])
    expect(lines.join('\n')).toContain(
      'deferred DM-2#: budget: BUDGET-PAUSE pool pool-t: day spend 2 points since 07:00',
    )
    expect(
      readLedger(burndownLedgerPath()).claims.find(c => c.taskId === 'DM-2')?.stalledReason,
    ).toBeUndefined()
  })

  it("does not charge a reviewer spawn on one pool against another pool's dispatch", async () => {
    const other = path.join(world, 'profiles', 'other')
    fs.cpSync(accountPath(), other, { recursive: true })
    const pools = [
      `pool-t: {config_dir: ${accountPath()}, human_uses: false, reserve_seven_day: 30, ceiling_five_hour: 75}`,
      `pool-u: {config_dir: ${other}, human_uses: false, reserve_seven_day: 30, ceiling_five_hour: 75, per_day_points: 2}`,
    ]
    write(
      path.join(autonomy(), 'charter.md'),
      `---\nseats: [seat-t, seat-u]\n${DEFAULTS}\npools:\n  ${pools.join('\n  ')}\n---\n`,
    )
    const seat = (prefix: string, pool: string) =>
      `---\nprefix: ${prefix}\npool: ${pool}\ninitiatives: {demo: 1.0}\nrepos:\n  - {path: ${repo()}, initiatives: [demo]}\nconcurrency: {implementers: 2, reviewers: 1, planners: 1}\n---\n`
    write(path.join(autonomy(), 'seats', 'seat-t.md'), seat('st', 'pool-t'))
    write(path.join(autonomy(), 'seats', 'seat-u.md'), seat('su', 'pool-u'))
    config({ seats: ['seat-u', 'seat-t'] })
    seatInitiative({ 'DM-1': seatTask('DM-1'), 'DM-2': seatTask('DM-2') })
    const due = implemented('DM-1', 'seat-t')
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [due.claim],
      seats: { 'seat-t': { samples: [before7] }, 'seat-u': { samples: [before7] } },
    })
    const fake = fakeBroker({ agents: [row(due.name, 'exited', due.worktree)] })

    await tick(fake)

    expect(fake.frames.map(f => [f.name, f.configDir])).toEqual([
      ['st-dm-1-r0', accountPath()],
      ['su-dm-2', other],
    ])
  })
})

describe('tick subprocesses', () => {
  it('never pass the agent-chat identity to a child', () => {
    process.env.AGENT_CHAT_NAME = 'parent'
    process.env.AGENT_CHAT_AGENT_ID = 'parent-id'

    const env = run('/usr/bin/env', []).stdout

    expect(env).not.toContain('AGENT_CHAT_NAME')
    expect(env).not.toContain('AGENT_CHAT_AGENT_ID')
    expect(env).toContain('AGENT_CHAT_HOME')
  })
})

const MINUTE = 60_000

const question = (minutesAgo: number, msgId = 'q1'): QueueItem => ({
  msgId,
  kind: 'question',
  from: 'bd-dm-1',
  text: 'which branch?',
  at: NOON.getTime() - minutesAgo * MINUTE,
  meta: {},
})

function deciderSetup(agentId = 'id-decider', extra: Record<string, unknown> = {}): void {
  config({ decider: { name: 'decider' }, ...extra })
  write(configPath(), JSON.stringify({ worktreeBudget: 10, decider: { agentId } }))
}

const deciderRow = (state: AgentIdentity['state'], agentId = 'id-decider'): AgentIdentity => ({
  ...row('decider', state),
  agentId,
  profile: 'decider',
  isolation: 'none',
})

const wakesAgo = (minutes: number[]): string[] =>
  minutes.map(m => new Date(NOON.getTime() - m * MINUTE).toISOString())

describe('burndown tick wakes the decider', () => {
  it('resumes the configured decider when a question has waited over 5 minutes', async () => {
    deciderSetup()
    const fake = fakeBroker({ agents: [deciderRow('exited')], queue: [question(6)] })

    const lines = await tick(fake)

    expect(fake.resumes.map(r => r.name)).toEqual(['decider'])
    expect(fake.resumes[0]?.message).toContain('`agent-chat inbox`')
    expect(fake.resumes[0]?.message).toContain('end your turn')
    expect(fake.resumes[0]?.message).not.toContain('which branch?')
    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('woke decider decider')
  })

  it('sends the broker resume frame headless with the wake message', async () => {
    const sent: unknown[] = []
    const client = {
      request: async (frame: unknown) => {
        sent.push(frame)
        return { t: 'spawn_result', ok: true, agentId: 'id-decider' }
      },
    } as unknown as BrokerClient

    await tickBroker(client).resume('decider', 'wake up')

    expect(sent).toEqual([{ t: 'resume', name: 'decider', surface: 'headless', message: 'wake up' }])
  })

  it('does not wake for a question younger than 5 minutes', async () => {
    deciderSetup()
    const fake = fakeBroker({ agents: [deciderRow('exited')], queue: [question(4)] })

    const lines = await tick(fake)

    expect(fake.resumes).toEqual([])
    expect(lines.join('\n')).toContain('no open question older than 5 minutes')
  })

  it('reports a mismatched id on a dry run even with an empty queue', async () => {
    deciderSetup('id-configured')
    const fake = fakeBroker({ agents: [deciderRow('exited', 'id-imposter')] })

    const lines = await tick(fake, true)

    expect(lines.join('\n')).toContain('config.json names id-configured')
  })

  it('does not wake again for a question the decider already saw at its last wake', async () => {
    deciderSetup()
    writeLedger(burndownLedgerPath(), { version: 1, claims: [], decider: { wakes: wakesAgo([90]) } })
    const fake = fakeBroker({ agents: [deciderRow('exited')], queue: [question(120)] })

    await tick(fake)

    expect(fake.resumes).toEqual([])
  })

  it('refuses and records it when the roster agentId differs from config.json', async () => {
    deciderSetup('id-configured')
    const fake = fakeBroker({ agents: [deciderRow('exited', 'id-imposter')], queue: [question(6)] })

    const lines = await tick(fake)

    expect(fake.resumes).toEqual([])
    expect(lines.join('\n')).toContain('config.json names id-configured')
    expect(readLedger(burndownLedgerPath()).decider?.refused?.reason).toContain('id-imposter')
  })

  it('refuses and records it when the decider is retired', async () => {
    deciderSetup()
    const fake = fakeBroker({ agents: [deciderRow('retired')], queue: [question(6)] })

    const lines = await tick(fake)

    expect(fake.resumes).toEqual([])
    expect(lines.join('\n')).toContain('decider decider is retired')
    expect(readLedger(burndownLedgerPath()).decider?.refused?.reason).toContain('retired')
  })

  it('refuses and records it when no agent holds the decider name', async () => {
    deciderSetup()
    const fake = fakeBroker({ queue: [question(6)] })

    const lines = await tick(fake)

    expect(fake.resumes).toEqual([])
    expect(lines.join('\n')).toContain('no agent named decider')
    expect(readLedger(burndownLedgerPath()).decider?.refused).toBeDefined()
  })

  it('does not re-wake a decider that is already live', async () => {
    deciderSetup()
    const fake = fakeBroker({ agents: [deciderRow('live')], queue: [question(6)] })

    const lines = await tick(fake)

    expect(fake.resumes).toEqual([])
    expect(lines.join('\n')).toContain('already live')
    expect(readLedger(burndownLedgerPath()).decider).toBeUndefined()
  })

  it('stops at maxPerHour wakes in the last hour', async () => {
    deciderSetup()
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [],
      decider: { wakes: wakesAgo([50, 40, 30, 20]) },
    })
    const fake = fakeBroker({ agents: [deciderRow('exited')], queue: [question(10)] })

    const lines = await tick(fake)

    expect(fake.resumes).toEqual([])
    expect(lines.join('\n')).toContain('4 times in the last hour (maxPerHour 4)')
  })

  it('stops at maxPerDay wakes in the last day', async () => {
    deciderSetup()
    const day = Array.from({ length: 24 }, (_, i) => 70 + i * 55)
    writeLedger(burndownLedgerPath(), { version: 1, claims: [], decider: { wakes: wakesAgo(day.reverse()) } })
    const fake = fakeBroker({ agents: [deciderRow('exited')], queue: [question(10)] })

    const lines = await tick(fake)

    expect(fake.resumes).toEqual([])
    expect(lines.join('\n')).toContain('24 times in the last day (maxPerDay 24)')
  })

  it('counts the wake in the ledger, under the ledger lock, before the frame is sent', async () => {
    deciderSetup()
    let seen: { wakes: string[] | undefined; locked: boolean } | undefined
    const fake = fakeBroker({
      agents: [deciderRow('exited')],
      queue: [question(6)],
      resume: () => {
        seen = {
          wakes: readLedger(burndownLedgerPath()).decider?.wakes,
          locked: fs.existsSync(`${burndownLedgerPath()}.lock`),
        }
        return { ok: true }
      },
    })

    await tick(fake)

    expect(seen).toEqual({ wakes: [NOON.toISOString()], locked: true })
  })

  it('does not wake when maxAgents is already reached', async () => {
    deciderSetup(undefined, { maxAgents: 1 })
    const done: Claim = {
      taskId: 'OLD',
      initiative: 'other',
      spawnedAt: NOON.toISOString(),
      phase: 'done',
      phaseAt: NOON.toISOString(),
      spawned: ['bd-old'],
    }
    writeLedger(burndownLedgerPath(), { version: 1, claims: [done] })
    const fake = fakeBroker({ agents: [row('bd-old', 'live'), deciderRow('exited')], queue: [question(6)] })

    const lines = await tick(fake)

    expect(fake.resumes).toEqual([])
    expect(lines.join('\n')).toContain('no agent capacity: 1 of maxAgents 1')
  })

  it('takes the maxAgents slot a new task would have used, and a live decider holds it too', async () => {
    deciderSetup(undefined, { maxAgents: 1 })
    initiative({ 'DM-1': task('DM-1') })

    const waking = fakeBroker({ agents: [deciderRow('exited')], queue: [question(6)] })
    await tick(waking)
    const live = fakeBroker({ agents: [deciderRow('live')] })
    const lines = await tick(live)

    expect(waking.resumes.map(r => r.name)).toEqual(['decider'])
    expect(waking.frames).toEqual([])
    expect(live.frames).toEqual([])
    expect(lines.join('\n')).toContain('1 of maxAgents 1 burndown agents alive')
  })

  it('dry run names the wake and sends and writes nothing', async () => {
    deciderSetup()
    const fake = fakeBroker({ agents: [deciderRow('exited')], queue: [question(6)] })

    const lines = await tick(fake, true)

    expect(lines.join('\n')).toContain('would wake decider decider (headless) for 1 waiting question(s)')
    expect(fake.resumes).toEqual([])
    expect(fs.existsSync(burndownLedgerPath())).toBe(false)
  })
})

describe('the tick and config.json', () => {
  it('leaves config.json byte-identical across a wake and a refusal', async () => {
    deciderSetup()
    const before = fs.readFileSync(configPath())
    const mtime = fs.statSync(configPath()).mtimeMs

    await tick(fakeBroker({ agents: [deciderRow('exited')], queue: [question(6)] }))
    await tick(fakeBroker({ agents: [deciderRow('exited', 'id-other')], queue: [question(6, 'q2')] }))

    expect(fs.readFileSync(configPath())).toEqual(before)
    expect(fs.statSync(configPath()).mtimeMs).toBe(mtime)
  })

  it('no burndown module can reach the config.json path', () => {
    const dir = path.join(__dirname, '..', 'agents', 'burndown')
    const files = [
      ...fs.readdirSync(dir).map(f => path.join(dir, f)),
      path.join(__dirname, '..', 'cli', 'burndown-broker.ts'),
    ]

    const reaching = files.filter(f =>
      /\bconfigPath\b|\bwriteConfig\b|['"]config\.json['"]/.test(fs.readFileSync(f, 'utf8')),
    )

    expect(reaching).toEqual([])
  })
})

/** CC-231: the tick runs the CC-202 collision check before it dispatches. */
describe('burndown tick collision check', () => {
  const pulls =
    (prs: { number: number; title: string; branch: string; body: string }[], failIn?: string) =>
    (args: string[], cwd?: string) =>
      cwd === failIn
        ? { status: 1, stdout: '' }
        : { status: 0, stdout: prs.map(p => JSON.stringify(p)).join('\n') }

  it('refuses a task a commit subject on the default branch names', async () => {
    initiative({ 'DM-1': task('DM-1') })
    git(repo(), 'commit', '-q', '--allow-empty', '-m', 'Do the thing (DM-1) (#7)')
    git(repo(), 'push', '-q', 'origin', 'main')
    const fake = fakeBroker()

    const lines = await tick(fake)

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('refused demo DM-1 [landed]: "Do the thing (DM-1) (#7)"')
  })

  it("refuses when another task's held agent opened the PR that names this id", async () => {
    initiative({ 'DM-1': task('DM-1', 1), 'DM-2': task('DM-2', 2) }, { lanes: 2 })
    const held: Claim = {
      taskId: 'DM-2',
      initiative: 'demo',
      spawnedAt: NOON.toISOString(),
      phase: 'implementing',
      phaseAt: NOON.toISOString(),
      agentName: 'bd-dm-2',
      spawned: ['bd-dm-2'],
    }
    writeLedger(burndownLedgerPath(), { version: 1, claims: [held] })
    const pr = { number: 9, title: 'Do DM-2', branch: 'agent-chat/bd-dm-2', body: 'Also fixes DM-1.' }
    const fake = fakeBroker({ agents: [row('bd-dm-2', 'live')] })

    const lines = await tick(fake, false, () => {}, stubGh(pulls([pr])))

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('refused demo DM-1 [open-pr]: #9 (agent-chat/bd-dm-2) names DM-1')
  })

  it("does not refuse on the PR of this task's own held claim", async () => {
    initiative({ 'DM-1': task('DM-1', 1), 'DM-2': task('DM-2', 2) }, { lanes: 2 })
    const pr = { number: 9, title: 'Do DM-2', branch: 'agent-chat/bd-dm-2', body: '' }
    const fake = fakeBroker()

    await tick(fake, false, () => {}, stubGh(pulls([pr])))

    expect(fake.frames.map(f => f.name)).toEqual(['bd-dm-1'])
  })

  it('logs a failed gh-pulls reader by name and refuses only that repo', async () => {
    const other = secondRepo()
    initiative({ 'DM-1': task('DM-1') })
    initiative({ 'OT-1': task('OT-1') }, { slug: 'other', at: other, rank: 2 })
    const logged: { event: string; detail: Record<string, unknown> }[] = []
    const fake = fakeBroker()

    const lines = await tick(
      fake,
      false,
      (event, detail) => logged.push({ event, detail }),
      stubGh(pulls([], repo())),
    )

    expect(logged.filter(l => l.event === 'burndown_collision_reader_failed')).toEqual([
      { event: 'burndown_collision_reader_failed', detail: { reader: 'gh-pulls', repo: repo() } },
    ])
    expect(lines.join('\n')).toContain('refused demo DM-1 [open-pr]: reader gh-pulls failed')
    expect(fake.frames.map(f => f.name)).toEqual(['bd-ot-1'])
  })

  it('logs a failed git-subjects reader by name and refuses only that repo', async () => {
    const other = secondRepo()
    initiative({ 'DM-1': task('DM-1') })
    initiative({ 'OT-1': task('OT-1') }, { slug: 'other', at: other, rank: 2 })
    git(other, 'remote', 'remove', 'origin')
    const logged: { event: string; detail: Record<string, unknown> }[] = []
    const fake = fakeBroker()

    const lines = await tick(fake, false, (event, detail) => logged.push({ event, detail }))

    expect(logged.filter(l => l.event === 'burndown_collision_reader_failed')).toEqual([
      { event: 'burndown_collision_reader_failed', detail: { reader: 'git-subjects', repo: other } },
    ])
    expect(lines.join('\n')).toContain('refused other OT-1 [landed]: reader git-subjects failed')
    expect(fake.frames.map(f => f.name)).toEqual(['bd-dm-1'])
  })

  it('logs a failed broker-view reader by name and refuses as claimed', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const logged: { event: string; detail: Record<string, unknown> }[] = []
    const fake = fakeBroker({
      view: () => {
        throw new Error('broker gone')
      },
    })

    const lines = await tick(fake, false, (event, detail) => logged.push({ event, detail }))

    expect(logged.filter(l => l.event === 'burndown_collision_reader_failed')).toEqual([
      { event: 'burndown_collision_reader_failed', detail: { reader: 'broker-view', repo: repo() } },
    ])
    expect(lines.join('\n')).toContain('refused demo DM-1 [claimed]: reader broker-view failed')
    expect(fake.frames).toEqual([])
  })

  it('refuses a task a live agent outside the ledger carries', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const fake = fakeBroker({ view: () => ({ names: ['hs-dm-1-by-hand'], claims: [] }) })

    const lines = await tick(fake)

    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('refused demo DM-1 [claimed]: live agent hs-dm-1-by-hand carries DM-1')
  })

  it('refuses a task whose claim finished this tick while its agent is still live', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const merging: Claim = {
      taskId: 'DM-1',
      initiative: 'demo',
      spawnedAt: NOON.toISOString(),
      phase: 'shepherding',
      phaseAt: NOON.toISOString(),
      agentName: 'bd-dm-1',
      spawned: ['bd-dm-1'],
      pr: 'https://github.com/demo/repo/pull/5',
    }
    writeLedger(burndownLedgerPath(), { version: 1, claims: [merging] })
    const merged = (args: string[]) =>
      args[1] === 'status'
        ? { status: 0, stdout: JSON.stringify([shepherdRow('post-merge')]) }
        : { status: 1, stdout: '' }
    const fake = fakeBroker({
      agents: [row('bd-dm-1', 'live')],
      view: () => ({ names: ['bd-dm-1'], claims: [] }),
    })

    const lines = await tick(fake, false, () => {}, stubGh(undefined, merged))

    expect(readLedger(burndownLedgerPath()).claims[0]?.phase).toBe('done')
    expect(fake.frames).toEqual([])
    expect(lines.join('\n')).toContain('refused demo DM-1 [claimed]: live agent bd-dm-1 carries DM-1')
  })

  it('logs a failed broker-view reader once per tick, not once per repo', async () => {
    const other = secondRepo()
    initiative({ 'DM-1': task('DM-1') })
    initiative({ 'OT-1': task('OT-1') }, { slug: 'other', at: other, rank: 2 })
    const logged: { event: string; detail: Record<string, unknown> }[] = []
    const fake = fakeBroker({
      view: () => {
        throw new Error('broker gone')
      },
    })

    await tick(fake, false, (event, detail) => logged.push({ event, detail }))

    expect(logged.filter(l => l.detail.reader === 'broker-view')).toHaveLength(1)
  })

  it('logs each opted-in initiative with no repo as skipping the collision check', async () => {
    write(
      path.join(world, 'aw', 'norepo', 'brief.md'),
      '---\ntitle: norepo\nstate: focused\nrank: 1\nprofile: agents\nautonomy:\n  mode: burndown\n  lanes: 1\n  accounts: [agents]\n  grants: []\n---\n# norepo\n',
    )
    const logged: { event: string; detail: Record<string, unknown> }[] = []

    await tick(fakeBroker(), false, (event, detail) => logged.push({ event, detail }))

    expect(logged.filter(l => l.event === 'burndown_collision_skipped')).toEqual([
      { event: 'burndown_collision_skipped', detail: { initiative: 'norepo', reason: 'no repo' } },
    ])
  })
})

describe('burndown tick when the retired roster read times out (CC-777)', () => {
  /** A broker whose includeRetired read never answers in time, while the live reads do. */
  const slowRetired = (live: AgentIdentity[]): BrokerClient =>
    ({
      request: async (frame: { t: string; includeRetired?: boolean }) => {
        if (frame.t === 'list') return { t: 'list_result', sessions: [], claims: [] }
        if (frame.includeRetired === true) throw new Error('broker did not answer agents_result')
        return { t: 'agents_result', agents: live, slots: { held: 4, cap: 36 } }
      },
    }) as unknown as BrokerClient

  const brokerOver = (client: BrokerClient): Fake => {
    const fake = fakeBroker()
    const real = tickBroker(client, fake.broker.seatSender)
    return { ...fake, broker: { ...fake.broker, roster: real.roster, collisionView: real.collisionView } }
  }

  it('dispatches free tasks and reports the partial roster instead of refusing them as claimed', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const fake = brokerOver(slowRetired([]))

    const lines = await tick(fake)

    expect(lines.join('\n')).not.toContain('[claimed]')
    expect(fake.frames.map(f => f.name)).toEqual(['bd-dm-1'])
    expect(lines).toContain('roster partial: retired rows unread (broker did not answer agents_result)')
  })

  it('leaves a held claim whose agent has no live row unread rather than gone', async () => {
    initiative({ 'DM-1': task('DM-1') })
    const held: Claim = {
      taskId: 'DM-1',
      initiative: 'demo',
      spawnedAt: NOON.toISOString(),
      phase: 'implementing',
      phaseAt: NOON.toISOString(),
      agentName: 'bd-dm-1',
      spawned: ['bd-dm-1'],
    }
    writeLedger(burndownLedgerPath(), { version: 1, claims: [held] })

    const lines = await tick(brokerOver(slowRetired([])))

    expect(lines.join('\n')).toContain('unread DM-1#: no live row for bd-dm-1 and retired rows unread')
    expect(readLedger(burndownLedgerPath()).claims[0]?.phase).toBe('implementing')
  })
})

describe('burndown tick finding on a silent agent', () => {
  const MIN = 60_000
  const liveWorker = () => ({ ...row('bd-dm-1', 'live'), sessionId: 'sess-dm-1' })
  const turn = (at: Date) =>
    `${JSON.stringify({ type: 'assistant', timestamp: at.toISOString(), message: { content: [{ type: 'text', text: 'working' }] } })}\n`

  it('logs one opened and one closed row across three ticks, and nothing for the refresh', async () => {
    const worker = liveWorker()
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [
        {
          taskId: 'DM-1',
          initiative: 'demo',
          agentId: worker.agentId,
          agentName: worker.name,
          spawned: [worker.name],
          spawnedAt: NOON.toISOString(),
          phase: 'implementing',
          phaseAt: NOON.toISOString(),
        },
      ],
    })
    const file = transcriptPath(worker.cwd, worker.sessionId, worker.configDir)
    write(file, turn(new Date(NOON.getTime() + MIN)))
    const events: string[] = []
    const log = (event: string, detail: Record<string, unknown>) => {
      if (event === 'burndown_finding') events.push(`${detail.state}`)
    }
    const tickAt = (offset: number) =>
      tickFromDisk({
        dryRun: false,
        broker: fakeBroker({ agents: [worker] }).broker,
        now: new Date(NOON.getTime() + offset * MIN),
        log,
        exec: stubGh(),
      })

    await tickAt(7)
    await tickAt(17)
    fs.appendFileSync(file, turn(new Date(NOON.getTime() + 18 * MIN)))
    await tickAt(19)

    expect(events).toEqual(['opened', 'closed'])
    expect(readLedger(burndownLedgerPath()).claims[0]?.finding).toBeUndefined()
  })

  it('logs no finding row when the ledger write that would open it fails', async () => {
    const blocker = path.join(world, 'not-a-dir')
    write(blocker, '')
    const claim: Claim = {
      taskId: 'DM-1',
      initiative: 'demo',
      spawnedAt: NOON.toISOString(),
      phase: 'implementing',
      phaseAt: NOON.toISOString(),
    }
    const finding: NonNullable<Claim['finding']> = {
      kind: 'stalled-after-claim',
      reason: 'idle',
      since: NOON.toISOString(),
      openedAt: NOON.toISOString(),
      checkedAt: NOON.toISOString(),
      detail: `idle: no agent event for 6 min since ${NOON.toISOString()}`,
    }
    const events: string[] = []

    const run = execute(
      [{ kind: 'ledger', actions: [{ kind: 'update', key: { taskId: 'DM-1' }, patch: { finding } }] }],
      { version: 1, claims: [claim] },
      {
        ledgerFile: path.join(blocker, 'ledger.json'),
        spawn: async () => ({ ok: true }),
        retire: async () => ({ ok: true }),
        register: () => ({ ok: true }),
        log: event => events.push(event),
        now: NOON,
      },
    )

    await expect(run).rejects.toThrow()
    expect(events).toEqual([])
  })

  it('tells the seat once per open finding, never on a channel delivery, and closes on progress', async () => {
    seatPolicy()
    config({ seats: ['seat-t'] })
    seatInitiative({ 'DM-1': seatTask('DM-1') })
    const worker = { ...row('st-dm-1', 'live'), sessionId: 'sess-st-dm-1' }
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [
        {
          taskId: 'DM-1',
          initiative: 'demo',
          seat: 'seat-t',
          namePrefix: 'st',
          agentId: worker.agentId,
          agentName: worker.name,
          spawned: [worker.name],
          spawnedAt: NOON.toISOString(),
          phase: 'implementing',
          phaseAt: NOON.toISOString(),
          notified: ['dispatched'],
        },
      ],
    })
    const file = transcriptPath(worker.cwd, worker.sessionId, worker.configDir)
    const lastWork = new Date(NOON.getTime() + MIN)
    write(file, turn(lastWork))
    const delivery = (at: Date) =>
      `${JSON.stringify({ type: 'user', timestamp: at.toISOString(), message: { role: 'user', content: '<channel source="agent-chat" from="peer">ping</channel>' } })}\n`
    const fake = fakeBroker({ agents: [worker] })
    const tickAt = async (offset: number) => {
      const sent = fake.sends.length
      await tickFromDisk({
        dryRun: false,
        broker: fake.broker,
        now: new Date(NOON.getTime() + offset * MIN),
        log: () => {},
        exec: stubGh(),
      })
      return { sends: fake.sends.slice(sent), claim: readLedger(burndownLedgerPath()).claims[0] }
    }

    const first = await tickAt(7)
    const second = await tickAt(17)
    fs.appendFileSync(file, delivery(new Date(NOON.getTime() + 18 * MIN)))
    const third = await tickAt(19)
    fs.appendFileSync(file, turn(new Date(NOON.getTime() + 20 * MIN)))
    const fourth = await tickAt(21)

    expect(first.sends).toEqual([
      {
        to: 'seat-t',
        text: `Burndown events for seat-t at ${new Date(NOON.getTime() + 7 * MIN).toISOString()}\nstalled-after-claim DM-1: no-progress: idle: no agent event for 6 min since ${lastWork.toISOString()}`,
      },
    ])
    expect(second.sends).toEqual([])
    expect(third.sends).toEqual([])
    expect(third.claim?.finding).toMatchObject({ reason: 'idle', since: lastWork.toISOString() })
    expect(fourth.claim?.finding).toBeUndefined()
    expect(fourth.claim?.notified).toEqual(['dispatched'])
  })
})

describe('burndown tick lease on an implementing seat claim (CC-659)', () => {
  const MIN = 60_000
  const turn = (at: Date) =>
    `${JSON.stringify({ type: 'assistant', timestamp: at.toISOString(), message: { content: [{ type: 'text', text: 'working' }] } })}\n`

  /** The pool gate reads a stale sample as closed, which would park the claim. */
  const freshPoolSample = (now: Date) => {
    const rate_limits = { seven_day: { used_percentage: 10 }, five_hour: { used_percentage: 10 } }
    write(
      path.join(accountPath(), 'status-cache', 'sessions', 's1.json'),
      JSON.stringify({ session_id: 's1', written_at: now.getTime() / 1000 - 30, rate_limits }),
    )
  }

  it('tells the seat once when the lease ends without a commit', async () => {
    seatPolicy()
    config({ seats: ['seat-t'] })
    seatInitiative({ 'DM-1': seatTask('DM-1') })
    const worker = { ...row('st-dm-1', 'live'), sessionId: 'sess-st-dm-1' }
    writeLedger(burndownLedgerPath(), {
      version: 1,
      claims: [
        {
          taskId: 'DM-1',
          initiative: 'demo',
          seat: 'seat-t',
          namePrefix: 'st',
          agentId: worker.agentId,
          agentName: worker.name,
          spawned: [worker.name],
          spawnedAt: NOON.toISOString(),
          phase: 'implementing',
          phaseAt: NOON.toISOString(),
          worktree: repo(),
          notified: ['dispatched'],
        },
      ],
    })
    const file = transcriptPath(worker.cwd, worker.sessionId, worker.configDir)
    const fake = fakeBroker({ agents: [worker] })
    const tickAt = async (offset: number) => {
      const now = new Date(NOON.getTime() + offset * MIN)
      fs.appendFileSync(file, turn(new Date(now.getTime() - MIN)))
      freshPoolSample(now)
      const sent = fake.sends.length
      await tickFromDisk({
        dryRun: false,
        broker: fake.broker,
        now,
        log: () => {},
        exec: stubGh(),
      })
      return { sends: fake.sends.slice(sent), claim: readLedger(burndownLedgerPath()).claims[0] }
    }
    write(file, '')

    const working = await tickAt(5)
    const expired = await tickAt(40)
    const later = await tickAt(50)

    expect(working.sends).toEqual([])
    expect(working.claim?.finding).toBeUndefined()
    expect(working.claim?.lease).toMatchObject({
      renewals: 0,
      leaseUntil: new Date(NOON.getTime() + 30 * MIN).toISOString(),
    })
    expect(expired.sends).toEqual([
      {
        to: 'seat-t',
        text: `Burndown events for seat-t at ${new Date(NOON.getTime() + 40 * MIN).toISOString()}\nstalled-after-claim DM-1: lease-expired: lease: no commit for 40 min since ${NOON.toISOString()}`,
      },
    ])
    expect(expired.claim?.finding).toMatchObject({ reason: 'lease', code: 'lease-expired' })
    expect(later.sends).toEqual([])
  })
})

describe('burndown tick triage jobs (CC-649)', () => {
  const TRIAGER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../profiles/triager.json')
  const ALL_TRIAGE = { stalled: 'triage', failed: 'triage' }
  const READY = { route: ALL_TRIAGE, triage: { account: 'agents' } }
  const at = (minutes: number) => new Date(NOON.getTime() + minutes * MINUTE)

  const stalledClaim = (taskId = 'DM-1', over: Partial<Claim> = {}): Claim => {
    const name = `st-${taskId.toLowerCase()}`
    return {
      taskId,
      initiative: 'demo',
      seat: 'seat-t',
      namePrefix: 'st',
      agentId: `id-${name}`,
      agentName: name,
      spawned: [name],
      spawnedAt: NOON.toISOString(),
      phase: 'implementing',
      phaseAt: NOON.toISOString(),
      stalledReason: 'no final report',
      stalledClass: 'failed',
      notified: ['dispatched'],
      ...over,
    }
  }

  /** Seats mode, the triager installed under the test home, and the claims already stalled. */
  function setup(extra: Record<string, unknown>, claims: Claim[] = [stalledClaim()]): AgentIdentity[] {
    seatPolicy()
    config({ seats: ['seat-t'], ...extra })
    seatInitiative(Object.fromEntries(claims.map(c => [c.taskId, seatTask(c.taskId)])))
    write(path.join(world, 'home', 'profiles', 'triager.json'), fs.readFileSync(TRIAGER, 'utf8'))
    writeLedger(burndownLedgerPath(), { version: 1, claims })
    return claims.map(c => row(c.agentName ?? '?', 'exited'))
  }

  const tickAt = (fake: Fake, minutes: number) =>
    tickFromDisk({ dryRun: false, broker: fake.broker, now: at(minutes), log: () => {}, exec: stubGh() })
  const triageFrames = (fake: Fake) => fake.frames.filter(f => f.tags.includes('triage'))
  const stalledLines = (fake: Fake) =>
    fake.sends.flatMap(s => s.text.split('\n').filter(l => l.startsWith('stalled ')))
  const claimOf = (taskId = 'DM-1') => readLedger(burndownLedgerPath()).claims.find(c => c.taskId === taskId)

  it('with the dial at its default sends the stall to the owner as before, and spawns nothing', async () => {
    const fake = fakeBroker({ agents: setup({}) })

    await tickAt(fake, 0)
    await tickAt(fake, 1)

    expect(fake.frames).toEqual([])
    expect(fake.sends.map(s => s.text)).toEqual([
      `Burndown events for seat-t at ${NOON.toISOString()}\nstalled DM-1: no final report`,
    ])
    expect(claimOf()?.triage).toBeUndefined()
  })

  it('starts one triager per stall across three ticks and tells the owner nothing while it runs', async () => {
    const agents = setup({ exceptions: READY })
    const fake = fakeBroker({ agents })

    const first = await tickAt(fake, 0)
    agents.push(row('triage-dm-1-1', 'live', path.join(world, 'aw')))
    await tickAt(fake, 1)
    await tickAt(fake, 2)

    expect(triageFrames(fake)).toEqual([
      expect.objectContaining({
        name: 'triage-dm-1-1',
        profile: 'triager',
        configDir: accountPath(),
        cwd: path.join(world, 'aw'),
        surface: 'headless',
        tags: ['burndown', 'triage', 'task:DM-1'],
        brief: expect.stringContaining('stalled: no final report'),
      }),
    ])
    expect(first.join('\n')).toContain('started triage triage-dm-1-1 for DM-1#')
    expect(stalledLines(fake)).toEqual([])
    expect(claimOf()?.triage).toMatchObject({ outcome: 'started', name: 'triage-dm-1-1' })
  })

  it('writes the start, the spawned name and the day count before the frame goes out', async () => {
    const agents = setup({ exceptions: READY })
    let seen: { claim: Claim | undefined; starts: string[] | undefined } = {
      claim: undefined,
      starts: undefined,
    }
    const fake = fakeBroker({
      agents,
      spawn: () => {
        const ledger = readLedger(burndownLedgerPath())
        seen = { claim: ledger.claims[0], starts: ledger.triageStarts }
        return { ok: true }
      },
    })

    await tickAt(fake, 0)

    expect(seen.claim?.triage).toMatchObject({ outcome: 'started', name: 'triage-dm-1-1' })
    expect(seen.claim?.spawned).toEqual(['st-dm-1', 'triage-dm-1-1'])
    expect(seen.starts).toEqual([NOON.toISOString()])
  })

  it('falls back to the owner this tick, with a note, when the dial says triage but nothing is configured', async () => {
    const fake = fakeBroker({ agents: setup({ exceptions: { route: ALL_TRIAGE } }) })

    const lines = await tickAt(fake, 0)

    expect(fake.frames).toEqual([])
    expect(stalledLines(fake)).toEqual(['stalled DM-1: no final report'])
    expect(lines).toContain(
      'triage of DM-1# falls back to the owner: triage is not ready: no exceptions.triage in the burndown config',
    )
  })

  it('tells the owner the same tick when the triage spawn is refused', async () => {
    const agents = setup({ exceptions: READY })
    const fake = fakeBroker({ agents, spawn: () => ({ ok: false, reason: 'no slot' }) })

    const lines = await tickAt(fake, 0)

    expect(triageFrames(fake)).toHaveLength(1)
    expect(stalledLines(fake)).toEqual(['stalled DM-1: no final report'])
    expect(claimOf()?.triage).toMatchObject({
      outcome: 'refused',
      detail: 'triage triage-dm-1-1 refused: no slot',
    })
    expect(lines).toContain('triage triage-dm-1-1 refused: no slot; the owner is told')
  })

  it('tells the owner once the triager exits with the claim still stalled, and never starts a second job', async () => {
    const agents = setup({ exceptions: READY })
    const fake = fakeBroker({ agents })

    await tickAt(fake, 0)
    agents.push(row('triage-dm-1-1', 'exited', path.join(world, 'aw')))
    await tickAt(fake, 1)
    await tickAt(fake, 2)
    await tickAt(fake, 3)

    expect(triageFrames(fake)).toHaveLength(1)
    expect(stalledLines(fake)).toEqual([
      'stalled DM-1: no final report (triage triage-dm-1-1 ran, claim still stalled)',
    ])
    expect(claimOf()?.triage?.outcome).toBe('ended')
  })

  it('tells the owner once a live triager runs past maxMinutes', async () => {
    const agents = setup({ exceptions: { route: ALL_TRIAGE, triage: { account: 'agents', maxMinutes: 30 } } })
    const fake = fakeBroker({ agents })

    await tickAt(fake, 0)
    agents.push(row('triage-dm-1-1', 'live', path.join(world, 'aw')))
    await tickAt(fake, 30)
    const before = stalledLines(fake)
    await tickAt(fake, 31)

    expect(before).toEqual([])
    expect(stalledLines(fake)).toEqual([
      'stalled DM-1: no final report (triage triage-dm-1-1 still running past maxMinutes 30, claim still stalled)',
    ])
  })

  it('raises nothing for a claim the triager released', async () => {
    const agents = setup({ exceptions: READY })
    const fake = fakeBroker({ agents })

    await tickAt(fake, 0)
    writeLedger(burndownLedgerPath(), { ...readLedger(burndownLedgerPath()), claims: [] })
    agents.push(row('triage-dm-1-1', 'exited', path.join(world, 'aw')))
    await tickAt(fake, 1)

    expect(stalledLines(fake)).toEqual([])
    expect(triageFrames(fake)).toHaveLength(1)
  })

  it('never triages a gate-trip, even with every dial at triage', async () => {
    const gate = stalledClaim('DM-1', {
      stalledClass: 'gate-trip',
      stalledReason: 'Shepherd refused demo/repo#5',
    })
    const fake = fakeBroker({ agents: setup({ exceptions: READY }, [gate]) })

    await tickAt(fake, 0)

    expect(fake.frames).toEqual([])
    expect(stalledLines(fake)).toEqual(['stalled DM-1: Shepherd refused demo/repo#5'])
  })

  it('starts one job under maxPerDay 1 and sends the second stall to the owner with a cap note', async () => {
    const claims = [stalledClaim('DM-1'), stalledClaim('DM-2')]
    const exceptions = { route: ALL_TRIAGE, triage: { account: 'agents', maxPerDay: 1 } }
    const fake = fakeBroker({ agents: setup({ exceptions }, claims) })

    const lines = await tickAt(fake, 0)

    expect(triageFrames(fake).map(f => f.name)).toEqual(['triage-dm-1-1'])
    expect(stalledLines(fake)).toEqual(['stalled DM-2: no final report'])
    expect(lines).toContain(
      'triage of DM-2# falls back to the owner: triage day cap spent (1 of maxPerDay 1)',
    )
  })

  it('waits without a seat event while maxAgents is full, then tells the owner past maxMinutes', async () => {
    const agents = setup({ maxAgents: 1, exceptions: READY })
    agents.splice(0, agents.length, row('st-dm-1', 'live'))
    const fake = fakeBroker({ agents })

    const waiting = await tickAt(fake, 0)
    await tickAt(fake, 29)
    const before = stalledLines(fake)
    const late = await tickAt(fake, 31)

    expect(triageFrames(fake)).toEqual([])
    expect(before).toEqual([])
    expect(waiting.join('\n')).toContain('triage of DM-1# waits: no agent capacity')
    expect(stalledLines(fake)).toEqual(['stalled DM-1: no final report'])
    expect(late).toContain(
      'triage of DM-1# falls back to the owner: no agent capacity for triage in maxMinutes 30',
    )
  })

  it('shows the class, route and triage outcome on the status line', async () => {
    const fake = fakeBroker({ agents: setup({ exceptions: READY }) })
    await tickAt(fake, 0)

    const lines = renderStatus(readLedger(burndownLedgerPath()), at(1))

    expect(lines.join('\n')).toContain('STALLED (class failed, route triage, triage triage-dm-1-1 started)')
  })

  /** CC-651: a live, silent worker whose transcript last moved one minute past noon, so a finding opens at +7. */
  function silentWorker(exceptions: Record<string, unknown>) {
    const claim = stalledClaim('DM-1', { stalledReason: undefined, stalledClass: undefined })
    setup({ exceptions }, [claim])
    const worker = { ...row('st-dm-1', 'live'), sessionId: 'sess-st-dm-1' }
    const file = transcriptPath(worker.cwd, worker.sessionId, worker.configDir)
    const lastWork = at(1)
    write(file, turn(lastWork))
    return { agents: [worker], file, lastWork }
  }
  const turn = (when: Date) =>
    `${JSON.stringify({ type: 'assistant', timestamp: when.toISOString(), message: { content: [{ type: 'text', text: 'working' }] } })}\n`
  const findingLines = (fake: Fake) =>
    fake.sends.flatMap(s => s.text.split('\n').filter(l => l.startsWith('stalled-after-claim ')))

  it('triages a finding once under its id, through refreshes, and tells no one when it closes mid-job', async () => {
    const { agents, file } = silentWorker(READY)
    const fake = fakeBroker({ agents })

    await tickAt(fake, 7)
    const openedAt = claimOf()?.finding?.openedAt
    await tickAt(fake, 8)
    agents.push(row('triage-dm-1-1', 'live', path.join(world, 'aw')))
    await tickAt(fake, 17)
    const status = renderStatus(readLedger(burndownLedgerPath()), at(17))
    fs.appendFileSync(file, turn(at(18)))
    await tickAt(fake, 19)
    agents[1] = row('triage-dm-1-1', 'exited', path.join(world, 'aw'))
    await tickAt(fake, 21)

    expect(openedAt).toBe(at(7).toISOString())
    expect(triageFrames(fake)).toEqual([
      expect.objectContaining({
        name: 'triage-dm-1-1',
        brief: expect.stringMatching(/class: stalled\nfinding: no-progress: idle/),
      }),
    ])
    expect(status.join('\n')).toContain(
      '(class stalled, route triage, triage triage-dm-1-1 started) FINDING stalled-after-claim',
    )
    expect(findingLines(fake)).toEqual([])
    expect(claimOf()?.finding).toBeUndefined()
    expect(claimOf()?.triage).toBeUndefined()
  })

  it('tells the owner of a finding whose triager exits with it still open, once', async () => {
    const { agents, lastWork } = silentWorker(READY)
    const fake = fakeBroker({ agents })

    await tickAt(fake, 7)
    await tickAt(fake, 8)
    agents.push(row('triage-dm-1-1', 'exited', path.join(world, 'aw')))
    await tickAt(fake, 9)
    await tickAt(fake, 10)

    expect(triageFrames(fake)).toHaveLength(1)
    expect(findingLines(fake)).toEqual([
      `stalled-after-claim DM-1: no-progress: idle: no agent event for 8 min since ${lastWork.toISOString()}`,
    ])
  })

  it('with the dial at owner delivers a finding exactly as before, even with triage configured', async () => {
    const { agents, lastWork } = silentWorker({ triage: { account: 'agents' } })
    const fake = fakeBroker({ agents })

    await tickAt(fake, 7)

    expect(fake.frames).toEqual([])
    expect(fake.sends).toEqual([
      {
        to: 'seat-t',
        text: `Burndown events for seat-t at ${at(7).toISOString()}\nstalled-after-claim DM-1: no-progress: idle: no agent event for 6 min since ${lastWork.toISOString()}`,
      },
    ])
  })
})
