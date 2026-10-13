import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyActions } from '../agents/burndown/advance.js'
import type { RunResult } from '../agents/burndown/exec.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { branchPrReader, offLedgerRunsIn, type OffLedgerRun } from '../agents/burndown/off-ledger-adopt.js'
import { initiativePrReaders } from '../agents/burndown/seat-tick.js'
import type { RepoPull } from '../agents/burndown/pr-state.js'
import {
  diskPlanReader,
  resyncQueuedSlices,
  seedSlices,
  type PlanReader,
} from '../agents/burndown/seed-slices.js'
import type { DispatchRecord } from '../agents/seats/dispatch-record.js'

/** CC-1233: a plan whose slice agents ran outside the ledger is seeded by their branch PRs. Every name is synthetic. */

const NOW = new Date('2026-10-13T12:00:00.000Z')
const PLAN_PATH = '/tmp/aw/demo/sources/DM-1-plan.md'
const PARENT = { taskId: 'DM-1', initiative: 'demo', seat: 'seat-x', namePrefix: 'sx' }

const slice = (n: string) => ({
  n,
  title: `slice ${n}`,
  dependsOn: [],
  owns: [`${n}.ts`],
  points: 1,
  doneWhen: `Slice ${n} test passes.`,
})

const planText = (slices: readonly object[]): string =>
  `# DM-1 plan\n\n\`\`\`burndown-slices\n${JSON.stringify(slices, null, 2)}\n\`\`\`\n`

const PLAN = { path: PLAN_PATH, text: planText([slice('a'), slice('b'), slice('c'), slice('d')]) }

const ran = (n: string, pr: OffLedgerRun['pr']): OffLedgerRun => ({ agent: `sx-dm-1-${n}`, slice: n, pr })

const bySlice = (claims: readonly Claim[]) => Object.fromEntries(claims.map(c => [c.slice, c]))

describe('seeding a plan whose slice agents ran outside the ledger', () => {
  const runs = [
    ran('a', { kind: 'merged', pr: 'demo/repo#1', head: 'h1' }),
    ran('b', { kind: 'open', pr: 'demo/repo#2' }),
    ran('c', { kind: 'none' }),
  ]

  const seeded = () => {
    const result = seedSlices(PARENT, PLAN, EMPTY_LEDGER, NOW, () => runs)
    if (result === undefined || !('claims' in result))
      throw new Error(`not seeded: ${JSON.stringify(result)}`)
    return result
  }

  it('marks a slice whose branch PR merged done, with the PR linked', () => {
    expect(bySlice(seeded().claims).a).toMatchObject({
      phase: 'done',
      pr: 'demo/repo#1',
      prHead: 'h1',
      agentName: 'sx-dm-1-a',
      spawned: ['sx-dm-1-a'],
      seat: 'seat-x',
    })
  })

  it('puts a slice whose branch PR is open into shepherding, with the PR linked', () => {
    expect(bySlice(seeded().claims).b).toMatchObject({
      phase: 'shepherding',
      pr: 'demo/repo#2',
      agentName: 'sx-dm-1-b',
    })
  })

  it('queues a slice no agent ran', () => {
    const d = bySlice(seeded().claims).d
    expect(d).toMatchObject({ phase: 'queued', owns: ['d.ts'] })
    expect(d?.agentName).toBeUndefined()
  })

  it('leaves alone a run slice with no PR, giving it no claim, and says so', () => {
    const { claims, notes } = seeded()

    expect(bySlice(claims).c).toBeUndefined()
    expect(notes).toContain(
      'left demo DM-1 slice c to sx-dm-1-c, which ran outside the ledger and has no open or merged PR',
    )
  })

  it('no longer refuses with the outside-the-ledger block', () => {
    expect(JSON.stringify(seedSlices(PARENT, PLAN, EMPTY_LEDGER, NOW, () => runs))).not.toContain(
      'seed by hand or close the task',
    )
  })

  it('waits a tick when a run PR could not be read', () => {
    const result = seedSlices(PARENT, PLAN, EMPTY_LEDGER, NOW, () => [ran('a', undefined)])

    expect(result).toEqual({
      blocked: `${PLAN_PATH}: could not read the branch PRs of sx-dm-1-a, slice agents of DM-1 that ran outside the ledger; seeding waits a tick`,
    })
  })
})

