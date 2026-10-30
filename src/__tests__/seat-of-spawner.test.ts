import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HUMAN } from '../protocol.js'
import {
  readSeatSpawn,
  type SeatSpawnRead,
  type SeatSpawnReadDeps,
  type SeatSpawnRequest,
} from '../agents/seats/spawn-gate-read.js'
import { startSupervisor, type RestartHarness } from './helpers/restart-harness.js'

/**
 * CC-1606: which seat the budget stop charges a seat-prefixed spawn to. The name prefix finds the seat, and the
 * spawner confirms it; the spawn's account (config_dir) does not, since two coordinators may share one. Every name,
 * path and reading is synthetic.
 */

const NOON = new Date(2026, 9, 25, 12, 0)
const CHARTER = `---
seats: [alpha-coord]
pools:
  agents: {config_dir: ~/agents, human_uses: false, reserve_seven_day: 25, ceiling_five_hour: 85, per_day_points: 20}
---
`

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function autonomyRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-of-spawner-'))
  dirs.push(dir)
  fs.mkdirSync(path.join(dir, 'seats'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'charter.md'), CHARTER)
  fs.writeFileSync(
    path.join(dir, 'seats', 'alpha-coord.md'),
    '---\nprefix: ac\npool: agents\ncwd: /synthetic/shared-repo\n---\n',
  )
  fs.writeFileSync(
    path.join(dir, 'seats', 'owner-desk.md'),
    '---\nprefix: od\nrole: attended\npool: agents\n---\n',
  )
  return dir
}

const deps: SeatSpawnReadDeps = {
  home: '/synthetic',
  readBudget: configDir => ({ found: false, path: configDir, reason: 'no_file' }),
  loadDoc: () => ({ seats: {}, pools: {}, stopped: {} }),
}

/** A spawn on the seat's own account, so only the name and the spawner can tell whose it is. */
const read = (root: string, name: string, spawner: string): SeatSpawnRead =>
  readSeatSpawn(root, { name, spawner, configDir: '/synthetic/agents', now: NOON }, deps)

const seatOfRead = (result: SeatSpawnRead): string | undefined =>
  result.kind === 'gate' ? result.input.seat.name : undefined

describe('the seat budget stop charges a prefixed spawn to its seat (CC-1606)', () => {
  it('leaves out a spawn another coordinator made under the seat prefix on the seat account', () => {
    const root = autonomyRoot()

    expect(read(root, 'ac-task-fix', 'other-coord')).toEqual({ kind: 'none' })
  })

  it.each([
    { spawner: 'alpha-coord', who: 'the seat itself' },
    { spawner: HUMAN, who: 'the CLI, as the burndown tick and Shepherd spawn' },
    { spawner: 'ac-task', who: "one of the seat's own agents" },
  ])('charges the seat for a spawn by $who', ({ spawner }) => {
    const root = autonomyRoot()

    expect(seatOfRead(read(root, 'ac-task-fix', spawner))).toBe('alpha-coord')
  })

  it('charges an attended seat by its prefix whatever session spawns', () => {
    const root = autonomyRoot()

    expect(seatOfRead(read(root, 'od-task', 'owner-session-2'))).toBe('owner-desk')
  })
})

describe("a CLI-spawned successor is charged as its predecessor's spawner was (TP-4560)", () => {
  let h: RestartHarness | undefined
  afterEach(() => {
    h?.close()
    h = undefined
  })

  /** The seats the gate charged, one per read, with a real seat lookup under the reader. */
  function supervisorOver(root: string): { sup: RestartHarness; charged: (string | undefined)[] } {
    const charged: (string | undefined)[] = []
    const gate = (spawn: SeatSpawnRequest): SeatSpawnRead => {
      const result = readSeatSpawn(root, { ...spawn, configDir: '/synthetic/agents' }, deps)
      charged.push(seatOfRead(result))
      return result
    }
    h = startSupervisor({ seatBudget: { read: gate } })
    return { sup: h, charged }
  }

  const recordSpawn = (harness: RestartHarness, name: string, spawner: string): void => {
    harness.core.append({
      kind: 'agent_spawned',
      actor: spawner,
      target: name,
      msgId: `id-${name}`,
      body: 'work',
    })
  }

  it('does not charge the prefix seat for the successor of an agent another session spawned', async () => {
    const { sup, charged } = supervisorOver(autonomyRoot())
    recordSpawn(sup, 'ac-task', 'other-coord')

    const outcome = await sup.spawnAgent('ac-task-s1', { requestedBy: HUMAN })

    expect(outcome.ok).toBe(true)
    expect(charged.filter(seat => seat !== undefined)).toEqual([])
  })

  it.each([
    { how: 'by its name', extra: {} },
    { how: 'as the named predecessor', extra: { predecessor: 'ac-task' } },
  ])("charges the seat for the successor of the seat's own agent, found $how", async ({ extra }) => {
    const { sup, charged } = supervisorOver(autonomyRoot())
    recordSpawn(sup, 'ac-task', 'alpha-coord')

    await sup.spawnAgent('ac-task-s1', { requestedBy: HUMAN, ...extra })

    expect(charged).toContain('alpha-coord')
  })
})
