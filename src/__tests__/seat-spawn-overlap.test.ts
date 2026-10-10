import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OverlapFacts } from '../agents/seats/spawn-gate-read.js'
import { readOverlap } from '../agents/seats/spawn-gate-read.js'
import { spawnOverlap, type SeatSpawnMode, type SpawnOverlapInput } from '../agents/seats/spawn-gate.js'
import { startSupervisor, type RestartHarness } from './helpers/restart-harness.js'

/** CC-932: a seat's hand spawn of a task burndown claimed, or that is brief-ready. Synthetic ids throughout. */

const claimed: OverlapFacts = { task: 'AB-12', claims: [{ holder: 'bd-ab-12' }] }
const briefed: OverlapFacts = { task: 'AB-12', claims: [], briefReady: '2026-10-09' }

const overlap = (over: Partial<SpawnOverlapInput> = {}) =>
  spawnOverlap({ mode: 'refuse', role: 'implementer', task: 'AB-12', claims: [], ...over })

describe('what a hand spawn collides with', () => {
  it('names the task and the holder of a claim', () => {
    const found = overlap({ claims: [{ holder: 'bd-ab-12' }] })

    expect(found).toMatchObject({ task: 'AB-12', holder: 'bd-ab-12' })
    expect(found?.reason).toContain('seat_spawn_overlap: task AB-12 holds a burndown claim held by bd-ab-12')
  })

  it('names the brief tag of a brief-ready task', () => {
    expect(overlap({ briefReady: '2026-10-09' })).toMatchObject({ holder: 'brief:ready=2026-10-09' })
  })

  it('passes a task nobody holds', () => {
    expect(overlap()).toBeUndefined()
  })

  it.each(['reviewer', 'planner', 'shepherd-review', 'fix-round-2'])('passes the %s role', role => {
    expect(overlap({ role, claims: [{}] })).toBeUndefined()
  })

  it('passes an explicit fix-round override', () => {
    expect(overlap({ override: 'fix-round', claims: [{}] })).toBeUndefined()
  })

  it('is silent when the mode is off', () => {
    expect(overlap({ mode: 'off', claims: [{}] })).toBeUndefined()
  })
})

describe('reading what a hand spawn collides with', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  const fixture = (): { root: string; ledgerFile: string; activeRoot: string } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-spawn-overlap-'))
    dirs.push(dir)
    fs.mkdirSync(path.join(dir, 'seats'))
    fs.writeFileSync(path.join(dir, 'seats', 'alpha-coord.md'), '---\nprefix: ac\npool: agents\n---\n')
    const tasks = path.join(dir, 'active', 'init-a', 'tasks')
    fs.mkdirSync(tasks, { recursive: true })
    fs.writeFileSync(path.join(dir, 'active', 'init-a', 'brief.md'), '---\nstate: active\n---\n')
    fs.writeFileSync(
      path.join(tasks, 'AB-12.yml'),
      'id: AB-12\ntitle: t\nstatus: open\ntags:\n  - brief:ready=2026-10-09\n',
    )
    const ledgerFile = path.join(dir, 'burndown.json')
    const claim = {
      taskId: 'AB-12',
      initiative: 'init-a',
      spawnedAt: '2026-10-09T10:00:00Z',
      phase: 'implementing',
      phaseAt: '2026-10-09T10:00:00Z',
      agentName: 'bd-ab-12',
    }
    fs.writeFileSync(ledgerFile, JSON.stringify({ version: 1, claims: [claim] }))
    return { root: dir, ledgerFile, activeRoot: path.join(dir, 'active') }
  }

  it('reads the task from the seat-prefixed name', () => {
    const facts = readOverlap(fixture(), { name: 'ac-ab-12', spawner: 'alpha-coord' })

    expect(facts).toEqual({ task: 'AB-12', claims: [{ holder: 'bd-ab-12' }], briefReady: '2026-10-09' })
  })

  it("matches the request's task id when the name sits outside the seat prefix", () => {
    const facts = readOverlap(fixture(), { name: 'hand-built', spawner: 'alpha-coord', task: 'ab-12' })

    expect(facts?.task).toBe('AB-12')
    expect(facts?.claims).toHaveLength(1)
  })

  it('names no task for an unprefixed name without a task id', () => {
    expect(readOverlap(fixture(), { name: 'hand-built', spawner: 'alpha-coord' })).toBeUndefined()
  })

  it('ignores a claim that is done', () => {
    const paths = fixture()
    const ledger = JSON.parse(fs.readFileSync(paths.ledgerFile, 'utf8'))
    ledger.claims[0].phase = 'done'
    fs.writeFileSync(paths.ledgerFile, JSON.stringify(ledger))

    expect(readOverlap(paths, { name: 'ac-ab-12', spawner: 'alpha-coord' })?.claims).toEqual([])
  })
})

describe('agent spawn under the seat spawn gate', () => {
  let h: RestartHarness | undefined
  afterEach(() => {
    h?.close()
    h = undefined
  })

  const gated = (mode: SeatSpawnMode, facts: OverlapFacts | undefined = claimed): RestartHarness => {
    h = startSupervisor({ seatOverlap: { mode: () => mode, read: () => facts } })
    return h
  }
  const eventLog = (sup: RestartHarness): string => fs.readFileSync(path.join(sup.home, 'broker.log'), 'utf8')

  it('spawns and logs seat_spawn_overlap in warn mode', async () => {
    const sup = gated('warn')

    const outcome = await sup.spawnAgent('ac-ab-12')

    expect(outcome.ok).toBe(true)
    expect(eventLog(sup)).toContain('"event":"seat_spawn_overlap"')
  })

  it('refuses in refuse mode with a code naming the claim', async () => {
    const sup = gated('refuse')

    const outcome = await sup.spawnAgent('ac-ab-12')

    expect(outcome).toEqual({
      ok: false,
      code: 'seat_spawn_overlap',
      retryable: false,
      reason: expect.stringContaining('task AB-12 holds a burndown claim held by bd-ab-12'),
    })
  })

  it('refuses a brief-ready task', async () => {
    const outcome = await gated('refuse', briefed).spawnAgent('ac-ab-12')

    expect(outcome).toMatchObject({ ok: false, code: 'seat_spawn_overlap' })
  })

  it('spawns without a log row when the mode is off', async () => {
    const sup = gated('off')

    expect((await sup.spawnAgent('ac-ab-12')).ok).toBe(true)
    expect(eventLog(sup)).not.toContain('seat_spawn_overlap')
  })

  it('passes the reviewer profile in refuse mode', async () => {
    const outcome = await gated('refuse').spawnAgent('ac-ab-12-review', { profile: 'reviewer' })

    expect(outcome.ok).toBe(true)
  })

  it('passes an explicit fix-round override in refuse mode', async () => {
    const outcome = await gated('refuse').spawnAgent('ac-ab-12-fix', { override: 'fix-round' })

    expect(outcome.ok).toBe(true)
  })

  it("passes the tick's own spawn", async () => {
    const outcome = await gated('refuse').spawnAgent('ac-ab-12', { spawnedAs: 'burndown', task: 'AB-12' })

    expect(outcome.ok).toBe(true)
  })

  it('spawns when the reader throws', async () => {
    h = startSupervisor({
      seatOverlap: {
        mode: () => 'refuse',
        read: () => {
          throw new Error('ledger unreadable')
        },
      },
    })

    expect((await h.spawnAgent('ac-ab-12')).ok).toBe(true)
  })
})
