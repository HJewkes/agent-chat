import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSpawnerSeat, type SpawnerSeatFacts } from '../agents/seats/spawn-gate-read.js'
import {
  unprefixedSeatSpawn,
  type SeatSpawnMode,
  type UnprefixedSpawnInput,
} from '../agents/seats/spawn-gate.js'
import type { OverlapRequest } from '../agents/seats/spawn-gate-read.js'
import type { SpawnRequest } from '../agents/supervisor.js'
import { startSupervisor, type RestartHarness } from './helpers/restart-harness.js'

/** CC-965: a seat's implementer spawn named without the seat's prefix escapes its reserve. Synthetic names throughout. */

const unprefixed = (over: Partial<UnprefixedSpawnInput> = {}) =>
  unprefixedSeatSpawn({ mode: 'refuse', role: 'implementer', prefix: 'ac', name: 'fix-ab-12', ...over })

describe('a seat implementer spawn without its prefix', () => {
  it('is refused, naming the prefix it lacks', () => {
    expect(unprefixed()?.reason).toContain(
      'seat_spawn_unprefixed: implementer fix-ab-12 lacks the seat prefix ac-',
    )
  })

  it('passes under the seat prefix', () => {
    expect(unprefixed({ name: 'ac-ab-12' })).toBeUndefined()
  })

  it('needs the prefix and its dash, not just the letters', () => {
    expect(unprefixed({ name: 'acab-12' })).toBeDefined()
  })

  it.each([
    ['a reviewer', { role: 'reviewer' }],
    ['a planner', { role: 'planner' }],
    ['a fix round', { role: 'fix-round-2' }],
    ['a fix-round override', { override: 'fix-round' }],
    ['mode off', { mode: 'off' as const }],
  ])('passes %s', (_label, over) => {
    expect(unprefixed(over)).toBeUndefined()
  })
})

describe('reading the spawner seat', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  const fixture = (): { root: string } => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-spawn-unprefixed-'))
    dirs.push(root)
    fs.mkdirSync(path.join(root, 'seats'))
    fs.writeFileSync(path.join(root, 'seats', 'alpha-coord.md'), '---\nprefix: ac\npool: agents\n---\n')
    return { root }
  }

  it("reads a seat spawner's prefix whatever the spawn is named", () => {
    const paths = fixture()

    expect(readSpawnerSeat(paths, { name: 'fix-ab-12', spawner: 'alpha-coord' })).toEqual({ prefix: 'ac' })
  })

  it.each(['ops-runner', 'human', 'ac-ab-12-a'])('reads no seat for the non-seat spawner %s', spawner => {
    const paths = fixture()

    expect(readSpawnerSeat(paths, { name: 'fix-ab-12', spawner })).toBeUndefined()
  })
})

describe('the broker gating unprefixed seat spawns', () => {
  let sup: RestartHarness | undefined
  afterEach(() => {
    sup?.close()
    sup = undefined
  })

  const seatSpawner = (
    mode: SeatSpawnMode,
    spawnerSeat: (spawn: OverlapRequest) => SpawnerSeatFacts | undefined,
  ) => {
    sup = startSupervisor({ seatOverlap: { mode: () => mode, read: () => undefined, spawnerSeat } })
    return sup
  }
  const alphaCoord = () => ({ prefix: 'ac' })
  const brokerLog = (h: RestartHarness): string => {
    const file = path.join(h.home, 'broker.log')
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  }

  it("refuses a seat's unprefixed implementer and records the refusal", async () => {
    const h = seatSpawner('refuse', alphaCoord)

    const outcome = await h.spawnAgent('fix-ab-12', { profile: 'implementer' })

    expect(outcome).toMatchObject({ ok: false, code: 'seat_spawn_unprefixed', retryable: false })
    const refused = h.core.events.history(20).filter(r => r.kind === 'agent_spawn_refused')
    expect(refused).toHaveLength(1)
    expect(refused.map(r => r.text)).toEqual([expect.stringContaining('seat_spawn_unprefixed:')])
  })

  it('spawns a prefixed implementer', async () => {
    const h = seatSpawner('refuse', alphaCoord)

    expect((await h.spawnAgent('ac-ab-12', { profile: 'implementer' })).ok).toBe(true)
  })

  it.each<[string, Partial<SpawnRequest>]>([
    ['a reviewer', { profile: 'reviewer' }],
    ['a planner', { profile: 'implementer', workRole: 'planner' }],
    ['a fix-round override', { profile: 'implementer', override: 'fix-round' }],
    ['a tick spawn', { profile: 'implementer', spawnedAs: 'burndown', task: 'AB-12' }],
  ])('spawns %s under an unprefixed name', async (_label, extra) => {
    const h = seatSpawner('refuse', alphaCoord)

    expect((await h.spawnAgent('fix-ab-12', extra)).ok).toBe(true)
  })

  it('spawns when the spawner is no seat', async () => {
    const h = seatSpawner('refuse', () => undefined)

    expect((await h.spawnAgent('fix-ab-12', { profile: 'implementer' })).ok).toBe(true)
  })

  it('logs and spawns in warn mode', async () => {
    const h = seatSpawner('warn', alphaCoord)

    const outcome = await h.spawnAgent('fix-ab-12', { profile: 'implementer' })

    expect(outcome.ok).toBe(true)
    const lines = brokerLog(h)
      .split('\n')
      .filter(line => line.includes('"event":"seat_spawn_unprefixed"'))
    expect(lines).toHaveLength(1)
  })

  it('lets the spawn through when the seat cannot be read', async () => {
    const h = seatSpawner('refuse', () => {
      throw new Error('seats unreadable')
    })

    expect((await h.spawnAgent('fix-ab-12', { profile: 'implementer' })).ok).toBe(true)
    expect(brokerLog(h)).toContain('"event":"seat_spawn_gate_failed"')
  })
})
