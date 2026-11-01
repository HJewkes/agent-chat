import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HUMAN } from '../protocol.js'
import { operatorHoldPath } from '../paths.js'
import { machineStopStatus } from '../agents/seats/operator-stops.js'
import { machineHoldReport, machineLiftReport, type LaneHoldDeps } from '../cli/verbs/machine.js'
import { startSupervisor, type RestartHarness } from './helpers/restart-harness.js'

/** CC-1692: a broker-enforced lane hold. Every name is synthetic. */

const NOW = new Date('2026-11-01T12:00:00.000Z')
const LATER = '2026-11-01T18:00:00.000Z'

/** A stop file in memory, with the operator check and clock as the verbs take them. */
function world(caller: string | undefined = 'ops', now: Date = NOW) {
  const state: { file: string | undefined } = { file: undefined }
  const deps: LaneHoldDeps = {
    caller,
    operators: ['ops'],
    now,
    read: () => state.file,
    write: text => (state.file = text),
    remove: () => (state.file = undefined),
  }
  return { state, deps }
}

const hold = (deps: LaneHoldDeps, lanes = 'alpha,beta', until = LATER) =>
  machineHoldReport({ lanes, until, reason: 'load spike' }, deps)

const statusAt = (file: string | undefined, now: Date) =>
  machineStopStatus({
    now,
    chat: [],
    operators: ['ops'],
    stopFile: () => file,
    ownerStops: () => ({}),
    seatNames: () => [],
    readings: {} as never,
    machineStop: null,
  })

describe('machine hold and lift', () => {
  it('refuses a caller that is not a machine hold operator, writing nothing', () => {
    const { state, deps } = world('seat-x')

    const report = hold(deps)

    expect(report.ok).toBe(false)
    expect(state.file).toBeUndefined()
  })

  it('refuses a lift by a non-operator and leaves the hold', () => {
    const { state, deps } = world()
    hold(deps)

    const report = machineLiftReport({}, { ...deps, caller: 'seat-x' })

    expect(report.ok).toBe(false)
    expect(state.file).toBeDefined()
  })

  it('refuses an until in the past', () => {
    const { state, deps } = world()

    expect(hold(deps, 'alpha', '2026-11-01T11:00:00.000Z').ok).toBe(false)
    expect(state.file).toBeUndefined()
  })

  it('lists the hold in machine status without stopping the machine', () => {
    const { state, deps } = world()
    hold(deps)

    const status = statusAt(state.file, NOW)

    expect(status.holds).toEqual([
      expect.objectContaining({ by: 'ops', reason: 'load spike', lanes: ['alpha', 'beta'], until: LATER }),
    ])
    expect(status.stopped).toBe(false)
  })

  it('stops listing the hold once until passes', () => {
    const { state, deps } = world()
    hold(deps)

    expect(statusAt(state.file, new Date('2026-11-01T18:00:01.000Z')).holds).toEqual([])
  })

  it('lifts named lanes and keeps the rest, then the last lane removes the file', () => {
    const { state, deps } = world()
    hold(deps)

    machineLiftReport({ lanes: 'alpha' }, deps)
    expect(statusAt(state.file, NOW).holds[0]?.lanes).toEqual(['beta'])

    machineLiftReport({ lanes: 'beta' }, deps)
    expect(state.file).toBeUndefined()
  })

  it('lifts every lane without --lanes', () => {
    const { state, deps } = world()
    hold(deps)

    machineLiftReport({}, deps)

    expect(state.file).toBeUndefined()
  })

  it('adds lanes to a live hold', () => {
    const { state, deps } = world()
    hold(deps, 'alpha')
    hold(deps, 'beta')

    expect(statusAt(state.file, NOW).holds[0]?.lanes).toEqual(['alpha', 'beta'])
  })

  it('does not overwrite a machine-wide stop file', () => {
    const { state, deps } = world()
    state.file = JSON.stringify({ by: 'owner', since: NOW.toISOString(), reason: 'reboot' })

    expect(hold(deps).ok).toBe(false)
    expect(state.file).toContain('reboot')
  })
})

describe('the broker enforces a lane hold', () => {
  let h: RestartHarness | undefined
  afterEach(() => {
    h?.close()
    h = undefined
  })

  const holdFile = (home: string, lanes: string[], until: Date): void => {
    fs.mkdirSync(path.dirname(operatorHoldPath()), { recursive: true })
    fs.writeFileSync(
      operatorHoldPath(),
      JSON.stringify({
        by: 'ops',
        since: NOW.toISOString(),
        reason: 'load spike',
        lanes,
        until: until.toISOString(),
      }),
    )
    expect(home).toBeTruthy()
  }
  const inAnHour = (): Date => new Date(Date.now() + 3_600_000)

  it('refuses a spawn from a held lane', async () => {
    h = startSupervisor()
    holdFile(h.home, ['alpha-coord'], inAnHour())

    const outcome = await h.spawnAgent('alpha-w1', { requestedBy: 'alpha-coord' })

    expect(outcome).toMatchObject({
      ok: false,
      reason: expect.stringContaining('lane alpha-coord is on hold'),
    })
  })

  it('refuses a spawn from a worker the held lane spawned, through a chain', async () => {
    h = startSupervisor()
    h.core.append({ kind: 'agent_spawned', actor: 'alpha-coord', target: 'alpha-w1', msgId: 'a', body: 'x' })
    h.core.append({ kind: 'agent_spawned', actor: 'alpha-w1', target: 'alpha-w2', msgId: 'b', body: 'x' })
    holdFile(h.home, ['alpha-coord'], inAnHour())

    const outcome = await h.spawnAgent('alpha-w3', { requestedBy: 'alpha-w2' })

    expect(outcome.ok).toBe(false)
  })

  it('refuses a resume from a held lane', async () => {
    h = startSupervisor()
    await h.spawnAgent('beta-w1', { requestedBy: HUMAN })
    holdFile(h.home, ['alpha-coord'], inAnHour())

    const outcome = await h.supervisor.resume('beta-w1', { requestedBy: 'alpha-coord' })

    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining('on hold') })
  })

  it('allows a spawn from a lane that is not named', async () => {
    h = startSupervisor()
    holdFile(h.home, ['alpha-coord'], inAnHour())

    const outcome = await h.spawnAgent('beta-w1', { requestedBy: 'beta-coord' })

    expect(outcome.ok).toBe(true)
  })

  it('allows a spawn once until has passed', async () => {
    h = startSupervisor()
    holdFile(h.home, ['alpha-coord'], new Date(Date.now() - 1000))

    const outcome = await h.spawnAgent('alpha-w1', { requestedBy: 'alpha-coord' })

    expect(outcome.ok).toBe(true)
  })

  it('allows a spawn after the hold is lifted', async () => {
    h = startSupervisor()
    holdFile(h.home, ['alpha-coord'], inAnHour())
    fs.rmSync(operatorHoldPath())

    const outcome = await h.spawnAgent('alpha-w1', { requestedBy: 'alpha-coord' })

    expect(outcome.ok).toBe(true)
  })
})
