import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SpawnRequest } from '../agents/supervisor.js'
import type { SeatSpawnRead, SeatSpawnRequest } from '../agents/seats/spawn-gate-read.js'
import { startSupervisor, type RestartHarness } from './helpers/restart-harness.js'

/** CC-485: a seat's worker spawned with no surface runs headless, so it exits at its final report. */

const iterm = (script: string): Promise<string> =>
  Promise.resolve(script.includes('is running') ? 'true' : 'fake-pane-uuid')

/** Names prefixed `ac-` belong to a seat; the budget gate itself is skipped. */
const seatRead = ({ name }: SeatSpawnRequest): SeatSpawnRead =>
  name.startsWith('ac-') ? { kind: 'skip', reason: 'synthetic seat' } : { kind: 'none' }

const COORDINATOR_PROFILE = {
  description: 'A coordinator that opens in a pane.',
  model: 'sonnet',
  role: 'coordinator',
  allowedTools: ['Read'],
  isolation: 'none',
  surface: 'iterm-pane',
}

describe('the surface a seat spawn launches on', () => {
  let h: RestartHarness | undefined
  afterEach(() => {
    h?.close()
    h = undefined
  })

  const start = (): RestartHarness => {
    h = startSupervisor({ appleScript: iterm, seatBudget: { read: seatRead } })
    return h
  }

  /** Spawns as the harness does but leaves `surface` out unless `extra` names one. */
  const spawnedSurface = async (
    harness: RestartHarness,
    name: string,
    extra: Partial<SpawnRequest> = {},
  ): Promise<string | undefined> => {
    const outcome = await harness.supervisor.spawn({
      name,
      profile: 'explorer',
      brief: 'seat spawn surface',
      requestedBy: 'human',
      cwd: harness.home,
      isolation: 'none',
      ...extra,
    })
    expect(outcome.ok).toBe(true)
    return harness.core.events
      .agentEvents()
      .find(row => row.kind === 'agent_spawned' && row.msgId === outcome.agentId)?.meta.surface
  }

  it('runs a seat worker headless when its profile says iterm-pane and no surface is passed', async () => {
    const sup = start()

    const surface = await spawnedSurface(sup, 'ac-impl')

    expect(surface).toBe('headless')
  })

  it('keeps an explicit iterm-pane on a seat worker', async () => {
    const sup = start()

    const surface = await spawnedSurface(sup, 'ac-pane', { surface: 'iterm-pane' })

    expect(surface).toBe('iterm-pane')
  })

  it("keeps the profile's surface for a spawn no seat owns", async () => {
    const sup = start()

    const surface = await spawnedSurface(sup, 'loose-impl')

    expect(surface).toBe('iterm-pane')
  })

  it("keeps a coordinator profile's surface on a seat spawn", async () => {
    const sup = start()
    fs.mkdirSync(path.join(sup.home, 'profiles'), { recursive: true })
    fs.writeFileSync(path.join(sup.home, 'profiles', 'lead.json'), JSON.stringify(COORDINATOR_PROFILE))

    const surface = await spawnedSurface(sup, 'ac-lead', { profile: 'lead' })

    expect(surface).toBe('iterm-pane')
  })
})
