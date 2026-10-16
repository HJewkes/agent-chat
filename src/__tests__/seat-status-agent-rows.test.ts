import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BudgetRead } from '../agents/budget.js'
import type { MachineStatus } from '../agents/machine-guard.js'
import { seatStatus, type StatusDeps } from '../agents/seats/status.js'
import type { AgentIdentity, AgentLifecycle } from '../protocol.js'

/**
 * CC-317 b: `seats status` carries each owned agent's context fill against its role's
 * retire threshold, which CC-290 reads from the context hints (`retireThresholdK`), not
 * the charter, and the calling seat's own against `teleport_k`. Every name and reading
 * is synthetic.
 */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'score-2026-09-29')
const fixture = (file: string) => fs.readFileSync(path.join(FIXTURE, file), 'utf8')

const SEAT = 'sample-seat'
const NOW = new Date(2026, 9, 11, 10, 0)
const THRESHOLDS = '  teleport_k: 250\n'

let tmp: string

function writeAutonomy(thresholds: string): void {
  const charter = fixture('charter.md').replace(
    '  stop_short_factor: 0.8\n',
    `  stop_short_factor: 0.8\n${thresholds}`,
  )
  fs.mkdirSync(path.join(tmp, 'seats'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'charter.md'), charter)
  fs.writeFileSync(
    path.join(tmp, 'seats', `${SEAT}.md`),
    fixture('seats/sample-seat.md').replace(/\n---\n$/, '\nprefix: ss\n---\n'),
  )
}

function agent(name: string, profile: string, state: AgentLifecycle = 'live'): AgentIdentity {
  return {
    agentId: `id-${name}`,
    name,
    profile,
    state,
    origin: 'spawned',
    spawnedBy: SEAT,
    spawnedAt: 0,
    brief: 'synthetic brief',
    cwd: tmp,
    isolation: 'none',
    surface: 'headless',
    sessionId: `session-${name}`,
    lastEventAt: 0,
    generation: 1,
  }
}

const reading = (contextK: number, stale = false): BudgetRead => ({
  found: true,
  path: '/fake/budget.json',
  budget: {
    session_id: 'synthetic',
    written_at: NOW.getTime() / 1000,
    context: { input_tokens: contextK * 1000, exceeds_200k: contextK > 200 },
    cost: {},
    rate_limits: {},
  },
  age_seconds: 0,
  stale,
})

const MISSING: BudgetRead = { found: false, path: '/fake/budget.json', reason: 'no_file' }

function deps(roster: AgentIdentity[], fills: Record<string, BudgetRead>, over: Partial<StatusDeps> = {}) {
  const unreadable = (): never => {
    throw new Error('not in this fixture')
  }
  const base: StatusDeps = {
    now: () => NOW,
    autonomyRoot: tmp,
    homeDir: tmp,
    agents: async () => roster,
    waitingOwner: async () => [],
    readBudget: () => MISSING,
    loadDoc: unreadable,
    inbox: unreadable,
    poolPicks: unreadable,
    scored: unreadable,
    machine: () => ({}) as MachineStatus,
    machineStop: () => null,
    contextOf: a => fills[a.name] ?? MISSING,
  }
  return { ...base, ...over }
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-agent-rows-')))
  process.env.AGENT_CHAT_HOME = tmp
  writeAutonomy(THRESHOLDS)
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(tmp, { recursive: true, force: true })
})

const rowOf = async (roster: AgentIdentity[], fills: Record<string, BudgetRead>, name: string) =>
  (await seatStatus(deps(roster, fills), SEAT)).agents?.find(r => r.name === name)

