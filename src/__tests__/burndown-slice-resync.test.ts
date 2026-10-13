import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyActions } from '../agents/burndown/advance.js'
import { readLedger, writeLedger, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { tickFromDisk, type TickBroker } from '../agents/burndown/run-tick.js'
import { resyncQueuedSlices, type PlanReader } from '../agents/burndown/seed-slices.js'
import { burndownLedgerPath } from '../paths.js'

/** CC-977: a plan edited after its slices were seeded reaches the queued claims, or names its drift. */

const NOW = new Date('2026-10-11T12:00:00.000Z')
const PLAN_PATH = '/tmp/aw/demo/sources/DM-1-plan.md'

const slice = (n: string, owns: string[], dependsOn: string[] = []) => ({
  n,
  title: `slice ${n}`,
  dependsOn,
  owns,
  points: 1,
  doneWhen: `Slice ${n} test passes.`,
})

const planText = (slices: readonly object[]): string =>
  `# DM-1 plan\n\n\`\`\`burndown-slices\n${JSON.stringify(slices, null, 2)}\n\`\`\`\n`

const queued = (n: string, owns: string[], extra: Partial<Claim> = {}): Claim => ({
  taskId: 'DM-1',
  initiative: 'demo',
  spawnedAt: NOW.toISOString(),
  phase: 'queued',
  phaseAt: NOW.toISOString(),
  slice: n,
  dependsOn: [],
  owns,
  ...extra,
})

const ledgerOf = (claims: Claim[], extra: Partial<Ledger> = {}): Ledger => ({ version: 1, claims, ...extra })
const reader =
  (text: string | undefined): PlanReader =>
  () => ({ path: PLAN_PATH, text })

describe('resyncQueuedSlices', () => {
  // Mutation caught: dropping the update action.
  it('gives a queued slice the owns its edited plan now names, with a resynced note', () => {
    const ledger = ledgerOf([queued('a', ['.changeset/*.md'])])

    const out = resyncQueuedSlices(ledger, reader(planText([slice('a', ['.changeset/tp-x.md'])])))

    expect(out.actions).toEqual([
      {
        kind: 'update',
        key: { taskId: 'DM-1', slice: 'a' },
        patch: { owns: ['.changeset/tp-x.md'], dependsOn: [], repo: undefined, contracts: undefined },
      },
    ])
    expect(out.notes).toEqual([
      `resynced demo DM-1 slice a from ${PLAN_PATH}: owns [".changeset/*.md"] -> [".changeset/tp-x.md"]`,
    ])
    expect(applyActions(ledger, out.actions, NOW).claims[0]?.owns).toEqual(['.changeset/tp-x.md'])
  })

  it('leaves a claim alone when the plan only reorders its owns', () => {
    const ledger = ledgerOf([queued('a', ['x.ts', 'y.ts'])])

    const out = resyncQueuedSlices(ledger, reader(planText([slice('a', ['y.ts', 'x.ts'])])))

    expect(out).toEqual({ actions: [], notes: [] })
  })

  it('resyncs a queued slice beside an implementing sibling and leaves the sibling alone', () => {
    const ledger = ledgerOf([
      queued('a', ['old-a.ts'], { phase: 'implementing', agentName: 'st-dm-1-a' }),
      queued('b', ['old-b.ts'], { dependsOn: ['a'] }),
    ])

    const out = resyncQueuedSlices(
      ledger,
      reader(planText([slice('a', ['new-a.ts']), slice('b', ['new-b.ts'], ['a'])])),
    )

    expect(out.actions).toHaveLength(1)
    expect(out.actions[0]).toMatchObject({ key: { slice: 'b' }, patch: { owns: ['new-b.ts'] } })
  })

  it('leaves a queued slice with a linked PR alone', () => {
    const ledger = ledgerOf([queued('a', ['old.ts'], { pr: 'https://github.com/o/r/pull/1' })])

    const out = resyncQueuedSlices(ledger, reader(planText([slice('a', ['new.ts'])])))

    expect(out.actions).toEqual([])
  })

  // Mutation caught: dropping the slice-set check.
  it.each([
    ['adds slice c', [slice('a', ['new-a.ts']), slice('b', ['b.ts']), slice('c', ['c.ts'])], '{a,b,c}'],
    ['drops slice b', [slice('a', ['new-a.ts'])], '{a}'],
  ])('gives no action and one drift note naming the fix verb when the plan %s', (_label, slices, set) => {
    const ledger = ledgerOf([queued('a', ['a.ts']), queued('b', ['b.ts'])])

    const out = resyncQueuedSlices(ledger, reader(planText(slices)))

    expect(out.actions).toEqual([])
    expect(out.notes).toEqual([
      `plan drift demo DM-1: plan slices ${set} vs ledger {a,b}; run agent-chat burndown release DM-1 to reseed`,
    ])
  })

  it('counts a slice released by hand as still in the ledger', () => {
    const ledger = ledgerOf([queued('a', ['old.ts'])], { slicesReleased: { 'DM-1': ['b'] } })

    const out = resyncQueuedSlices(ledger, reader(planText([slice('a', ['new.ts']), slice('b', ['b.ts'])])))

    expect(out.notes).toHaveLength(1)
    expect(out.notes[0]).toMatch(/^resynced /)
    expect(out.actions).toHaveLength(1)
  })

  it('gives no action and a lint note when the edited plan fails the lint', () => {
    const ledger = ledgerOf([queued('a', ['old.ts'])])

    const out = resyncQueuedSlices(ledger, reader('# DM-1 plan, no slices block\n'))

    expect(out.actions).toEqual([])
    expect(out.notes).toEqual([
      `plan drift demo DM-1: ${PLAN_PATH} fails the lint (plan has no burndown-slices block); queued slices keep their owns`,
    ])
  })

  it('changes nothing when the plan file is gone', () => {
    const ledger = ledgerOf([queued('a', ['old.ts'])])

    expect(resyncQueuedSlices(ledger, reader(undefined))).toEqual({ actions: [], notes: [] })
  })

  it('does not read the plan of a task with no waiting slice', () => {
    const ledger = ledgerOf([queued('a', ['old.ts'], { phase: 'done' })])
    const read: PlanReader = () => {
      throw new Error('read a finished task')
    }

    expect(resyncQueuedSlices(ledger, read)).toEqual({ actions: [], notes: [] })
  })
})

describe('the tick resyncs queued slices from an edited plan', () => {
  let world: string
  const saved = { ...process.env }
  const broker: TickBroker = {
    roster: async () => ({ agents: [], slots: { held: 0, cap: 36 } }),
    inboxSince: async () => [],
    spawn: async () => ({ ok: true }),
    retire: async () => ({ ok: true }),
    queue: async () => [],
    resume: async () => ({ ok: true }),
    collisionView: async () => ({ names: [], claims: [] }),
    seatSender: async () => ({
      send: async () => ({ ok: true }),
      notify: async () => ({ ok: true }),
      close: () => undefined,
    }),
  }

  beforeEach(() => {
    world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-slice-resync-')))
    process.env.AGENT_CHAT_HOME = path.join(world, 'home')
    process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(world, 'aw')
    fs.mkdirSync(path.join(world, 'home'), { recursive: true })
    fs.mkdirSync(path.join(world, 'aw', 'demo', 'sources'), { recursive: true })
    fs.writeFileSync(
      path.join(world, 'home', 'burndown.config.json'),
      JSON.stringify({ enabled: true, reportTo: 'coord', maxAgents: 3, reserveSlots: 2 }),
    )
  })

  afterEach(() => {
    process.env = { ...saved }
    fs.rmSync(world, { recursive: true, force: true })
  })

  // Mutation caught: dropping the resync step from the tick.
  it('writes the plan owns to the queued claim and prints the resynced note', async () => {
    writeLedger(burndownLedgerPath(), ledgerOf([queued('a', ['.changeset/*.md'])]))
    fs.writeFileSync(
      path.join(world, 'aw', 'demo', 'sources', 'DM-1-plan.md'),
      planText([slice('a', ['.changeset/tp-x.md'])]),
    )

    const lines = await tickFromDisk({ dryRun: false, broker, now: NOW, log: () => undefined })

    expect(readLedger(burndownLedgerPath()).claims.find(c => c.slice === 'a')?.owns).toEqual([
      '.changeset/tp-x.md',
    ])
    expect(lines.join('\n')).toContain('resynced demo DM-1 slice a')
  })
})
