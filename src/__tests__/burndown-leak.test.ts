import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  egressRunner,
  type EgressFinding,
  type EgressOutcome,
  type EgressRunner,
} from '../agents/burndown/egress-runner.js'
import { run, type Runner } from '../agents/burndown/exec.js'
import { leakCheck, type LeakDeps } from '../agents/burndown/leak-check.js'
import { GIT_BIN } from '../agents/burndown/review-diff.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { deliverSeatEvents, type SeatSender } from '../agents/burndown/seat-deliver.js'
import { probeScanner } from '../leak-guard/hooks-dir.js'

/** The leak backstop over a stubbed REST pulls reply and a scanner stub with synthetic terms; nothing reaches GitHub. */

const HOME = '/Users/zz-probe'
const NAME = 'zz-private-fixture'
const EMAIL = 'someone@example.invalid'
const ENTRIES = [HOME, NAME, EMAIL]
const NOW = new Date(Date.UTC(2026, 8, 29, 12))
const PR = 'https://github.com/example/demo/pull/7'

const RULES: [string, string][] = [
  [HOME, 'home-path'],
  [NAME, 'private-term'],
  [EMAIL, 'private-term'],
]

/** What `titan-egress-scan text` reports for the synthetic entries: `<line>:<col> <rule>`, 1-based. */
function stubFindings(text: string): EgressFinding[] {
  return text.split('\n').flatMap((line, i) =>
    RULES.flatMap(([entry, rule]) => {
      const col = line.toLowerCase().indexOf(entry.toLowerCase())
      return col < 0 ? [] : [{ location: `${i + 1}:${col + 1}`, rule }]
    }),
  )
}

interface PullStub {
  number?: number
  url?: string
  title?: string
  body?: string
  branch?: string
  headRepo?: string
  base?: string
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
  defaultBranch: 'main',
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
  /** What the stub's range scan finds on the pushed branch. */
  branch: EgressFinding[]
  ranges: { cwd: string; base: string; head: string; allowFrom?: string | undefined }[]
  fetchFails?: boolean
  /** The range scan alone returns this when set. */
  rangeDown?: EgressOutcome | undefined
  /** Every scanner call returns this when set: a missing scanner, term list or a crash. */
  down?: EgressOutcome | undefined
  lines: string[]
}

const newWorld = (pulls: ReturnType<typeof pull>[]): World => ({
  pulls,
  calls: [],
  sent: [],
  notices: [],
  logged: [],
  branch: [],
  ranges: [],
  lines: [],
})

const exec =
  (w: World): Runner =>
  (bin, args) => {
    w.calls.push({ bin, args })
    if (bin !== 'gh') return { status: w.fetchFails === true && args[0] === 'fetch' ? 1 : 0, stdout: '' }
    if (w.ghFails !== undefined) return { status: 1, stdout: '', stderr: w.ghFails }
    return { status: 0, stdout: w.pulls.map(p => JSON.stringify(p)).join('\n') }
  }

