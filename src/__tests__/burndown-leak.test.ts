import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner } from '../agents/burndown/exec.js'
import { leakCheck, type LeakDeps } from '../agents/burndown/leak-check.js'
import { GIT_BIN } from '../agents/burndown/review-diff.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { deliverSeatEvents, type SeatSender } from '../agents/burndown/seat-deliver.js'
import type { DenylistLoad } from '../leak-guard/denylist.js'
import { COMMIT_MARK, type RangeSource } from '../leak-guard/scan.js'

/** The leak backstop over a stubbed REST pulls reply and synthetic deny-list entries; nothing reaches GitHub. */

const HOME = '/home/synthetic-owner'
const NAME = 'quokkaproject'
const EMAIL = 'owner@quokka.net'
const DENYLIST: DenylistLoad = {
  kind: 'ok',
  list: { ownerEmails: [EMAIL], privateNames: [NAME], privatePaths: [] },
}
const ENTRIES = [HOME, NAME, EMAIL]
const NOW = new Date(Date.UTC(2026, 8, 29, 12))
const PR = 'https://github.com/example/demo/pull/7'

interface PullStub {
  number?: number
  url?: string
  title?: string
  body?: string
  branch?: string
  headRepo?: string
  private?: boolean
}

let checkout: string

const claim = (over: Partial<Claim> = {}): Claim => ({
  taskId: 'DM-1',
  initiative: 'demo',
  seat: 'seat-t',
  spawnedAt: NOW.toISOString(),
  phase: 'implementing',
  phaseAt: NOW.toISOString(),
  agentName: 'st-dm-1',
  spawned: ['st-dm-1'],
  pr: PR,
  worktree: checkout,
  ...over,
})

const ledgerOf = (...claims: Claim[]): Ledger => ({ ...EMPTY_LEDGER, claims })

