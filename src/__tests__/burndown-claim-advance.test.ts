import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { advance, applyActions, claimKey, type Action } from '../agents/burndown/advance.js'
import {
  EMPTY_LEDGER,
  readLedger,
  readySlices,
  writeLedger,
  type Claim,
  type Ledger,
} from '../agents/burndown/ledger.js'
import { observe, type Roster } from '../agents/burndown/observe.js'
import { liveAgentOf } from '../agents/burndown/seat-tick.js'
import { seedSlices } from '../agents/burndown/seed-slices.js'
import type { ShepherdRow } from '../agents/burndown/shepherd.js'
import { linkSlicePr, releaseTask } from '../cli/verbs/burndown-release.js'
import type { AgentIdentity } from '../protocol.js'

/** CC-978: a claim whose PR merged finishes, a slice is released alone, and a hand-dispatched PR holds its slice. */

const NOW = new Date('2026-10-11T12:00:00.000Z')
const EARLIER = '2026-10-11T09:00:00.000Z'

const claim = (patch: Partial<Claim> = {}): Claim => ({
  taskId: 'CC-1',
  initiative: 'demo',
  agentId: 'a1',
  agentName: 'bd-cc-1',
  spawned: ['bd-cc-1'],
  spawnedAt: EARLIER,
  phase: 'implementing',
  phaseAt: EARLIER,
  ...patch,
})

const slice = (n: string, patch: Partial<Claim> = {}): Claim =>
  claim({
    slice: n,
    agentName: `bd-cc-1-${n}`,
    spawned: [`bd-cc-1-${n}`],
    ...(n === 'a' ? {} : { phase: 'queued', agentId: undefined, agentName: undefined, spawned: undefined }),
    dependsOn: n === 'a' ? [] : ['a'],
    ...patch,
  })

const run = (patch: Partial<ShepherdRow> = {}): ShepherdRow => ({
  repo: 'o/r',
  pr: 9,
  runId: 'run-9',
  phase: 'post-merge',
  headSha: 'h9',
  stalled: null,
  implementer: 'bd-cc-1',
  ...patch,
})

const agent = (name: string, state: AgentIdentity['state']): AgentIdentity =>
  ({
    agentId: name,
    name,
    state,
    spawnedAt: 1,
    cwd: '/nowhere',
    sessionId: 's',
    configDir: '',
  }) as AgentIdentity

/** Observe then advance, as the tick does, with Shepherd and the roster stubbed. */
async function tick(ledger: Ledger, rows: ShepherdRow[], roster: Roster = { agents: [] }): Promise<Ledger> {
  const held = ledger.claims.filter(c => c.phase !== 'done')
  const { observations } = await observe(held, roster, {
    inboxSince: async () => [],
    root: '/nowhere',
    shepherdRows: () => rows,
    landed: () => true,
    spendCap: () => undefined,
    progress: () => 'unreadable',
    activity: () => ({ ok: false, reason: 'stub' }) as never,
  })
  const actions = advance(held, observations, NOW)
  return applyActions(ledger, actions, NOW)
}

const retires = (actions: Action[]) => actions.filter(a => a.kind === 'retire')

describe('a merged PR finishes its claim (CC-978)', () => {
  it('links the PR its live agent registered, then moves the claim to done once it merges', async () => {
    const roster = { agents: [agent('bd-cc-1', 'live')] }
    const ledger = { ...EMPTY_LEDGER, claims: [claim()] }

    const linked = await tick(ledger, [run({ phase: 'ci' })], roster)
    const after = await tick(linked, [run()], roster)

    expect(linked.claims).toEqual([expect.objectContaining({ phase: 'implementing', pr: 'o/r#9' })])
    expect(after.claims).toEqual([expect.objectContaining({ phase: 'done', pr: 'o/r#9', prHead: 'h9' })])
  })

  it("never finishes a claim with no recorded PR on an earlier dispatch's merged run under its name", async () => {
    const roster = { agents: [agent('bd-cc-1', 'live')] }
    const stale = [run(), run({ pr: 8, runId: 'run-8', phase: 'done', outcome: { kind: 'merged' } })]

    const after = await tick({ ...EMPTY_LEDGER, claims: [claim()] }, stale, roster)

    expect(after.claims).toEqual([claim()])
  })

  it('retires the agent of the merged claim', () => {
    const c = claim()
    const actions = advance([c], new Map([[claimKey(c), { shepherd: { row: run() } }]]), NOW)

    expect(retires(actions)).toEqual([expect.objectContaining({ names: ['bd-cc-1'] })])
  })

  it('finishes a stalled implementing claim whose PR merged and clears the stall', async () => {
    const stalled = claim({
      pr: 'o/r#9',
      stalledReason: 'implementing past its timeout',
      stalledClass: 'stalled',
    })

    const after = await tick({ ...EMPTY_LEDGER, claims: [stalled] }, [run()])

    expect(after.claims[0]).toMatchObject({ phase: 'done' })
    expect(after.claims[0]?.stalledReason).toBeUndefined()
  })

  it('advances only merged slice a and leaves b and c queued, now ready', async () => {
    const ledger = { ...EMPTY_LEDGER, claims: [slice('a', { pr: 'o/r#9' }), slice('b'), slice('c')] }

    const after = await tick(ledger, [run({ implementer: 'bd-cc-1-a' })])

    expect(after.claims.map(c => [c.slice, c.phase])).toEqual([
      ['a', 'done'],
      ['b', 'queued'],
      ['c', 'queued'],
    ])
    expect(readySlices(after).map(c => c.slice)).toEqual(['b', 'c'])
  })

  it('leaves an implementing claim whose PR is still open, and records the PR on it', async () => {
    const after = await tick({ ...EMPTY_LEDGER, claims: [claim()] }, [run({ phase: 'ci' })], {
      agents: [agent('bd-cc-1', 'live')],
    })

    expect(after.claims).toEqual([expect.objectContaining({ phase: 'implementing', pr: 'o/r#9' })])
  })

  it("ignores another claim's open run", async () => {
    const rows = [run({ phase: 'ci', implementer: 'bd-cc-2' })]

    const after = await tick({ ...EMPTY_LEDGER, claims: [claim()] }, rows)

    expect(after.claims).toEqual([claim()])
  })

  it('leaves a claim whose recorded PR has not merged, though another run under its name has', async () => {
    const rows = [run({ pr: 8, runId: 'run-8' }), run({ phase: 'ci' })]

    const after = await tick({ ...EMPTY_LEDGER, claims: [claim({ pr: 'o/r#9' })] }, rows)

    expect(after.claims[0]?.phase).toBe('implementing')
  })
})