const egress = (w: World): EgressRunner => ({
  text: input => w.down ?? { state: 'ok', findings: stubFindings(input) },
  range: (cwd, base, head, allowFrom) => {
    w.ranges.push({ cwd, base, head, allowFrom })
    return w.down ?? w.rangeDown ?? { state: 'ok', findings: w.branch }
  },
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
    egress: egress(w),
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
    expect(leakSends(w)[0]?.text).toContain(`leak DM-1: ${PR}: title 1:10 private-term`)
    expectNoEntry(leakSends(w)[0]?.text ?? '')
  })

  it('names the body line and category of a home path without printing it', async () => {
    const w = newWorld([pull({ body: `Summary\nLogs under ${HOME}/scratch and mail ${EMAIL}` })])

    await tick(w, ledgerOf(claim()))

    const text = leakSends(w)[0]?.text ?? ''
    expect(text).toContain('body 2:12 home-path; body 2:45 private-term')
    expectNoEntry(text)
  })

  it('tells the seat once of an owner email in the body, without the address', async () => {
    const w = newWorld([pull({ body: `Contact\nmail ${EMAIL} please` })])

    const once = await tick(w, ledgerOf(claim()))
    await tick(w, once)

    expect(leakSends(w)).toHaveLength(1)
    expect(leakSends(w)[0]?.text).toContain(`leak DM-1: ${PR}: body 2:6 private-term`)
    expectNoEntry(leakSends(w)[0]?.text ?? '')
  })

  it('reports an added line on the pushed branch by file and line', async () => {
    const w = newWorld([pull()])
    w.branch = [{ location: `commit ${'a'.repeat(7)} src/a.ts:3`, rule: 'home-path' }]

    await tick(w, ledgerOf(claim()))

    const text = leakSends(w)[0]?.text ?? ''
    expect(text).toContain(`${'a'.repeat(7)} src/a.ts:3 home-path`)
    expectNoEntry(text)
    expect(w.calls.filter(c => c.bin === GIT_BIN).map(c => c.args)).toEqual([
      ['for-each-ref', '--format=%(refname)', 'refs/agent-chat/leak-scan/'],
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
    expect(w.ranges).toEqual([
      {
        cwd: checkout,
        base: 'refs/agent-chat/leak-scan/7/base',
        head: 'refs/agent-chat/leak-scan/7/head',
        allowFrom: 'refs/agent-chat/leak-scan/7/base',
      },
    ])
  })

  it('takes no allow file from a base that is not the default branch', async () => {
    const w = newWorld([pull({ base: 'agent-chat/other' })])

    await tick(w, ledgerOf(claim()))

    expect(w.ranges[0]?.allowFrom).toBeUndefined()
  })

  it('adds a new title finding beside the kept branch finding when the range scan fails', async () => {
    const w = newWorld([pull()])
    w.branch = [{ location: `commit ${'a'.repeat(7)} src/a.ts:3`, rule: 'home-path' }]
    const once = await tick(w, ledgerOf(claim()))
    w.rangeDown = { state: 'error' }
    w.pulls = [pull({ title: NAME })]

    const after = await tick(w, once)

    expect(after.claims[0]?.leak?.findings).toEqual([
      'title 1:1 private-term',
      'aaaaaaa src/a.ts:3 home-path',
    ])
    expect(leakSends(w)).toHaveLength(2)
  })

  it('clears a fixed body finding while the branch scan fails', async () => {
    const w = newWorld([pull({ body: EMAIL })])
    const once = await tick(w, ledgerOf(claim()))
    w.fetchFails = true
    w.pulls = [pull()]

    const after = await tick(w, once)

    expect(once.claims[0]?.leak?.findings).toEqual(['body 1:1 private-term'])
    expect(after.claims[0]?.leak).toBeUndefined()
    expect(after.leakScans).toBeUndefined()
  })

  it('keeps one row format when a kept branch finding meets a second flagged PR', async () => {
    const second = `${PR.replace('/7', '/8')}`
    const w = newWorld([pull()])
    w.branch = [{ location: `commit ${'a'.repeat(7)} src/a.ts:3`, rule: 'home-path' }]
    const once = await tick(w, ledgerOf(claim()))
    w.fetchFails = true
    w.branch = []
    w.pulls = [pull(), pull({ number: 8, url: second, title: NAME })]

    const after = await tick(w, once)

    expect(after.claims[0]?.leak?.findings).toEqual([
      '#7 aaaaaaa src/a.ts:3 home-path',
      '#8 title 1:1 private-term',
    ])
  })

  it('forgets the stored rows of a PR once it has closed', async () => {
    const w = newWorld([pull({ title: NAME })])
    const once = await tick(w, ledgerOf(claim()))
    w.pulls = []

    const after = await tick(w, once)

    expect(once.leakScans).toEqual({ [PR]: { text: ['title 1:1 private-term'] } })
    expect(after.leakScans).toBeUndefined()
  })

  const parked = (ledger: Ledger): Ledger => ({
    ...ledger,
    claims: ledger.claims.map(c => ({ ...c, worktree: path.join(checkout, 'gone', '.worktrees', 'x') })),
  })
  const throwing = (w: World): EgressRunner => ({
    ...egress(w),
    range: () => {
      throw new Error('mkdtemp failed')
    },
  })

  it.each<[string, (w: World) => Partial<LeakDeps>, (l: Ledger) => Ledger]>([
    ['the scanner reported error', w => ((w.rangeDown = { state: 'error' }), {}), l => l],
    ['git fetch failed', w => ((w.fetchFails = true), {}), l => l],
    ['no local checkout', () => ({}), parked],
    ['the branch scan failed', w => ({ egress: throwing(w) }), l => l],
  ])('keeps an earlier branch finding when the next branch scan stops with %s', async (why, fail, move) => {
    const w = newWorld([pull()])
    w.branch = [{ location: `commit ${'a'.repeat(7)} src/a.ts:3`, rule: 'home-path' }]
    const once = await tick(w, ledgerOf(claim()))
    const over = fail(w)

    const after = await tick(w, move(once), over)

    expect(after.claims[0]?.leak).toEqual(once.claims[0]?.leak)
    expect(leakSends(w)).toHaveLength(1)
    expect(w.lines).toContain(`leak check skipped the branch of DM-1: ${why}; its last result stands`)
  })

  it('tells the seat again when the findings change', async () => {
    const w = newWorld([pull({ title: `Port the ${NAME} importer` })])
    const once = await tick(w, ledgerOf(claim()))
    w.pulls = [pull({ title: `Port the ${NAME} importer`, body: `see ${HOME}` })]

    await tick(w, once)

    expect(leakSends(w)).toHaveLength(2)
    expect(leakSends(w)[1]?.text).toContain('title 1:10 private-term; body 1:5 home-path')
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

describe('the tick leak check on head repo and claim repo names', () => {
  it.each([
    ['a head repo differing in case', 'Example/Demo', PR],
    ['a claim PR URL differing in case', 'example/demo', 'https://github.com/Example/Demo/pull/7'],
  ])('still scans a PR from the base repo with %s', async (_name, headRepo, url) => {
    const w = newWorld([pull({ title: NAME, headRepo, url })])

    await tick(w, ledgerOf(claim({ pr: url })))

    expect(leakSends(w)).toHaveLength(1)
  })

  it('does not let a same-named agent branch in another claimed repo clear a leak', async () => {
    const elsewhere = 'https://github.com/example/other/pull/3'
    const leaking = pull({ title: NAME })
    const clean = pull({ number: 3, url: `${elsewhere}0`, headRepo: 'example/other' })
    const w = newWorld([])
    const byRepo: Runner = (bin, args, cwd) => {
      if (bin !== 'gh') return exec(w)(bin, args, cwd)
      const own = args[2]?.startsWith('repos/example/demo/') ? leaking : clean
      return { status: 0, stdout: JSON.stringify(own) }
    }
    const claims = ledgerOf(claim(), claim({ taskId: 'DM-2', pr: elsewhere, spawned: ['st-dm-2'] }))

    const after = await tick(w, claims, { exec: byRepo })

    expect(after.claims[0]?.leak?.findings).toEqual(['title 1:1 private-term'])
    expect(leakSends(w)).toHaveLength(1)
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
    expect(leakSends(w)[0]?.text).toContain(`leak DM-1: ${PR}: title 1:1 private-term`)
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
    expect(leakSends(w)[0]?.text).toContain(`leak DM-1: ${PR}: title 1:1 private-term`)
  })

  it('tells the union of two PRs with different findings once over three ticks', async () => {
    const w = newWorld([pull({ title: NAME }), second({ body: `${HOME}/x` })])

    let ledger = ledgerOf(claim())
    for (let i = 0; i < 3; i++) ledger = await tick(w, ledger)

    expect(leakSends(w)).toHaveLength(1)
    expect(leakSends(w)[0]?.text).toContain(
      `leak DM-1: ${PR}, ${PR}9: #7 title 1:1 private-term; #99 body 1:1 home-path`,
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

describe('the tick leak check in a repo whose name holds a private term', () => {
  const repoPr = `https://github.com/example/${NAME}/pull/7`
  const inRepo = (over: PullStub = {}) => pull({ url: repoPr, headRepo: `example/${NAME}`, ...over })

  it('redacts the repo name from the seat event', async () => {
    const w = newWorld([inRepo({ body: `${HOME}/x` })])

    await tick(w, ledgerOf(claim({ pr: repoPr })))

    const text = leakSends(w)[0]?.text ?? ''
    expect(text).toContain('leak DM-1: [redacted url]: body 1:1 home-path')
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
      'leak check could not list open PRs of [redacted repo] (HTTP 403, rate limited); retried next tick',
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
      `${stray} (no burndown claim; public or unknown visibility) has 1 finding(s): body 1:1 private-term`,
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
    expect(w.notices[1]).toContain('body 1:1 private-term; body 2:1 home-path')
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

  it('keeps the human item of an unseated claim while its branch scan fails, and files it once', async () => {
    const w = newWorld([pull({ title: NAME })])
    w.branch = [{ location: `commit ${'a'.repeat(7)} src/a.ts:3`, rule: 'home-path' }]
    const once = await tick(w, ledgerOf(claim({ seat: 'seat-off' })))
    w.fetchFails = true
    const failed = await tick(w, once)
    w.fetchFails = false

    await tick(w, failed)

    expect(failed.humanFiled).toEqual(once.humanFiled)
    expect(w.notices).toHaveLength(1)
  })

  it('files a new text finding of an unseated claim while its branch scan fails', async () => {
    const w = newWorld([pull({ title: NAME })])
    const once = await tick(w, ledgerOf(claim({ seat: 'seat-off' })))
    w.fetchFails = true
    w.pulls = [pull({ title: NAME, body: EMAIL })]

    const after = await tick(w, once)

    expect(w.notices).toHaveLength(2)
    expect(w.notices[1]).toContain('title 1:1 private-term; body 1:1 private-term')
    expect(after.humanFiled).toHaveLength(1)
    expect(after.humanFiled).not.toEqual(once.humanFiled)
  })

  it('keeps the branch finding of an unseated claim in a new item while its branch scan fails', async () => {
    const w = newWorld([pull()])
    w.branch = [{ location: `commit ${'a'.repeat(7)} src/a.ts:3`, rule: 'home-path' }]
    const once = await tick(w, ledgerOf(claim({ seat: 'seat-off' })))
    w.fetchFails = true
    w.pulls = [pull({ title: NAME })]

    await tick(w, once)

    expect(w.notices[1]).toContain('title 1:1 private-term; aaaaaaa src/a.ts:3 home-path')
  })

  it('files a partial scan of an unseated claim when nothing is filed for its PR', async () => {
    const w = newWorld([pull({ title: NAME })])
    w.fetchFails = true

    await tick(w, ledgerOf(claim({ seat: 'seat-off' })))

    expect(w.notices).toHaveLength(1)
    expect(w.notices[0]).toContain('title 1:1 private-term')
  })

  it('holds back only the filed keys of the PR that went unscanned', async () => {
    const stray = (n: number, body: string) =>
      pull({ number: n, url: `${PR}${n}`, branch: `agent-chat/lone-${n}`, body })
    const w = newWorld([pull(), stray(8, NAME), stray(9, NAME)])
    const once = await tick(w, ledgerOf(claim()))
    w.pulls = [pull(), stray(8, ''), stray(9, `${NAME} again`)]
    const failing: EgressRunner = {
      ...egress(w),
      text: input => (input.includes('again') ? { state: 'error' } : egress(w).text(input)),
    }

    const after = await tick(w, once, { egress: failing })

    expect(once.humanFiled).toHaveLength(2)
    expect(after.humanFiled).toEqual(once.humanFiled?.filter(k => k.startsWith(`${PR}9#`)))
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

  it('still lists the open PRs when the scanner is up but cannot scan a repo name', async () => {
    const w = newWorld([pull({ title: NAME })])
    const flaky: EgressRunner = {
      ...egress(w),
      text: input => (input === 'example/demo' ? { state: 'error' } : egress(w).text(input)),
    }

    await tick(w, ledgerOf(claim()), { egress: flaky })

    expect(leakSends(w)[0]?.text).toContain('leak DM-1: [redacted url]: title 1:1 private-term')
  })

  it('keeps the last result of a PR whose text the scanner fails on', async () => {
    const w = newWorld([pull({ title: NAME })])
    const once = await tick(w, ledgerOf(claim()))
    w.pulls = [pull()]
    const failing: EgressRunner = {
      ...egress(w),
      text: input => (input.includes('\n') ? { state: 'error' } : egress(w).text(input)),
    }

    const after = await tick(w, once, { egress: failing })

    expect(after.claims[0]?.leak?.findings).toEqual(['title 1:1 private-term'])
    expect(w.lines).toContain(`leak check could not scan the text of ${PR}; its last result stands`)
  })
})

describe('the tick leak check when the scanner is down', () => {
  const downLines = (w: World) => w.lines.filter(l => l.startsWith('leak check scanned no PR'))
  const scannerLogs = (w: World) => w.logged.filter(l => l.event === 'burndown_leak_scanner')

  it('files one human item for a missing scanner and reports nothing clean', async () => {
    const w = newWorld([pull({ body: `${HOME}/a` })])
    w.down = { state: 'no-scanner' }

    const once = await tick(w, ledgerOf(claim()))
    await tick(w, once)

    expect(downLines(w)).toHaveLength(2)
    expect(w.notices).toHaveLength(1)
    expect(w.notices[0]).toContain("no titan-egress-scan (or node) on the tick's PATH")
    expect(leakSends(w)).toEqual([])
    expect(scannerLogs(w)).toEqual([{ event: 'burndown_leak_scanner', detail: { state: 'no-scanner' } }])
  })

  it('logs a missing term list once and keeps the claim finding it already had', async () => {
    const w = newWorld([pull({ title: NAME })])
    const healthy = await tick(w, ledgerOf(claim()))
    w.pulls = [pull()]
    w.down = { state: 'no-terms', detail: 'titan-egress-scan: private term list not found' }

    const once = await tick(w, healthy)
    const twice = await tick(w, once)

    expect(twice.claims[0]?.leak).toEqual(healthy.claims[0]?.leak)
    expect(w.notices).toHaveLength(1)
    expect(scannerLogs(w)).toEqual([
      { event: 'burndown_leak_scanner', detail: { state: 'ok' } },
      {
        event: 'burndown_leak_scanner',
        detail: { state: 'no-terms', detail: 'titan-egress-scan: private term list not found' },
      },
    ])
  })

  it('files the outage again after the scanner has come back in between', async () => {
    const w = newWorld([pull()])
    w.down = { state: 'no-scanner' }
    const down = await tick(w, ledgerOf(claim()))
    w.down = undefined
    const up = await tick(w, down)
    w.down = { state: 'no-scanner' }

    await tick(w, up)

    expect(up.humanFiled).toBeUndefined()
    expect(w.notices).toHaveLength(2)
  })

  it('keeps the human items of other PRs filed while the scanner is down', async () => {
    const w = newWorld([pull(), pull({ number: 9, url: `${PR}9`, branch: 'agent-chat/lone', body: NAME })])
    const once = await tick(w, ledgerOf(claim()))
    w.down = { state: 'error', detail: 'boom' }
    const down = await tick(w, once)
    w.down = undefined

    await tick(w, down)

    expect(down.humanFiled).toEqual(expect.arrayContaining(once.humanFiled ?? []))
    expect(w.notices).toHaveLength(2)
  })

  it('still scans the PR text when the branch has no local checkout', async () => {
    const w = newWorld([pull({ title: NAME })])
    const parked = claim({ worktree: path.join(checkout, 'gone', '.worktrees', 'x') })

    const leaks = await leakCheck(ledgerOf(parked), {
      exec: exec(w),
      log: () => undefined,
      seats: ['seat-t'],
      egress: egress(w),
    })

    expect(leaks.lines).toEqual([
      'leak check skipped the branch of DM-1: no local checkout; its last result stands',
    ])
    expect(leaks.ledger.claims[0]?.leak?.findings).toEqual(['title 1:1 private-term'])
  })
})

describe('the tick leak check sweep of stale scan refs', () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.com', ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).trim()

  it('deletes refs a crashed scan left and moves no other ref', async () => {
    git(checkout, 'init', '-q', '-b', 'main')
    git(checkout, 'commit', '-q', '--allow-empty', '-m', 'first')
    const sha = git(checkout, 'rev-parse', 'HEAD')
    git(checkout, 'update-ref', 'refs/agent-chat/leak-scan/7/head', sha)
    git(checkout, 'update-ref', 'refs/agent-chat/leak-scan/7/base', sha)
    git(checkout, 'update-ref', 'refs/heads/agent-chat/keep', sha)
    git(checkout, 'update-ref', 'refs/agent-chat/other/keep', sha)
    const before = git(
      checkout,
      'for-each-ref',
      '--format=%(refname)',
      'refs/heads/',
      'refs/agent-chat/other/',
    )

    await leakCheck(ledgerOf(claim()), {
      exec: (bin, args, cwd) => (bin === 'gh' ? { status: 0, stdout: '' } : run(bin, args, cwd)),
      log: () => undefined,
      seats: ['seat-t'],
      egress: egress(newWorld([])),
    })

    expect(git(checkout, 'for-each-ref', '--format=%(refname)', 'refs/agent-chat/leak-scan/')).toBe('')
    expect(
      git(checkout, 'for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/agent-chat/other/'),
    ).toBe(before)
  })
})

// The scanner runs git by name; CI's node lives in a toolcache dir without one.
const REAL_PATH = [
  path.resolve('node_modules/.bin'),
  path.dirname(process.execPath),
  path.dirname(GIT_BIN),
].join(':')
const realScanner = probeScanner(REAL_PATH)

describe.skipIf(realScanner === undefined)('the tick leak check on the real titan-egress-scan', () => {
  const real = (termsFile: string): EgressRunner =>
    egressRunner({ path: REAL_PATH, home: checkout, termsFile, probe: () => realScanner })

  const writeTerms = (): string => {
    const file = path.join(checkout, 'private-terms')
    fs.writeFileSync(file, `${NAME}\n${EMAIL}\n`, { mode: 0o600 })
    return file
  }

  it('tells the seat once of a private term and owner email in the body, redacted', async () => {
    const w = newWorld([pull({ body: `ping ${EMAIL}\nand ${NAME}` })])
    const egress = real(writeTerms())

    const once = await tick(w, ledgerOf(claim()), { egress })
    await tick(w, once, { egress })

    expect(leakSends(w)).toHaveLength(1)
    expect(leakSends(w)[0]?.text).toContain(`leak DM-1: ${PR}: body 1:6 private-term; body 2:5 private-term`)
    expectNoEntry(leakSends(w)[0]?.text ?? '')
  })

  it('reports a missing term list as no-terms and files one human item', async () => {
    const w = newWorld([pull({ body: `${HOME}/a` })])
    const egress = real(path.join(checkout, 'absent'))

    const once = await tick(w, ledgerOf(claim()), { egress })
    await tick(w, once, { egress })

    expect(w.logged.find(l => l.event === 'burndown_leak_scanner')?.detail.state).toBe('no-terms')
    expect(w.notices).toHaveLength(1)
    expect(leakSends(w)).toEqual([])
  })

  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.com', ...args], {
      cwd: checkout,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).trim()

  const ALLOW_SRC = 'src/** home-path CC-1 synthetic\n'

  /** A base commit, optionally holding an allow file, and a head commit adding a home path under src/. */
  function branchRepo(baseAllow?: string): void {
    git('init', '-q', '-b', 'main')
    if (baseAllow !== undefined) {
      fs.writeFileSync(path.join(checkout, '.egress-allow'), baseAllow)
      git('add', '.egress-allow')
    }
    git('commit', '-q', '--allow-empty', '-m', 'base')
    git('update-ref', 'refs/agent-chat/leak-scan/7/base', 'HEAD')
    fs.mkdirSync(path.join(checkout, 'src'))
    fs.writeFileSync(path.join(checkout, 'src', 'a.ts'), `const dir = '${HOME}/x'\n`)
    git('add', 'src/a.ts')
    git('commit', '-q', '-m', 'add')
    git('update-ref', 'refs/agent-chat/leak-scan/7/head', 'HEAD')
  }

  const BRANCH_ROW = /leak DM-1: \S+: [0-9a-f]{7,} src\/a\.ts:1 home-path/

  it('scans the commits the fetched head adds over the fetched base', async () => {
    const terms = writeTerms()
    branchRepo()
    const w = newWorld([pull()])

    await tick(w, ledgerOf(claim()), { egress: real(terms) })

    expect(leakSends(w)[0]?.text).toMatch(BRANCH_ROW)
  })

  it('ignores an allow file the agent wrote into its checkout', async () => {
    const terms = writeTerms()
    branchRepo()
    fs.writeFileSync(path.join(checkout, '.egress-allow'), ALLOW_SRC)
    const w = newWorld([pull()])

    await tick(w, ledgerOf(claim()), { egress: real(terms) })

    expect(leakSends(w)[0]?.text).toMatch(BRANCH_ROW)
  })

  it('ignores a malformed allow file in the checkout rather than failing the scan', async () => {
    const terms = writeTerms()
    branchRepo()
    fs.writeFileSync(path.join(checkout, '.egress-allow'), 'not an allow line\n')
    const w = newWorld([pull()])

    await tick(w, ledgerOf(claim()), { egress: real(terms) })

    expect(leakSends(w)[0]?.text).toMatch(BRANCH_ROW)
  })

  it("honours the default branch's committed allow file", async () => {
    const terms = writeTerms()
    branchRepo(ALLOW_SRC)
    const w = newWorld([pull()])

    const after = await tick(w, ledgerOf(claim()), { egress: real(terms) })

    expect(after.claims[0]?.leak).toBeUndefined()
    expect(w.lines).toEqual([])
  })

  it('takes no allow file from a base that is not the default branch', async () => {
    const terms = writeTerms()
    branchRepo(ALLOW_SRC)
    const w = newWorld([pull({ base: 'agent-chat/other' })])

    await tick(w, ledgerOf(claim()), { egress: real(terms) })

    expect(leakSends(w)[0]?.text).toMatch(BRANCH_ROW)
  })
})