describe('the drift resync with slice agents that ran outside the ledger', () => {
  const held: Claim = {
    taskId: 'DM-1',
    initiative: 'demo',
    spawnedAt: NOW.toISOString(),
    phase: 'queued',
    phaseAt: NOW.toISOString(),
    slice: 'a',
    dependsOn: [],
    owns: ['a.ts'],
    seat: 'seat-x',
    namePrefix: 'sx',
  }
  const ledger: Ledger = { version: 1, claims: [held] }
  const twoSlices = planText([slice('a'), slice('b')])

  it('never queues a new plan slice whose agent already ran, and says why', () => {
    const readPlan: PlanReader = (_i, _t, seat) => ({
      path: PLAN_PATH,
      text: twoSlices,
      ...(seat === undefined ? {} : { ranOffLedger: ['sx-dm-1-b'] }),
    })

    const out = resyncQueuedSlices(ledger, readPlan, NOW)

    expect(applyActions(ledger, out.actions, NOW).claims.map(c => c.slice)).toEqual(['a'])
    expect(out.notes).toEqual([
      `plan drift demo DM-1: did not queue new slice b from ${PLAN_PATH}: its agent sx-dm-1-b ran outside the ledger`,
    ])
  })

  it('holds every new slice while the seat log cannot be read', () => {
    const readPlan: PlanReader = () => ({ path: PLAN_PATH, text: twoSlices, runsUnread: 'log gone' })

    const out = resyncQueuedSlices(ledger, readPlan, NOW)

    expect(out.actions).toEqual([])
    expect(out.notes).toEqual([`plan drift demo DM-1: did not queue new slice b from ${PLAN_PATH}: log gone`])
  })

  it("reads the claim's seat log through the disk reader", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'off-ledger-'))
    fs.mkdirSync(path.join(root, 'demo', 'sources'), { recursive: true })
    fs.writeFileSync(path.join(root, 'demo', 'sources', 'DM-1-plan.md'), twoSlices)
    fs.mkdirSync(path.join(root, 'seats'))
    fs.writeFileSync(path.join(root, 'seats', 'seat-x.md'), '---\nprefix: sx\npool: p\n---\n')
    fs.mkdirSync(path.join(root, 'logs', 'seat-x'), { recursive: true })
    const row = { ts: NOW.toISOString(), task: 'DM-1', agent: 'sx-dm-1-b', outcome: 'dispatched' }
    fs.writeFileSync(path.join(root, 'logs', 'seat-x', 'dispatch.jsonl'), `${JSON.stringify(row)}\n`)

    const out = resyncQueuedSlices(ledger, diskPlanReader(root, root), NOW)

    expect(out.actions).toEqual([])
    expect(out.notes.join('\n')).toContain('its agent sx-dm-1-b ran outside the ledger')
    fs.rmSync(root, { recursive: true, force: true })
  })
})

