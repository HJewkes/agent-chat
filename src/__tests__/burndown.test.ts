import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseAutonomy } from '../agents/active-work.js'
import { readAccountBudget } from '../agents/budget.js'
import { gateAccount, MAX_READING_AGE_SECONDS } from '../agents/burndown/budget-gate.js'
import { collisionCheck, type BrokerView } from '../agents/burndown/collision.js'
import { grantGap } from '../agents/burndown/eligibility.js'
import type { Runner } from '../agents/burndown/exec.js'
import {
  addClaim,
  EMPTY_LEDGER,
  isStalled,
  readLedger,
  withLedgerLock,
  writeLedger,
  type Claim,
} from '../agents/burndown/ledger.js'
import { planFromDisk, renderPlan } from '../agents/burndown/tick.js'
import { TRUST_RULE_CLI_VERSION } from '../agents/trust.js'
import { BrokerClient } from '../client/broker-client.js'
import { withBroker } from '../cli/client.js'
import { burndownPlanVerb } from '../cli/verbs/burndown.js'

/**
 * The dry-run tick over a fixture world: an active-work root, a profile root
 * with one account's status cache and trust file, and an agent-chat home.
 * Nothing here reads the developer's real sessions, briefs or ledger.
 */

let world: string
const saved = { ...process.env }
const NOON = new Date(2026, 8, 26, 12, 0)

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const brief = (autonomy: string): string =>
  `---\ntitle: Demo\nstate: focused\nrank: 1\nprofile: agents\n${autonomy}---\n# Demo\n`

const OPTED_IN = 'autonomy:\n  mode: burndown\n  lanes: 1\n  accounts: [agents]\n  grants: []\n  repo: REPO\n'

const task = (id: string, extra = ''): string =>
  `id: ${id}\ntitle: Do ${id}\npriority: 3\nestimate: 1\ndone_when: unit tests cover the new branch\nstatus: open\ntags:\n  - agent-chat\n${extra}`

function account(name: string, usage: { seven_day: number; five_hour: number }, trusted: string[]): void {
  const dir = path.join(world, 'profiles', name)
  const rate_limits = {
    seven_day: { used_percentage: usage.seven_day },
    five_hour: { used_percentage: usage.five_hour },
  }
  write(
    path.join(dir, 'status-cache', 'sessions', 's1.json'),
    JSON.stringify({ session_id: 's1', written_at: NOON.getTime() / 1000 - 30, rate_limits }),
  )
  const projects = Object.fromEntries(trusted.map(p => [p, { hasTrustDialogAccepted: true }]))
  write(path.join(dir, '.claude.json'), JSON.stringify({ projects }))
}

const repo = (): string => path.join(world, 'repo')

/** Points `AGENT_CHAT_CLAUDE` at a symlink into `versions/<name>`, the shape of a native install. */
function installClaude(version: string): void {
  const target = path.join(world, 'claude', 'versions', version)
  write(target, '')
  fs.chmodSync(target, 0o755)
  const link = path.join(world, 'bin', 'claude')
  fs.rmSync(link, { force: true })
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(target, link)
  process.env.AGENT_CHAT_CLAUDE = link
}

function initiative(slug: string, autonomy: string, tasks: Record<string, string>): void {
  write(path.join(world, 'aw', slug, 'brief.md'), brief(autonomy.replace('REPO', repo())))
  for (const [id, text] of Object.entries(tasks))
    write(path.join(world, 'aw', slug, 'tasks', `${id}.yml`), text)
}

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-burndown-')))
  process.env.AGENT_CHAT_HOME = path.join(world, 'home')
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(world, 'aw')
  process.env.CLAUDE_PROFILE_ROOT = path.join(world, 'profiles')
  delete process.env.AGENT_CHAT_STATUS_CACHE
  fs.mkdirSync(path.join(repo(), '.git'), { recursive: true })
  installClaude(TRUST_RULE_CLI_VERSION)
})

