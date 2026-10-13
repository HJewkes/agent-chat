import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyActions } from '../agents/burndown/advance.js'
import type { RunResult } from '../agents/burndown/exec.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import {
  branchPrReader,
  initiativePrReaders,
  offLedgerRunsIn,
  seatPrReader,
  type OffLedgerRun,
} from '../agents/burndown/off-ledger-adopt.js'
import { mergedEvents } from '../agents/burndown/slices-complete.js'
import type { ClaimPr, RepoPull } from '../agents/burndown/pr-state.js'
import {
  diskPlanReader,
  pendingOffLedger,
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

describe('a slice that ran outside the ledger with no PR at seeding, whose PR opens later', () => {
  const claim = (n: string, phase: Claim['phase']): Claim => ({
    taskId: 'DM-1',
    initiative: 'demo',
    spawnedAt: NOW.toISOString(),
    phase,
    phaseAt: NOW.toISOString(),
    slice: n,
    dependsOn: [],
    owns: [`${n}.ts`],
    seat: 'seat-x',
    namePrefix: 'sx',
  })
  const twoSlices = planText([slice('a'), slice('b')])
  const readPlan: PlanReader = (_i, _t, seat) => ({
    path: PLAN_PATH,
    text: twoSlices,
    ...(seat === undefined
      ? {}
      : { ranOffLedger: ['sx-dm-1-b'], ranSince: { 'sx-dm-1-b': NOW.toISOString() } }),
  })
  const ledger: Ledger = { version: 1, claims: [claim('a', 'queued')] }
  const github = (pr: ClaimPr | undefined) => {
    const asked: string[] = []
    const prOf = (seat: string, initiative: string) => {
      asked.push(`${seat}/${initiative}`)
      return (agent: string, since: string) => {
        asked.push(`${agent} since ${since}`)
        return pr
      }
    }
    return { prOf, asked }
  }

  it('links the PR as a shepherding claim on the next resync, with no repeated note', () => {
    const { prOf, asked } = github({ kind: 'open', pr: 'demo/repo#9' })

    const out = resyncQueuedSlices(ledger, readPlan, NOW, prOf)

    const next = applyActions(ledger, out.actions, NOW)
    expect(bySlice(next.claims).b).toMatchObject({
      phase: 'shepherding',
      pr: 'demo/repo#9',
      agentName: 'sx-dm-1-b',
      seat: 'seat-x',
    })
    expect(out.notes.join('\n')).toContain(
      'adopted demo DM-1 slice b from sx-dm-1-b as shepherding with demo/repo#9',
    )
    expect(out.notes.join('\n')).not.toContain('did not queue new slice b')
    expect(asked).toContain(`sx-dm-1-b since ${NOW.toISOString()}`)
  })

  it('adopts a merged PR as done', () => {
    const { prOf } = github({ kind: 'merged', pr: 'demo/repo#9', head: 'h9' })

    const out = resyncQueuedSlices(ledger, readPlan, NOW, prOf)

    expect(bySlice(applyActions(ledger, out.actions, NOW).claims).b).toMatchObject({
      phase: 'done',
      pr: 'demo/repo#9',
      prHead: 'h9',
    })
  })

  it('keeps holding the slice, with the note, while it still has no PR or the read failed', () => {
    for (const pr of [{ kind: 'none' as const }, undefined]) {
      const out = resyncQueuedSlices(ledger, readPlan, NOW, github(pr).prOf)

      expect(out.actions).toEqual([])
      expect(out.notes).toEqual([
        `plan drift demo DM-1: did not queue new slice b from ${PLAN_PATH}: its agent sx-dm-1-b ran outside the ledger`,
      ])
    }
  })

  it('does not mark the parent merged while the slice has no merged PR', () => {
    const done: Ledger = { version: 1, claims: [claim('a', 'done')] }
    const reader: PlanReader = readPlan

    expect(pendingOffLedger(done, reader)('demo', 'DM-1')).toEqual(['b'])
    expect(
      seedSlices(PARENT, { path: PLAN_PATH, text: twoSlices }, done, NOW, () => [ran('b', { kind: 'none' })]),
    ).toMatchObject({
      pending: ['b'],
    })
  })

  it('names the slice release as the way out of a run that never opened a PR', () => {
    const done: Ledger = { version: 1, claims: [claim('a', 'done')] }

    const result = seedSlices(PARENT, { path: PLAN_PATH, text: twoSlices }, done, NOW, () => [
      ran('b', { kind: 'none' }),
    ])

    expect(result).toMatchObject({ pending: ['b'], claims: [] })
    expect(JSON.stringify(result)).toContain('run agent-chat burndown release DM-1 --slice b')
  })

  it('adopts at seeding a run whose PR merged after every claim was done', () => {
    const done: Ledger = { version: 1, claims: [claim('a', 'done')] }

    const result = seedSlices(PARENT, { path: PLAN_PATH, text: twoSlices }, done, NOW, () => [
      ran('b', { kind: 'merged', pr: 'demo/repo#9', head: 'h9' }),
    ])

    expect(result).toMatchObject({
      pending: [],
      claims: [{ slice: 'b', phase: 'done', pr: 'demo/repo#9', agentName: 'sx-dm-1-b' }],
    })
    expect(JSON.stringify(result)).not.toContain('no open or merged PR yet')
  })

  it('adopts on resync from an all-done ledger, then tells the seat the task merged', () => {
    const done: Ledger = { version: 1, claims: [claim('a', 'done')] }
    const tasks = new Map([['demo', [{ id: 'DM-1', status: 'open' } as never]]])
    const { prOf } = github({ kind: 'merged', pr: 'demo/repo#9', head: 'h9' })

    const next = applyActions(done, resyncQueuedSlices(done, readPlan, NOW, prOf).actions, NOW)

    expect(bySlice(next.claims).b).toMatchObject({ phase: 'done', pr: 'demo/repo#9', agentName: 'sx-dm-1-b' })
    expect(mergedEvents(next, tasks, undefined, pendingOffLedger(next, readPlan))).toEqual({
      'seat-x': [expect.objectContaining({ kind: 'slices-merged', taskId: 'DM-1' })],
    })
  })

  it('does not read a task a seat was already told merged', () => {
    const told: Ledger = { version: 1, claims: [claim('a', 'done')], slicesFlagged: ['demo/DM-1'] }
    const { prOf, asked } = github({ kind: 'merged', pr: 'demo/repo#9', head: 'h9' })

    expect(resyncQueuedSlices(told, readPlan, NOW, prOf)).toEqual({ actions: [], notes: [] })
    expect(asked).toEqual([])
  })

  it('holds a run with no recorded dispatch time rather than take an older merge for its work', () => {
    const undated: PlanReader = (i, t, seat) => ({ ...readPlan(i, t, seat), ranSince: {} })
    const { prOf } = github({ kind: 'merged', pr: 'demo/repo#9', head: 'h9' })

    const out = resyncQueuedSlices(ledger, undated, NOW, prOf)

    expect(out.actions).toEqual([])
    expect(out.notes.join('\n')).toContain('did not queue new slice b')
  })

  it('tells no seat the task merged while the slice is pending', () => {
    const done: Ledger = { version: 1, claims: [claim('a', 'done')] }
    const tasks = new Map([['demo', [{ id: 'DM-1', status: 'open' } as never]]])

    expect(mergedEvents(done, tasks)).toEqual({
      'seat-x': [expect.objectContaining({ kind: 'slices-merged' })],
    })
    expect(mergedEvents(done, tasks, undefined, pendingOffLedger(done, readPlan))).toEqual({})
  })

  it('reads through the loaded seat only', () => {
    const exec = (): RunResult => ({ status: 0, stdout: '' })
    const reader = seatPrReader([{ seat: 'seat-x', repos: {} } as never], exec)

    expect(reader('seat-y', 'demo')).toBeUndefined()
    expect(reader('seat-x', 'demo')?.('sx-dm-1-b', NOW.toISOString())).toEqual({ kind: 'none' })
  })
})

describe('branchPrReader', () => {
  const SINCE = '2026-10-10T00:00:00.000Z'
  const pull = (patch: Partial<RepoPull>): RepoPull => ({
    number: 1,
    state: 'closed',
    mergedAt: null,
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