describe('branchPrReader', () => {
  const SINCE = '2026-10-10T00:00:00.000Z'
  const pull = (patch: Partial<RepoPull>): RepoPull => ({
    number: 1,
    state: 'closed',
    mergedAt: null,
    closedAt: null,
    branch: 'agent-chat/sx-dm-1-a',
    headSha: 'h1',
    ...patch,
  })
  /** 100 newer PRs on other branches fill the first page of the repo's pull list, as in any busy repo. */
  const busy = Array.from({ length: 100 }, (_, i) =>
    pull({ number: 1000 + i, branch: `agent-chat/other-${i}` }),
  )
  let calls: string[][] = []

  /** A fake GitHub: `git` reads the checkout's origin, `gh` lists pulls, filtered by `head=` when it is given. */
  const github =
    (pulls: RepoPull[] | undefined, origins: Record<string, string> = { '/tmp/r1': 'demo/repo' }) =>
    (bin: string, args: string[]): RunResult => {
      calls.push([bin, ...args])
      if (bin === 'git') {
        const origin = origins[args[1] as string]
        return origin === undefined
          ? { status: 128, stdout: '', stderr: 'not a git repository' }
          : { status: 0, stdout: `https://github.com/${origin}.git\n` }
      }
      if (pulls === undefined) return { status: 1, stdout: '', stderr: 'HTTP 502' }
      const head = new URL(`https://x/${args[1]}`).searchParams.get('head')
      const listed =
        head === null ? [...busy, ...pulls].slice(0, 100) : pulls.filter(p => `demo:${p.branch}` === head)
      return { status: 0, stdout: listed.map(p => JSON.stringify(p)).join('\n') }
    }

  afterEach(() => {
    calls = []
  })

  it("finds a merged PR on the agent's branch past the first page of a busy repo", () => {
    const prOf = branchPrReader(
      ['/tmp/r1'],
      github([pull({ mergedAt: '2026-10-11T00:00:00Z', number: 7, headSha: 'h7' })]),
    )

    expect(prOf('sx-dm-1-a', SINCE)).toEqual({ kind: 'merged', pr: 'demo/repo#7', head: 'h7' })
  })

  it('says a live agent in a busy repo has no PR, so seeding leaves its slice alone rather than waiting', () => {
    const prOf = branchPrReader(['/tmp/r1'], github([]))
    const records = [
      { ts: SINCE, task: 'DM-1', agent: 'sx-dm-1-c', outcome: 'dispatched' },
    ] as DispatchRecord[]

    const result = seedSlices(PARENT, PLAN, EMPTY_LEDGER, NOW, () =>
      offLedgerRunsIn(records, ['sx-dm-1-c'], prOf),
    )

    expect(result).toMatchObject({
      notes: [
        'left demo DM-1 slice c to sx-dm-1-c, which ran outside the ledger and has no open or merged PR',
      ],
    })
    expect(JSON.stringify(result)).not.toContain('seeding waits a tick')
  })

  it('reads each checkout origin once however many agents are looked up', () => {
    const prOf = branchPrReader(['/tmp/r1', '/tmp/r1'], github([]))

    prOf('sx-dm-1-a', SINCE)
    prOf('sx-dm-1-b', SINCE)

    expect(calls.filter(c => c[0] === 'git')).toHaveLength(1)
  })

  it('does not count a merge from before the run was dispatched', () => {
    const prOf = branchPrReader(['/tmp/r1'], github([pull({ mergedAt: '2026-10-01T00:00:00Z' })]))

    expect(prOf('sx-dm-1-a', SINCE)).toEqual({ kind: 'none' })
  })

  it('takes a checkout with no GitHub origin to hold no PR', () => {
    expect(branchPrReader(['/tmp/notes'], github([]))('sx-dm-1-a', SINCE)).toEqual({ kind: 'none' })
  })

  it('cannot tell only when the pulls read fails', () => {
    expect(branchPrReader(['/tmp/r1'], github(undefined))('sx-dm-1-a', SINCE)).toBeUndefined()
  })

  it("adopts in a seat with a non-git repo, reading only the task's initiative", () => {
    const merged = pull({ mergedAt: '2026-10-11T00:00:00Z', number: 7, headSha: 'h7' })
    const exec = github([merged], { '/tmp/r1': 'demo/repo', '/tmp/r2': 'other/repo' })
    const readers = initiativePrReaders(
      { repos: { demo: ['/tmp/r1', '/tmp/notes'], other: ['/tmp/r2'] }, nonGitRepos: ['/tmp/notes'] },
      exec,
    )

    expect(readers('demo')('sx-dm-1-a', SINCE)).toEqual({ kind: 'merged', pr: 'demo/repo#7', head: 'h7' })
    expect(calls.filter(c => c[0] === 'git').map(c => c[2])).toEqual(['/tmp/r1'])
  })
})