describe('seats status agent rows', () => {
  it('holds each role to its own threshold, so 210k is due for an implementer and not for a reviewer', async () => {
    const roster = [agent('ss-impl', 'bd-implementer'), agent('ss-rev', 'bd-reviewer')]
    const fills = { 'ss-impl': reading(210), 'ss-rev': reading(210) }

    const status = await seatStatus(deps(roster, fills), SEAT)

    expect(status.agents).toEqual([
      { name: 'ss-impl', role: 'implementer', state: 'live', contextK: 210, stale: false, retireDue: true },
      { name: 'ss-rev', role: 'reviewer', state: 'live', contextK: 210, stale: false, retireDue: false },
    ])
  })

  it('retires a reviewer past 300k and a planner past 250k', async () => {
    const roster = [agent('ss-plan', 'bd-planner'), agent('ss-rev', 'bd-reviewer')]
    const fills = { 'ss-plan': reading(260), 'ss-rev': reading(310) }

    const status = await seatStatus(deps(roster, fills), SEAT)

    expect(status.agents?.map(a => [a.name, a.retireDue])).toEqual([
      ['ss-plan', true],
      ['ss-rev', true],
    ])
  })

  it('does not retire an implementer sitting exactly at its threshold', async () => {
    const row = await rowOf([agent('ss-impl', 'implementer')], { 'ss-impl': reading(200) }, 'ss-impl')

    expect(row).toMatchObject({ contextK: 200, retireDue: false })
  })

  it('takes the threshold from config.json contextHints', async () => {
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({ contextHints: { profiles: { implementer: { tokens: 150_000 } } } }),
    )

    const row = await rowOf([agent('ss-impl', 'bd-implementer')], { 'ss-impl': reading(160) }, 'ss-impl')

    expect(row).toMatchObject({ contextK: 160, retireDue: true })
  })

  it('ignores a charter that still carries retire_k', async () => {
    writeAutonomy('  retire_k: {implementer: 900, reviewer: 900, planner: 900}\n')

    const row = await rowOf([agent('ss-impl', 'implementer')], { 'ss-impl': reading(210) }, 'ss-impl')

    expect(row).toMatchObject({ contextK: 210, retireDue: true })
  })

  it('shows context but never retire-due when config.json silences the role', async () => {
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({ contextHints: { profiles: { implementer: null } } }),
    )

    const row = await rowOf([agent('ss-impl', 'implementer')], { 'ss-impl': reading(900) }, 'ss-impl')

    expect(row).toMatchObject({ contextK: 900, retireDue: false })
  })

  it('lists an exited implementer by state, unread and not retire-due', async () => {
    const row = await rowOf(
      [agent('ss-done', 'implementer', 'exited')],
      { 'ss-done': reading(400) },
      'ss-done',
    )

    expect(row).toEqual({
      name: 'ss-done',
      role: 'implementer',
      state: 'exited',
      contextK: null,
      stale: false,
      retireDue: false,
    })
  })

  it('reads a missing budget file as no fill rather than throwing', async () => {
    const row = await rowOf([agent('ss-impl', 'implementer')], {}, 'ss-impl')

    expect(row).toMatchObject({ contextK: null, stale: false, retireDue: false })
  })

  it('never retires an agent whose profile names no role', async () => {
    const row = await rowOf([agent('ss-misc', 'worker')], { 'ss-misc': reading(900) }, 'ss-misc')

    expect(row).toMatchObject({ role: 'other', contextK: 900, retireDue: false })
  })
})

describe('seats status self context', () => {
  it('flags teleport when the seat is past teleport_k', async () => {
    const status = await seatStatus(deps([], {}, { selfContext: () => reading(260, true) }), SEAT)

    expect(status.self).toEqual({ contextK: 260, stale: true, teleportDue: true })
  })

  it('is not due at a fill under teleport_k', async () => {
    const status = await seatStatus(deps([], {}, { selfContext: () => reading(240) }), SEAT)

    expect(status.self).toMatchObject({ contextK: 240, teleportDue: false })
  })

  it('is null when the seat cannot name its own session', async () => {
    const absent = await seatStatus(deps([], {}), SEAT)
    const unnamed = await seatStatus(deps([], {}, { selfContext: () => null }), SEAT)

    expect([absent.self, unnamed.self]).toEqual([null, null])
  })
})
