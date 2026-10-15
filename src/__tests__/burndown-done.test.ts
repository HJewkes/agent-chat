import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_LEDGER, readLedger, readySlices, writeLedger, type Claim } from '../agents/burndown/ledger.js'
import { finishSlice, type DonePorts } from '../cli/verbs/burndown-done.js'

/** CC-1225: `burndown done` finishes a PR-less slice by hand so its dependents dispatch. */

const NOW = new Date('2026-10-12T12:00:00.000Z')
const EARLIER = '2026-10-12T09:00:00.000Z'
const EVIDENCE = '/evidence/TP-2577-a.md'

const claim = (patch: Partial<Claim> = {}): Claim => ({
  taskId: 'TP-2577',
  initiative: 'demo',
  slice: 'a',
  dependsOn: [],
  owns: ['sources/x.md'],
  agentId: 'tc-x-a',
  agentName: 'tc-x-a',
  spawned: ['tc-x-a'],
  spawnedAt: EARLIER,
  phase: 'implementing',
  phaseAt: EARLIER,
  ...patch,
})

const stalledA = claim({
  stalledReason: 'none. The files are in active-work sources. is not a GitHub PR Shepherd can take',
  stalledClass: 'failed',
  stalledAt: EARLIER,
  stale: { class: 'nothing-to-do', proposed: 'finish it', since: EARLIER },
})

const queuedB = claim({
  slice: 'b',
  dependsOn: ['a'],
  phase: 'queued',
  agentId: undefined,
  agentName: undefined,
  spawned: undefined,
})

const otherTask = claim({ taskId: 'TP-9', agentId: 'tc-y-a', agentName: 'tc-y-a', spawned: ['tc-y-a'] })

describe('burndown done (CC-1225)', () => {
  let home: string
  let retired: string[]
  const saved = process.env.AGENT_CHAT_HOME
  const file = () => path.join(home, 'burndown.json')
  const ports = (exists = true): DonePorts => ({
    retire: async name => {
      retired.push(name)
      return { ok: true }
    },
    exists: () => exists,
    now: NOW,
  })
  const seed = (...claims: Claim[]) => writeLedger(file(), { ...EMPTY_LEDGER, claims })
  const slice = (taskId: string, n: string) =>
    readLedger(file()).claims.find(c => c.taskId === taskId && c.slice === n)

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-1225-'))
    process.env.AGENT_CHAT_HOME = home
    retired = []
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.AGENT_CHAT_HOME
    else process.env.AGENT_CHAT_HOME = saved
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('finishes a stalled PR-less implementing slice, retires its agent, and makes its dependent ready', async () => {
    seed(stalledA, queuedB)

    const report = await finishSlice('TP-2577', 'a', EVIDENCE, ports())

    expect(report.ok).toBe(true)
    const a = slice('TP-2577', 'a')
    expect(a).toMatchObject({ phase: 'done', phaseAt: NOW.toISOString() })
    expect(a?.lastReport).toContain(EVIDENCE)
    expect(a).not.toHaveProperty('stalledReason')
    expect(a).not.toHaveProperty('stalledClass')
    expect(a).not.toHaveProperty('stale')
    expect(readySlices(readLedger(file())).map(c => c.slice)).toEqual(['b'])
    expect(retired).toEqual(['tc-x-a'])
  })

  it('finishes a queued slice with nothing to retire', async () => {
    seed(claim({ phase: 'queued', spawned: undefined }), queuedB)

    const report = await finishSlice('TP-2577', 'a', EVIDENCE, ports())

    expect(report.ok).toBe(true)
    expect(slice('TP-2577', 'a')?.phase).toBe('done')
    expect(retired).toEqual([])
  })

  it('refuses a claim with a PR and leaves the ledger unchanged', async () => {
    seed(claim({ pr: 'o/r#41' }), queuedB)
    const before = fs.readFileSync(file(), 'utf8')

    const report = await finishSlice('TP-2577', 'a', EVIDENCE, ports())

    expect(report.ok).toBe(false)
    expect(report.errors?.[0]).toContain('has PR o/r#41')
    expect(fs.readFileSync(file(), 'utf8')).toBe(before)
    expect(retired).toEqual([])
  })

  it.each(['parked', 'reviewing'] as const)('refuses a %s claim without throwing', async phase => {
    seed(claim({ phase }), queuedB)
    const before = fs.readFileSync(file(), 'utf8')

    const report = await finishSlice('TP-2577', 'a', EVIDENCE, ports())

    expect(report.ok).toBe(false)
    expect(report.errors?.[0]).toContain(`is ${phase}`)
    expect(fs.readFileSync(file(), 'utf8')).toBe(before)
  })

  it('refuses a missing evidence path', async () => {
    seed(stalledA, queuedB)
    const before = fs.readFileSync(file(), 'utf8')

    const report = await finishSlice('TP-2577', 'a', EVIDENCE, ports(false))

    expect(report.ok).toBe(false)
    expect(report.errors?.[0]).toContain(`evidence ${EVIDENCE} does not exist`)
    expect(fs.readFileSync(file(), 'utf8')).toBe(before)
  })

  it('refuses a slice with no held claim', async () => {
    seed(claim({ phase: 'done' }))

    const report = await finishSlice('TP-2577', 'a', EVIDENCE, ports())

    expect(report.errors?.[0]).toContain('no held claim on TP-2577 slice a')
  })

  it("leaves the task's other slices and other tasks' claims untouched", async () => {
    seed(stalledA, queuedB, otherTask)
    const untouched = readLedger(file()).claims.filter(c => c.slice !== 'a' || c.taskId !== 'TP-2577')

    await finishSlice('TP-2577', 'a', EVIDENCE, ports())

    expect(slice('TP-2577', 'b')).toEqual(untouched[0])
    expect(slice('TP-9', 'a')).toEqual(untouched[1])
  })
})
