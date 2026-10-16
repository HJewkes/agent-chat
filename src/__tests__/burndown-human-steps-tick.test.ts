import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run, type Runner } from '../agents/burndown/exec.js'
import type { SpawnFrame } from '../agents/burndown/execute.js'
import { tickFromDisk, type TickBroker } from '../agents/burndown/run-tick.js'
import { TRUST_RULE_BASELINE_CLI_VERSION } from '../agents/trust.js'
import { readSpool, writeAnswer } from '@titan-design/owner-queue/spool'

/**
 * CC-974: the live seats-mode tick files a due kind:owner step in the seat's scope into the real spool, once. A step
 * tagged into the other seat's lane of a shared initiative, or one whose dep is open, is not filed, and an answered
 * item is neither re-filed nor reported as routed while the task stays open. `git` runs for real.
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
const spool = (): string => path.join(world, 'spool')

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

const taskText = (id: string, status: string, tags: string[]): string =>
  `id: ${id}\ntitle: Do ${id}\nstatus: ${status}\ndone_when: the owner has done it\ntags:\n${tags.map(t => `  - ${t}\n`).join('')}`

const seatFile = (lane: string): string =>
  `---\nprefix: s${lane}\npool: pool-t\ninitiatives: {demo: 1.0}\nscope_tags: [lane-${lane}]\nrepos:\n  - {path: ${repo()}, initiatives: [demo]}\nconcurrency: {implementers: 2, reviewers: 1, planners: 1}\n---\n`

/** Two seats share `demo`, so each seat's `scope_tags` narrow it; the tick runs seat-t alone. */
function seatWorld(): void {
  const pool = `pool-t: {config_dir: ${accountPath()}, human_uses: false, reserve_seven_day: 30, ceiling_five_hour: 75}`
  write(
    path.join(autonomyRoot(), 'charter.md'),
    `---\nseats: [seat-t, seat-u]\n${DEFAULTS}\npools:\n  ${pool}\n---\n`,
  )
  write(path.join(autonomyRoot(), 'seats', 'seat-t.md'), seatFile('a'))
  write(path.join(autonomyRoot(), 'seats', 'seat-u.md'), seatFile('b'))
  write(path.join(world, 'aw', 'demo', 'brief.md'), '---\ntitle: demo\nstate: focused\n---\n# demo\n')
  task('T-0', taskText('T-0', 'done', ['lane-a']))
  task('T-9', taskText('T-9', 'open', ['lane-a']))
  task('H-1', taskText('H-1', 'open', ['kind:owner', 'dep:T-0', 'lane-a']))
  task('H-2', taskText('H-2', 'open', ['kind:operator', 'dep:T-0', 'lane-b']))
  task('H-3', taskText('H-3', 'open', ['kind:owner', 'dep:T-9', 'lane-a']))
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

async function tick(minutes: number): Promise<string[]> {
  return tickFromDisk({
    dryRun: false,
    broker: fakeBroker(4).broker,
    now: later(minutes),
    log: () => {},
    exec: factory(null),
    ownerQueueDir: spool(),
  })
}

/** Human-step items only: the seat has nothing to dispatch, so its second tick also files scope-exhausted. */
const filed = async () =>
  (await readSpool(spool())).items.filter(i => i.keys.some(k => k.startsWith('human-step:')))
const routedLines = (lines: string[]): string[] => lines.filter(l => l.startsWith('routed human step'))

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-human-steps-')))
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

describe('human steps in the live tick', () => {
  it('files the due step in the seat lane alone, keyed human-step:<id>', async () => {
    const lines = await tick(0)

    const items = await filed()
    expect(items.map(i => i.keys)).toEqual([['human-step:H-1']])
    expect(items[0]).toMatchObject({ seat: 'seat-t', initiative: 'demo', kind: 'do' })
    expect(routedLines(lines)).toEqual(['routed human step H-1 to the owner queue'])
  })

  it('files nothing more and reports nothing routed on a second tick while the item is open', async () => {
    await tick(0)

    const lines = await tick(10)

    expect(await filed()).toHaveLength(1)
    expect(routedLines(lines)).toEqual([])
  })

  it('reports nothing routed once the item is answered and the task stays open', async () => {
    await tick(0)
    const [item] = await filed()
    await writeAnswer(spool(), item!.id, {
      optionId: 'done',
      by: { class: 'owner', id: 'owner', channel: 'test' },
      at: later(5).toISOString(),
    })

    const lines = await tick(10)

    expect(await filed()).toHaveLength(1)
    expect(routedLines(lines)).toEqual([])
  })

  it('files the waiting step on the tick after its dep is done', async () => {
    await tick(0)
    task('T-9', taskText('T-9', 'done', ['lane-a']))

    const lines = await tick(10)

    expect(routedLines(lines)).toEqual(['routed human step H-3 to the owner queue'])
    expect((await filed()).flatMap(i => i.keys).sort()).toEqual(['human-step:H-1', 'human-step:H-3'])
  })
})