const pull = (over: PullStub = {}) => ({
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

interface World {
  pulls: ReturnType<typeof pull>[]
  /** gh's stderr for a failed list; undefined means the list succeeds. */
  ghFails?: string | undefined
  calls: { bin: string; args: string[] }[]
  sent: { to: string; text: string }[]
  notices: string[]
  logged: { event: string; detail: Record<string, unknown> }[]
  diff: string[]
  lines: string[]
}

const newWorld = (pulls: ReturnType<typeof pull>[]): World => ({
  pulls,
  calls: [],
  sent: [],
  notices: [],
  logged: [],
  diff: [],
  lines: [],
})

const exec =
  (w: World): Runner =>
  (bin, args) => {
    w.calls.push({ bin, args })
    if (bin !== 'gh') return { status: 0, stdout: '' }
    if (w.ghFails !== undefined) return { status: 1, stdout: '', stderr: w.ghFails }
    return { status: 0, stdout: w.pulls.map(p => JSON.stringify(p)).join('\n') }
  }

const source = (w: World) => (): RangeSource => ({
  async *diffLines() {
    yield* w.diff
  },
  addedPaths: async () => [],
  messages: async () => [],
})

const sender = (w: World) => async (): Promise<SeatSender> => ({
  send: async (to, text) => {
    w.sent.push({ to, text })
    return { ok: true }
  },
  notify: async text => {
    w.notices.push(text)
    return { ok: true }
  },
  close: () => undefined,
})

/** The two tick steps under test: the leak check, then seat delivery over its ledger. */
async function tick(w: World, ledger: Ledger, over: Partial<LeakDeps> = {}): Promise<Ledger> {
  const log = (event: string, detail: Record<string, unknown>): void => void w.logged.push({ event, detail })
  const deps: LeakDeps = {
    exec: exec(w),
    log,
    seats: ['seat-t'],
    home: HOME,
    denylist: DENYLIST,
    source: source(w),
  }
  const leaks = await leakCheck(ledger, { ...deps, ...over })
  w.lines.push(...leaks.lines)
  const diff = { seats: ['seat-t'], before: ledger, after: leaks.ledger, spawns: [], human: leaks.human }
  return (await deliverSeatEvents(diff, { open: sender(w), log, now: NOW })).ledger
}

const leakSends = (w: World) => w.sent.filter(s => s.text.includes('\nleak '))

const expectNoEntry = (text: string): void => {
  for (const entry of ENTRIES) expect(text.toLowerCase()).not.toContain(entry.toLowerCase())
}

beforeEach(() => {
  checkout = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-leak-')))
})

afterEach(() => {
  fs.rmSync(checkout, { recursive: true, force: true })
})

describe('the tick leak check on a claimed PR', () => {
  it('tells the seat once of a title finding, and nothing new on the next tick', async () => {
    const w = newWorld([pull({ title: `Port the ${NAME} importer` })])

    const once = await tick(w, ledgerOf(claim()))
    await tick(w, once)

    expect(leakSends(w)).toHaveLength(1)
    expect(leakSends(w)[0]?.to).toBe('seat-t')
    expect(leakSends(w)[0]?.text).toContain(`leak DM-1: ${PR}: title private-name`)
    expectNoEntry(leakSends(w)[0]?.text ?? '')
  })

  it('names the body line and category of a home path without printing it', async () => {
    const w = newWorld([pull({ body: `Summary\nLogs under ${HOME}/scratch and mail ${EMAIL}` })])

    await tick(w, ledgerOf(claim()))

    const text = leakSends(w)[0]?.text ?? ''
    expect(text).toContain('body:2 home-path; body:2 owner-email')
    expectNoEntry(text)
  })

  it('reports an added line on the pushed branch by file and line', async () => {
    const w = newWorld([pull()])
    w.diff = [
      `${COMMIT_MARK}${'a'.repeat(40)}`,
      'diff --git a/src/a.ts b/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -0,0 +3 @@',
      `+const dir = '${HOME}/x'`,
    ]

    await tick(w, ledgerOf(claim()))

    const text = leakSends(w)[0]?.text ?? ''
    expect(text).toContain(`${'a'.repeat(12)} src/a.ts:3 home-path`)
    expectNoEntry(text)
    expect(w.calls.filter(c => c.bin === GIT_BIN).map(c => c.args)).toEqual([
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        '--refmap=',
        'origin',
        '+refs/heads/main:refs/agent-chat/leak-scan/7/base',
        '+refs/heads/agent-chat/st-dm-1:refs/agent-chat/leak-scan/7/head',
      ],
      ['update-ref', '-d', 'refs/agent-chat/leak-scan/7/base'],
      ['update-ref', '-d', 'refs/agent-chat/leak-scan/7/head'],
    ])
  })

  it('tells the seat again when the findings change', async () => {
    const w = newWorld([pull({ title: `Port the ${NAME} importer` })])
    const once = await tick(w, ledgerOf(claim()))
    w.pulls = [pull({ title: `Port the ${NAME} importer`, body: `see ${HOME}` })]

    await tick(w, once)

    expect(leakSends(w)).toHaveLength(2)
    expect(leakSends(w)[1]?.text).toContain('title private-name; body:1 home-path')
  })

  it('clears the finding once the PR is clean, so a later leak is told again', async () => {
    const w = newWorld([pull({ title: NAME })])
    const once = await tick(w, ledgerOf(claim()))
    w.pulls = [pull()]
    const clean = await tick(w, once)
    w.pulls = [pull({ title: NAME })]

    await tick(w, clean)

    expect(clean.claims[0]?.leak).toBeUndefined()
    expect(clean.claims[0]?.notified ?? []).not.toContain('leak')
    expect(leakSends(w)).toHaveLength(2)
  })

  it('matches a claim by its recorded PR even on a branch no agent of it pushed', async () => {
    const w = newWorld([pull({ branch: 'owner/manual', title: NAME })])

    await tick(w, ledgerOf(claim()))

    expect(leakSends(w)).toHaveLength(1)
    expect(w.notices).toEqual([])
  })

  it('matches a claim without a recorded PR by its agent branch', async () => {
    const w = newWorld([pull({ title: NAME })])
    const other = claim({ taskId: 'DM-2', pr: `${PR}0`, spawned: ['st-dm-2'], agentName: 'st-dm-2' })

    await tick(w, ledgerOf(claim({ pr: undefined }), other))

    expect(leakSends(w)).toHaveLength(1)
    expect(leakSends(w)[0]?.text).toContain('leak DM-1')
  })
})

describe('the tick leak check with several PRs on one claim', () => {
  const second = (over: PullStub = {}) => pull({ number: 99, url: `${PR}9`, ...over })

  it('ignores a fork PR on the same head ref as the claim', async () => {
    const w = newWorld([pull({ title: NAME }), second({ headRepo: 'stranger/demo' })])

    const once = await tick(w, ledgerOf(claim()))
    w.pulls = [pull({ title: NAME }), second({ headRepo: 'stranger/demo', body: `${HOME}/x` })]
    await tick(w, once)

    expect(leakSends(w)).toHaveLength(1)
    expect(leakSends(w)[0]?.text).toContain(`leak DM-1: ${PR}: title private-name`)
    expect(w.notices).toEqual([])
  })

  it('ignores a PR whose head repo was deleted', async () => {
    const w = newWorld([pull({ headRepo: '', title: NAME })])

    await tick(w, ledgerOf(claim()))

    expect(w.sent).toEqual([])
    expect(w.notices).toEqual([])
  })

  it('keeps a finding when a clean second PR of the claim is open', async () => {
    const w = newWorld([pull({ title: NAME }), second()])

    const once = await tick(w, ledgerOf(claim()))
    await tick(w, once)
    await tick(w, once)

    expect(leakSends(w)).toHaveLength(1)
    expect(leakSends(w)[0]?.text).toContain(`leak DM-1: ${PR}: title private-name`)
  })

  it('tells the union of two PRs with different findings once over three ticks', async () => {
    const w = newWorld([pull({ title: NAME }), second({ body: `${HOME}/x` })])

    let ledger = ledgerOf(claim())
    for (let i = 0; i < 3; i++) ledger = await tick(w, ledger)

    expect(leakSends(w)).toHaveLength(1)
    expect(leakSends(w)[0]?.text).toContain(
      `leak DM-1: ${PR}, ${PR}9: #7 title private-name; #99 body:1 home-path`,
    )
  })

  it('clears the finding once the claimed PR has closed', async () => {
    const w = newWorld([pull({ title: NAME })])
    const once = await tick(w, ledgerOf(claim()))
    w.pulls = []

    const closed = await tick(w, once)

    expect(once.claims[0]?.leak).toBeDefined()
    expect(closed.claims[0]?.leak).toBeUndefined()
    expect(closed.claims[0]?.notified ?? []).not.toContain('leak')
  })
})

describe('the tick leak check in a repo whose name is deny-listed', () => {
  const repoPr = `https://github.com/example/${NAME}/pull/7`
  const inRepo = (over: PullStub = {}) => pull({ url: repoPr, headRepo: `example/${NAME}`, ...over })

  it('redacts the repo name from the seat event', async () => {
    const w = newWorld([inRepo({ body: `${HOME}/x` })])

    await tick(w, ledgerOf(claim({ pr: repoPr })))

    const text = leakSends(w)[0]?.text ?? ''
    expect(text).toContain('https://github.com/example/[redacted]/pull/7: body:1 home-path')
    expectNoEntry(text)
  })

  it('redacts the repo name from the human-queue item', async () => {
    const w = newWorld([inRepo({ body: `${HOME}/x` })])

    await tick(w, ledgerOf(claim({ pr: repoPr, seat: 'seat-off' })))

    expect(w.notices).toHaveLength(1)
    expectNoEntry(w.notices[0] ?? '')
  })

  it('redacts the repo name from the line of a failed read', async () => {
    const w = newWorld([])
    w.ghFails = 'gh: API rate limit exceeded for user (HTTP 403)'

    await tick(w, ledgerOf(claim({ pr: repoPr })))

    expect(w.lines).toEqual([
      'leak check could not list open PRs of example/[redacted] (HTTP 403, rate limited); retried next tick',
    ])
  })
})

describe('the tick leak check on other PRs', () => {
  it('files one human-queue item for an unclaimed agent PR, and none on the next tick', async () => {
    const stray = `${PR.replace('/7', '/9')}`
    const w = newWorld([pull(), pull({ number: 9, url: stray, branch: 'agent-chat/lone', body: NAME })])

    const once = await tick(w, ledgerOf(claim()))
    await tick(w, once)

    expect(w.notices).toHaveLength(1)
    expect(w.notices[0]).toContain(
      `${stray} (no burndown claim; public or unknown visibility) has 1 finding(s): body:1 private-name`,
    )
    expectNoEntry(w.notices[0] ?? '')
    expect(leakSends(w)).toEqual([])
  })

  it('files the unclaimed PR again when its findings change', async () => {
    const stray = (body: string) => pull({ number: 9, url: `${PR}9`, branch: 'agent-chat/lone', body })
    const w = newWorld([pull(), stray(NAME)])
    const once = await tick(w, ledgerOf(claim()))
    w.pulls = [pull(), stray(`${NAME}\n${HOME}`)]

    await tick(w, once)

    expect(w.notices).toHaveLength(2)
    expect(w.notices[1]).toContain('body:1 private-name; body:2 home-path')
  })

  it('files the unclaimed PR again when a cleared finding returns', async () => {
    const stray = (body: string) => pull({ number: 9, url: `${PR}9`, branch: 'agent-chat/lone', body })
    const w = newWorld([pull(), stray(NAME)])
    const once = await tick(w, ledgerOf(claim()))
    w.pulls = [pull(), stray('')]
    const clean = await tick(w, once)
    w.pulls = [pull(), stray(NAME)]

    await tick(w, clean)

    expect(clean.humanFiled).toBeUndefined()
    expect(w.notices).toHaveLength(2)
  })

  it('files a claim whose seat is not enabled to the human queue with its task', async () => {
    const w = newWorld([pull({ title: NAME, private: true })])

    await tick(w, ledgerOf(claim({ seat: 'seat-off' })))

    expect(w.notices).toHaveLength(1)
    expect(w.notices[0]).toContain('claim DM-1 has no enabled seat; private repo, warn only')
  })

  it('ignores an open PR from a branch that is neither an agent branch nor a claim', async () => {
    const w = newWorld([pull(), pull({ number: 9, url: `${PR}9`, branch: 'owner/feature', title: NAME })])

    await tick(w, ledgerOf(claim()))

    expect(w.notices).toEqual([])
    expect(w.sent).toEqual([])
  })

  it('reads open PRs over REST only, one list per repo', async () => {
    const w = newWorld([pull({ title: NAME })])

    await tick(w, ledgerOf(claim(), claim({ taskId: 'DM-2', pr: `${PR}2` })))

    const gh = w.calls.filter(c => c.bin === 'gh')
    expect(gh).toHaveLength(1)
    expect(gh[0]?.args.slice(0, 3)).toEqual([
      'api',
      '--paginate',
      'repos/example/demo/pulls?state=open&per_page=100',
    ])
    expect(w.calls.flatMap(c => c.args).join(' ')).not.toMatch(/graphql|pr view/)
  })

  it('makes no call when no held claim has a PR', async () => {
    const w = newWorld([pull({ title: NAME })])
    const ledger = ledgerOf(claim({ pr: undefined }))

    const after = await tick(w, ledger)

    expect(w.calls).toEqual([])
    expect(after).toEqual(ledger)
  })
})

describe('the tick leak check when it cannot read', () => {
  it('keeps a filed item while the repo cannot be listed, so it is not filed twice', async () => {
    const w = newWorld([pull(), pull({ number: 9, url: `${PR}9`, branch: 'agent-chat/lone', body: NAME })])
    const once = await tick(w, ledgerOf(claim()))
    w.ghFails = 'gh: Resource not accessible (HTTP 403)'
    const failed = await tick(w, once)
    w.ghFails = undefined

    await tick(w, failed)

    expect(failed.humanFiled).toEqual(once.humanFiled)
    expect(w.notices).toHaveLength(1)
    expect(w.logged).toContainEqual({
      event: 'burndown_leak_reader_failed',
      detail: { repo: 'example/demo', exit: 1, http: 403, rateLimited: false },
    })
  })

  it('records a missing deny-list once and still flags the home path', async () => {
    const w = newWorld([pull({ body: `${HOME}/a` })])

    const once = await tick(w, ledgerOf(claim()), { denylist: { kind: 'missing' } })
    await tick(w, once, { denylist: { kind: 'missing' } })

    const recorded = w.logged.filter(l => l.event === 'burndown_leak_denylist')
    expect(recorded).toEqual([
      { event: 'burndown_leak_denylist', detail: { state: 'missing', checked: 'home-path only' } },
    ])
    expect(leakSends(w)[0]?.text).toContain('body:1 home-path')
  })

  it('still scans the PR text when the branch has no local checkout', async () => {
    const w = newWorld([pull({ title: NAME })])
    const parked = claim({ worktree: path.join(checkout, 'gone', '.worktrees', 'x') })

    const leaks = await leakCheck(ledgerOf(parked), {
      exec: exec(w),
      log: () => undefined,
      seats: ['seat-t'],
      home: HOME,
      denylist: DENYLIST,
    })

    expect(leaks.lines).toEqual(['leak check skipped the branch of DM-1: no local checkout'])
    expect(leaks.ledger.claims[0]?.leak?.findings).toEqual(['title private-name'])
  })
})