afterEach(() => {
  process.env = { ...saved }
  fs.rmSync(world, { recursive: true, force: true })
})

describe('burndown plan', () => {
  it('dispatches an eligible task into a worktree under a trusted repo', () => {
    initiative('demo', OPTED_IN, { 'DM-1': task('DM-1') })
    account('agents', { seven_day: 40, five_hour: 10 }, [repo()])

    const result = planFromDisk(NOON)

    expect(result.refusals).toEqual([])
    expect(result.dispatch).toEqual([
      expect.objectContaining({
        initiative: 'demo',
        task: 'DM-1',
        profile: 'bd-implementer-lite',
        account: 'agents',
        cwd: path.join(repo(), '.worktrees', 'bd-dm-1'),
      }),
    ])
  })

  it('refuses a task when the only account is inside its seven-day reserve', () => {
    initiative('demo', OPTED_IN, { 'DM-1': task('DM-1') })
    account('agents', { seven_day: 80, five_hour: 10 }, [repo()])

    const result = planFromDisk(NOON)

    expect(result.dispatch).toEqual([])
    expect(result.refusals).toEqual([
      expect.objectContaining({
        task: 'DM-1',
        kind: 'budget',
        reason: expect.stringContaining('inside the reserve'),
      }),
    ])
  })

  it('refuses a task whose worktree would land outside any trusted folder on the account', () => {
    initiative('demo', OPTED_IN, { 'DM-1': task('DM-1') })
    account('agents', { seven_day: 40, five_hour: 10 }, [path.join(world, 'some-other-repo')])

    const result = planFromDisk(NOON)

    expect(result.dispatch).toEqual([])
    expect(result.refusals).toEqual([
      expect.objectContaining({
        task: 'DM-1',
        kind: 'trust',
        reason: expect.stringContaining('no accepted trust entry'),
      }),
    ])
  })

  // Claude Code 2.1.284 bundle, minified hS/yS: the ancestor walk stops at the cwd's git root, and a worktree is its own.
  it('refuses a worktree when only a folder above the repo is trusted, per CLI 2.1.284 hS/yS', () => {
    initiative('demo', OPTED_IN, { 'DM-1': task('DM-1') })
    account('agents', { seven_day: 40, five_hour: 10 }, [world])

    const result = planFromDisk(NOON)

    expect(result.dispatch).toEqual([])
    expect(result.refusals).toEqual([
      expect.objectContaining({
        task: 'DM-1',
        kind: 'trust',
        reason: expect.stringContaining('no accepted trust entry'),
      }),
    ])
  })

  // Claude Code 2.1.284 bundle, minified VRe/Qt: a linked worktree's config key is its main checkout.
  it('trusts a worktree cut from a linked worktree whose main checkout is trusted, per CLI 2.1.284 VRe/Qt', () => {
    const main = path.join(world, 'main')
    const linked = path.join(world, 'linked')
    const gitDir = path.join(main, '.git', 'worktrees', 'linked')
    write(path.join(gitDir, 'commondir'), '../..\n')
    write(path.join(gitDir, 'gitdir'), `${path.join(linked, '.git')}\n`)
    write(path.join(linked, '.git'), `gitdir: ${gitDir}\n`)
    initiative('demo', OPTED_IN.replace('REPO', linked), { 'DM-1': task('DM-1') })
    account('agents', { seven_day: 40, five_hour: 10 }, [main])

    const result = planFromDisk(NOON)

    expect(result.refusals).toEqual([])
    expect(result.dispatch.map(d => d.cwd)).toEqual([path.join(linked, '.worktrees', 'bd-dm-1')])
  })

  it.each([
    ['a different release', '2.1.285', 'differs from'],
    ['no readable version', 'claude', 'cannot determine'],
  ])('refuses on trust when the installed CLI has %s, even under a trusted repo', (_, installed, reason) => {
    installClaude(installed)
    initiative('demo', OPTED_IN, { 'DM-1': task('DM-1') })
    account('agents', { seven_day: 40, five_hour: 10 }, [repo()])

    const result = planFromDisk(NOON)

    expect(result.dispatch).toEqual([])
    expect(result.refusals).toEqual([
      expect.objectContaining({ task: 'DM-1', kind: 'trust', reason: expect.stringContaining(reason) }),
    ])
  })

  it('skips reserved, unestimated and claimed tasks and picks the eligible one', () => {
    initiative('demo', OPTED_IN.replace('lanes: 1', 'lanes: 2'), {
      'DM-1': task('DM-1').replace('  - agent-chat', '  - human-only'),
      'DM-2': task('DM-2').replace('estimate: 1\n', ''),
      'DM-3': task('DM-3'),
      'DM-4': task('DM-4'),
    })
    account('agents', { seven_day: 40, five_hour: 10 }, [repo()])
    const claim: Claim = {
      taskId: 'DM-3',
      initiative: 'demo',
      agentId: 'a1',
      spawnedAt: NOON.toISOString(),
      phase: 'implementing',
      phaseAt: NOON.toISOString(),
    }
    writeLedger(path.join(world, 'home', 'burndown.json'), addClaim(EMPTY_LEDGER, claim))

    const result = planFromDisk(NOON)

    expect(result.dispatch.map(d => d.task)).toEqual(['DM-4'])
    expect(result.refusals.map(r => [r.task, r.kind])).toEqual(
      expect.arrayContaining([
        ['DM-1', 'reserved-tag'],
        ['DM-2', 'no-estimate'],
        ['DM-3', 'claimed'],
      ]),
    )
  })

  it('dispatches a planner into the repo itself and an implementer into its own worktree', () => {
    initiative('demo', OPTED_IN.replace('lanes: 1', 'lanes: 2'), {
      'DM-1': task('DM-1').replace('estimate: 1', 'estimate: 3'),
    })
    initiative('other', OPTED_IN, { 'OT-1': task('OT-1').replace('estimate: 1', 'estimate: 2') })
    account('agents', { seven_day: 40, five_hour: 10 }, [repo()])

    const result = planFromDisk(NOON)

    expect(result.dispatch.map(d => [d.task, d.profile, d.cwd])).toEqual(
      expect.arrayContaining([
        ['DM-1', 'bd-planner', repo()],
        ['OT-1', 'bd-implementer', path.join(repo(), '.worktrees', 'bd-ot-1')],
      ]),
    )
  })

  it('does not count parked or awaiting-merge claims against the lanes', () => {
    initiative('demo', OPTED_IN, { 'DM-1': task('DM-1'), 'DM-2': task('DM-2'), 'DM-3': task('DM-3') })
    account('agents', { seven_day: 40, five_hour: 10 }, [repo()])
    const held = (taskId: string, phase: Claim['phase']): Claim => ({
      taskId,
      initiative: 'demo',
      agentId: taskId,
      spawnedAt: NOON.toISOString(),
      phase,
      phaseAt: NOON.toISOString(),
    })
    const ledger = { ...EMPTY_LEDGER, claims: [held('DM-1', 'parked'), held('DM-2', 'awaiting-merge')] }
    writeLedger(path.join(world, 'home', 'burndown.json'), ledger)

    const result = planFromDisk(NOON)

    expect(result.dispatch.map(d => d.task)).toEqual(['DM-3'])
  })

  it('never reads an initiative without an autonomy block', () => {
    initiative('demo', '', { 'DM-1': task('DM-1') })
    account('agents', { seven_day: 40, five_hour: 10 }, [repo()])

    const result = planFromDisk(NOON)

    expect(result).toEqual({ dispatch: [], refusals: [], notOptedIn: ['demo'] })
  })

  it('prints the unscored plan unchanged when neither --seat nor --scored is passed (CC-230)', async () => {
    initiative('demo', '', { 'DM-1': task('DM-1') })
    vi.useFakeTimers({ toFake: ['Date'], now: NOON })
    const connect = vi.spyOn(BrokerClient.prototype, 'connect').mockRejectedValue(new Error('no broker'))

    try {
      const report = await burndownPlanVerb.run({}, { warnings: [], format: 'human', withBroker })

      expect(report).toEqual({
        ok: true,
        lines: [
          `burndown plan at ${NOON.toISOString()} (dry run: nothing spawned, nothing claimed)`,
          'would dispatch: nothing',
          'not opted in (1 focused, no autonomy.mode: burndown): demo',
        ],
      })
    } finally {
      connect.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('burndown plan collision check (CC-202)', () => {
  interface Seen {
    subjects?: string[]
    prs?: { number: number; title: string; branch: string; body: string }[]
    files?: string[]
  }
  /** `git` and `gh` as the check calls them; `origin/HEAD` is unset, so the default branch is main. */
  const stub =
    (seen: Seen): Runner =>
    (bin, args) => {
      if (bin === 'gh' && args.some(a => a.includes('/files')))
        return { status: 0, stdout: (seen.files ?? []).join('\n') }
      if (bin === 'gh') return { status: 0, stdout: (seen.prs ?? []).map(p => JSON.stringify(p)).join('\n') }
      if (args[0] === 'fetch') return { status: 0, stdout: '' }
      if (args[0] === 'log') return { status: 0, stdout: (seen.subjects ?? []).join('\n') }
      return { status: 1, stdout: '' }
    }
  const noBroker: BrokerView = { names: [], claims: [] }
  const planWith = (seen: Seen, broker: BrokerView = noBroker) =>
    planFromDisk(NOON, undefined, ledger => collisionCheck(ledger, broker, stub(seen)))
  const pr = { number: 9, title: 'Unrelated', branch: 'feat/unrelated', body: '' }

  beforeEach(() => {
    initiative('demo', OPTED_IN, {
      'DM-1': task('DM-1'),
      'DM-2': task('DM-2').replace('priority: 3', 'priority: 4'),
    })
    account('agents', { seven_day: 40, five_hour: 10 }, [repo()])
  })

  it('refuses a task a default-branch subject names as landed and dispatches the next', () => {
    const result = planWith({ subjects: ['Ship DM-1 (#4)', 'Mention DM-10 in passing'] })

    expect(result.dispatch.map(d => d.task)).toEqual(['DM-2'])
    expect(renderPlan(result, NOON)).toContain(
      'refused demo DM-1 [landed]: "Ship DM-1 (#4)" is on the default branch; reconcile it, then tag it reconciled',
    )
  })

  it('refuses a task an open PR names as open-pr', () => {
    const result = planWith({ prs: [{ ...pr, body: 'Implements DM-1.' }] })

    expect(result.dispatch.map(d => d.task)).toEqual(['DM-2'])
    expect(result.refusals).toEqual([expect.objectContaining({ task: 'DM-1', kind: 'open-pr' })])
  })

  it("refuses a task a live agent's name carries as claimed", () => {
    const result = planWith({}, { names: ['hs-dm-1-collision-check'], claims: [] })

    expect(result.dispatch.map(d => d.task)).toEqual(['DM-2'])
    expect(result.refusals).toEqual([
      expect.objectContaining({
        task: 'DM-1',
        kind: 'claimed',
        reason: 'live agent hs-dm-1-collision-check carries DM-1',
      }),
    ])
  })

  const sliceClaim = (slice: string, over: Partial<Claim> = {}): Claim => ({
    taskId: 'DM-1',
    initiative: 'demo',
    spawnedAt: NOON.toISOString(),
    phase: 'queued',
    phaseAt: NOON.toISOString(),
    slice,
    ...over,
  })
  const ledgerOf = (...claims: Claim[]): void => {
    writeLedger(
      path.join(world, 'home', 'burndown.json'),
      claims.reduce((l, c) => addClaim(l, c), EMPTY_LEDGER),
    )
  }

  it('dispatches slice b after slice a landed under the parent id', () => {
    ledgerOf(
      sliceClaim('a', { phase: 'done', spawned: ['bd-dm-1-a'] }),
      sliceClaim('b', { dependsOn: ['a'] }),
    )

    const result = planWith({ subjects: ['Ship the scorer (DM-1) (#190)'] })

    expect(result.dispatch).toEqual([expect.objectContaining({ task: 'DM-1', slice: 'b' })])
  })

  it("names a ready slice's implementer and worktree with its claim's seat prefix", () => {
    ledgerOf(sliceClaim('b', { seat: 'seat-a', namePrefix: 'tc' }))

    const result = planWith({})

    expect(result.dispatch).toEqual([
      expect.objectContaining({
        slice: 'b',
        agentName: 'tc-dm-1-b',
        worktree: path.join(repo(), '.worktrees', 'tc-dm-1-b'),
        seat: 'seat-a',
        namePrefix: 'tc',
      }),
    ])
  })

  it("lets a ready slice past its held sibling's open PR and live agent", () => {
    ledgerOf(
      sliceClaim('a', { phase: 'awaiting-merge', agentName: 'bd-dm-1-a', spawned: ['bd-dm-1-a'] }),
      sliceClaim('b'),
    )

    const result = planWith(
      { prs: [{ ...pr, branch: 'agent-chat/bd-dm-1-a', title: 'Slice a (DM-1)' }] },
      { names: ['bd-dm-1-a'], claims: [] },
    )

    expect(result.dispatch).toEqual([expect.objectContaining({ task: 'DM-1', slice: 'b' })])
  })

  it.each([
    [
      'open PR',
      { prs: [{ ...pr, branch: 'agent-chat/bd-dm-1', title: 'Old try (DM-1)' }] },
      noBroker,
      'open-pr',
    ],
    ['live agent', {}, { names: ['bd-dm-1'], claims: [] }, 'claimed'],
  ])("refuses a re-pick while a done claim's %s is still out", (_, seen, broker, kind) => {
    ledgerOf({
      ...sliceClaim('x'),
      slice: undefined,
      phase: 'done',
      agentName: 'bd-dm-1',
      spawned: ['bd-dm-1'],
    })

    const result = planWith(seen, broker)

    expect(result.dispatch.map(d => d.task)).toEqual(['DM-2'])
    expect(result.refusals).toEqual([expect.objectContaining({ task: 'DM-1', kind })])
  })

  it('names the failed reader in the refusal', () => {
    const failing: Runner = bin => ({ status: bin === 'gh' ? 1 : 0, stdout: '' })

    const result = planFromDisk(NOON, undefined, ledger => collisionCheck(ledger, noBroker, failing))

    expect(result.refusals.map(r => r.reason)).toEqual([
      expect.stringContaining('reader gh-pulls failed'),
      expect.stringContaining('reader gh-pulls failed'),
    ])
  })

  it('refuses a ready slice whose declared files an open PR touches as file-overlap', () => {
    const slice: Claim = {
      taskId: 'DM-1',
      initiative: 'demo',
      spawnedAt: NOON.toISOString(),
      phase: 'queued',
      phaseAt: NOON.toISOString(),
      slice: 'a',
      owns: ['src/cli/**'],
    }
    writeLedger(path.join(world, 'home', 'burndown.json'), addClaim(EMPTY_LEDGER, slice))

    const result = planWith({ prs: [pr], files: ['src/cli/index.ts'] })

    expect(result.dispatch).toEqual([])
    expect(result.refusals).toEqual([
      expect.objectContaining({ task: 'DM-1', kind: 'file-overlap', reason: '#9 touches src/cli/**' }),
    ])
  })
})

describe('autonomy frontmatter', () => {
  it('reads block lists and ignores trailing comments', () => {
    const text = brief(
      'autonomy:\n  mode: burndown  # opted in\n  accounts:\n    - agents\n    - personal\n  grants: [merge-on-green-approve]\n',
    )

    expect(parseAutonomy(text)).toEqual({
      mode: 'burndown',
      lanes: 1,
      accounts: ['agents', 'personal'],
      grants: ['merge-on-green-approve'],
    })
  })

  it('treats any other mode as not opted in', () => {
    expect(parseAutonomy(brief('autonomy:\n  mode: manual\n'))).toBeUndefined()
  })
})

describe('grant keywords', () => {
  it('sends a merge to the backlog without the merge grant and passes it with one', () => {
    expect(grantGap('PR merged to main', [])).toContain('merge-on-green-approve')
    expect(grantGap('PR merged to main', ['merge-on-green-approve'])).toBeUndefined()
  })

  it('never lets a grant unlock a broker restart', () => {
    expect(grantGap('shipped in a planned restart window', ['merge-on-green-approve'])).toContain(
      'human-only',
    )
  })
})

describe('budget gate', () => {
  const rule = { reserve_seven_day: 25, ceiling_five_hour: 70, night: { reserve_seven_day: 10 } }
  const reading = { sevenDay: 80, fiveHour: 10, ageSeconds: 5 }
  const night = new Date(2026, 8, 26, 2, 0)

  it('lowers the reserve at night only when the human has been gone half an hour', () => {
    const away = gateAccount('agents', rule, reading, {
      now: night,
      humanLastTurnAt: night.getTime() - 3_600_000,
    })
    const unknown = gateAccount('agents', rule, reading, { now: night })

    expect(away.open).toBe(true)
    expect(unknown.open).toBe(false)
  })

  it('stays closed with no reading rather than assuming zero usage', () => {
    expect(gateAccount('agents', rule, undefined, { now: NOON }).open).toBe(false)
  })

  it('closes on a reading older than the staleness limit and names its age', () => {
    const stale = { sevenDay: 10, fiveHour: 10, ageSeconds: MAX_READING_AGE_SECONDS + 1 }

    const result = gateAccount('agents', rule, stale, { now: NOON, humanLastTurnAt: 0 })

    expect(result.open).toBe(false)
    expect(result.reason).toContain(`${MAX_READING_AGE_SECONDS + 1}s old`)
  })

  it('lets a stale reading through when the caller sets an infinite max age', () => {
    const stale = { sevenDay: 10, fiveHour: 10, ageSeconds: MAX_READING_AGE_SECONDS * 100 }
    const ctx = { now: NOON, humanLastTurnAt: 0 }

    const result = gateAccount('agents', rule, stale, ctx, { maxReadingAgeSeconds: Number.POSITIVE_INFINITY })

    expect(result.open).toBe(true)
  })

  it.each([Number.NaN, undefined])('closes on a reading whose age is %s', age => {
    const unaged = { sevenDay: 10, fiveHour: 10, ageSeconds: age as number }

    const result = gateAccount('agents', rule, unaged, { now: NOON, humanLastTurnAt: 0 })

    expect(result.open).toBe(false)
    expect(result.reason).toContain('no age')
  })

  it('opens on a reading with no age when the caller sets an infinite max age', () => {
    const unaged = { sevenDay: 10, fiveHour: 10, ageSeconds: Number.NaN }
    const ctx = { now: NOON, humanLastTurnAt: 0 }

    const result = gateAccount('agents', rule, unaged, ctx, {
      maxReadingAgeSeconds: Number.POSITIVE_INFINITY,
    })

    expect(result.open).toBe(true)
  })

  it('opens on a reading exactly at the staleness limit', () => {
    const fresh = { sevenDay: 10, fiveHour: 10, ageSeconds: MAX_READING_AGE_SECONDS }

    expect(gateAccount('agents', rule, fresh, { now: NOON, humanLastTurnAt: 0 }).open).toBe(true)
  })
})

describe('account budget', () => {
  it('takes the freshest session reading under the config dir', () => {
    const dir = path.join(world, 'acct')
    const at = (id: string, writtenAt: number, sevenDay: number): void =>
      write(
        path.join(dir, 'status-cache', 'sessions', `${id}.json`),
        JSON.stringify({
          session_id: id,
          written_at: writtenAt,
          rate_limits: { seven_day: { used_percentage: sevenDay } },
        }),
      )
    at('old', 1_000, 10)
    at('new', 2_000, 55)

    const read = readAccountBudget(dir, 2_100_000)

    expect(read.found && read.budget.rate_limits.seven_day?.used_pct).toBe(55)
  })
})

describe('claim ledger', () => {
  const claim: Claim = {
    taskId: 'DM-1',
    initiative: 'demo',
    agentId: 'a1',
    spawnedAt: '2026-09-26T08:00:00.000Z',
    phase: 'implementing',
    phaseAt: '2026-09-26T08:00:00.000Z',
  }

  it('round-trips through an atomic write and refuses a second claim on a held task', () => {
    const file = path.join(world, 'home', 'burndown.json')
    writeLedger(file, addClaim(EMPTY_LEDGER, claim))

    const read = readLedger(file)

    expect(read.claims).toEqual([claim])
    expect(() => addClaim(read, claim)).toThrow('already claimed')
  })

  it('holds one claim per slice of a task and refuses the same slice twice', () => {
    const a = { ...claim, slice: 'a' }
    const ledger = addClaim(addClaim(EMPTY_LEDGER, a), { ...claim, slice: 'b' })

    expect(ledger.claims.map(c => c.slice)).toEqual(['a', 'b'])
    expect(() => addClaim(ledger, a)).toThrow('slice a is already claimed')
  })

  it('runs under the ledger lock and refuses a second holder while the first is alive', async () => {
    const file = path.join(world, 'home', 'burndown.json')

    const nested = await withLedgerLock(file, () => withLedgerLock(file, () => 'second'))

    expect(nested).toEqual({ ran: true, value: { ran: false, holder: process.pid } })
    expect(fs.existsSync(`${file}.lock`)).toBe(false)
  })

  it('takes over a lock left by a dead process', async () => {
    const file = path.join(world, 'home', 'burndown.json')
    write(`${file}.lock`, '999999\n')

    expect(await withLedgerLock(file, () => 'ran')).toEqual({ ran: true, value: 'ran' })
  })

  it('marks an implementing claim stalled after four hours', () => {
    expect(isStalled(claim, new Date('2026-09-26T11:59:00.000Z'))).toBe(false)
    expect(isStalled(claim, new Date('2026-09-26T12:01:00.000Z'))).toBe(true)
  })

  it('parses a ledger written before seats unchanged', () => {
    const file = path.join(world, 'home', 'burndown.json')
    const before = {
      version: 1,
      lastTickAt: '2026-09-26T08:00:00.000Z',
      claims: [
        { ...claim, agentName: 'bd-dm-1', spawned: ['bd-dm-1'], worktree: '/repo/.worktrees/bd-dm-1' },
      ],
      decider: { wakes: ['2026-09-26T07:00:00.000Z'] },
    }
    write(file, JSON.stringify(before, null, 2))

    expect(readLedger(file)).toStrictEqual(before)
  })

  it('round-trips seat claims and per-seat pool samples', () => {
    const file = path.join(world, 'home', 'burndown.json')
    const seatClaim: Claim = { ...claim, seat: 'seat-a', namePrefix: 'tc', notified: ['dispatched'] }
    const ledger = {
      ...addClaim(EMPTY_LEDGER, seatClaim),
      seats: {
        'seat-a': {
          samples: [
            { at: 1, sevenDay: 40, resetsAt: 2 },
            { at: 3, sevenDay: 41 },
          ],
        },
      },
    }
    writeLedger(file, ledger)

    expect(readLedger(file)).toStrictEqual(ledger)
  })

  it('refuses to read a malformed ledger rather than treating it as empty', () => {
    const file = path.join(world, 'home', 'burndown.json')
    write(file, '{"claims": "nope"}')

    expect(() => readLedger(file)).toThrow('malformed')
  })
})