describe('a queued slice linked to a hand-dispatched PR (CC-978)', () => {
  const linked = (): Ledger => ({
    ...EMPTY_LEDGER,
    claims: [slice('a', { phase: 'done' }), slice('b', { pr: 'o/r#41' })],
  })

  it('is never ready for dispatch', () => {
    expect(readySlices(linked())).toEqual([])
  })

  it('stays queued while its PR is open and finishes when it merges', async () => {
    const open = await tick(linked(), [run({ pr: 41, phase: 'ci', implementer: 'someone' })])
    const merged = await tick(linked(), [run({ pr: 41, implementer: 'someone' })])

    expect(open.claims[1]?.phase).toBe('queued')
    expect(merged.claims[1]).toMatchObject({ phase: 'done', pr: 'o/r#41' })
  })
})

describe('burndown release --slice and link (CC-978)', () => {
  let home: string
  const saved = process.env.AGENT_CHAT_HOME
  const file = () => path.join(home, 'burndown.json')
  const retire = vi.fn(async (_name: string) => ({ ok: true }))

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-978-'))
    process.env.AGENT_CHAT_HOME = home
    writeLedger(file(), { ...EMPTY_LEDGER, claims: [slice('a'), slice('b'), slice('c')] })
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.AGENT_CHAT_HOME
    else process.env.AGENT_CHAT_HOME = saved
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('drops only the named slice and counts no backoff', async () => {
    const report = await releaseTask('CC-1', retire, NOW, 'a')

    const ledger = readLedger(file())
    expect(report.ok).toBe(true)
    expect(ledger.claims.map(c => c.slice)).toEqual(['b', 'c'])
    expect(ledger.releases).toBeUndefined()
    expect(readySlices(ledger).map(c => c.slice)).toEqual(['b', 'c'])
  })

  it('never re-seeds the task, even once its last slice is released', async () => {
    for (const n of ['a', 'b', 'c']) await releaseTask('CC-1', retire, NOW, n)

    const ledger = readLedger(file())
    const plan = { path: '/plan.md', text: '```burndown-slices\n```' }
    expect(ledger.claims).toEqual([])
    expect(seedSlices({ taskId: 'CC-1', initiative: 'demo' }, plan, ledger, NOW)).toEqual({
      blocked: expect.stringContaining('already queued'),
    })
  })

  it('lets a whole-task release re-seed again', async () => {
    await releaseTask('CC-1', retire, NOW, 'a')
    await releaseTask('CC-1', retire, NOW)

    expect(readLedger(file()).slicesReleased).toBeUndefined()
  })

  it('refuses a slice with no held claim', async () => {
    const report = await releaseTask('CC-1', retire, NOW, 'z')

    expect(report).toMatchObject({ ok: false, errors: ['no held claim on CC-1 slice z'] })
  })

  it('links a PR to a queued slice and refuses one that is not queued', async () => {
    const linked = await linkSlicePr('CC-1', 'b', 'o/r#41')
    const refused = await linkSlicePr('CC-1', 'a', 'o/r#42')

    expect(linked.ok).toBe(true)
    expect(refused.ok).toBe(false)
    expect(readLedger(file()).claims.map(c => c.pr)).toEqual([undefined, 'o/r#41', undefined])
  })
})

describe("a claim's agent for the implementer cap (CC-978)", () => {
  it('reads a running row as live, an exited one as gone, and a missing one as live only on a partial roster', () => {
    const roster: Roster = { agents: [agent('bd-1', 'detached'), agent('bd-2', 'exited')] }
    const live = liveAgentOf(roster)
    const partial = liveAgentOf({ ...roster, partial: 'retired rows missing' })

    expect([live('bd-1'), live('bd-2'), live('bd-3'), partial('bd-3'), partial(undefined)]).toEqual([
      true,
      false,
      false,
      true,
      false,
    ])
  })
})
