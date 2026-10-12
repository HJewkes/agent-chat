import { describe, expect, it } from 'vitest'
import type { Pool } from '../agents/seats/charter.js'
import { accountRefusal, seatAccount } from '../agents/seats/seat-account.js'
import { seatTarget, spawnLineage, withoutLineage } from '../agents/seats/seat-target.js'
import type { SeatAgent } from '../agents/seats/watchdog.js'

const SERVER = '/home/example/.profiles/server'
const PERSONAL = '/home/example/.profiles/personal'
const HOUR = 3_600_000

const row = (agentId: string, extra: Partial<SeatAgent>): SeatAgent => ({
  name: 'lead-seat',
  profile: 'lead',
  state: 'exited',
  spawnedBy: 'human',
  agentId,
  sessionId: `session-${agentId}`,
  cwd: '/home/example/projects',
  ...extra,
})

/** The incident's shape: the last spawned generation on the server account, then two started by hand on personal. */
const INCIDENT: SeatAgent[] = [
  row('teleport-138', { origin: 'spawned', generation: 9, configDir: SERVER, spawnedAt: 1 * HOUR }),
  row('teleport-139', { origin: 'adopted', spawnedAt: 5 * HOUR }),
  row('teleport-140', { origin: 'adopted', spawnedAt: 12 * HOUR }),
]

describe('seatTarget (CC-959)', () => {
  // Catches: the newest-pick narrowed back to spawned rows, which returns resume-by-name and wakes teleport 138.
  it('picks the newest adopted session over an older spawned row on another account', () => {
    const target = seatTarget(INCIDENT, 'lead-seat', { configDir: PERSONAL })

    expect(target).toMatchObject({
      kind: 'resume-session',
      sessionId: 'session-teleport-140',
      stale: ['teleport-138'],
    })
  })

  // CC-959 review: the relaunch takes its profile and cwd from this row, so it must be the broker's own launch.
  it('names the newest spawned row as the one the seat was granted, never an adopted one', () => {
    const target = seatTarget(INCIDENT, 'lead-seat', { configDir: PERSONAL })

    expect(target).toMatchObject({ spawned: { agentId: 'teleport-138', origin: 'spawned' } })
  })

  // Catches: the configDir comparison dropped.
  it('relaunches fresh when the newest spawned row ran on an account the seat file no longer names', () => {
    const agents = [row('g2', { origin: 'spawned', configDir: SERVER, spawnedAt: HOUR })]

    expect(seatTarget(agents, 'lead-seat', { configDir: PERSONAL })).toMatchObject({
      kind: 'fresh',
      stale: [],
    })
  })

  // Catches: the comparison inverted, which would refuse every healthy seat.
  it('resumes by name when the newest spawned row is on the seat file account', () => {
    const agents = [
      row('g1', { origin: 'spawned', configDir: SERVER, spawnedAt: HOUR }),
      row('g2', { origin: 'spawned', configDir: `${PERSONAL}/`, spawnedAt: 2 * HOUR }),
    ]

    expect(seatTarget(agents, 'lead-seat', { configDir: PERSONAL })).toEqual({ kind: 'resume-by-name' })
  })

  it('never resumes by name a spawned row whose account was not recorded', () => {
    const agents = [row('g1', { origin: 'spawned', spawnedAt: HOUR })]

    expect(seatTarget(agents, 'lead-seat', { configDir: PERSONAL }).kind).toBe('fresh')
  })

  it('relaunches fresh when the newest adopted row recorded another account', () => {
    const agents = [row('a1', { origin: 'adopted', configDir: SERVER, spawnedAt: HOUR })]

    expect(seatTarget(agents, 'lead-seat', { configDir: PERSONAL }).kind).toBe('fresh')
  })

  it('leaves a seat with no row to the broker, which has nothing to resume either', () => {
    expect(seatTarget([], 'lead-seat', { configDir: PERSONAL })).toEqual({ kind: 'resume-by-name' })
  })
})

describe('seatAccount (CC-959)', () => {
  const pool = (configDir: string): Pool => ({
    name: 'server',
    configDir,
    humanUses: true,
    rule: { reserve_seven_day: 35, ceiling_five_hour: 70 },
  })
  const pools = new Map([['server', pool(SERVER)]])

  // Catches: reading only the pool, which put the incident's resume on the server account.
  it('takes the seat file config_dir over the pool, expanding ~', () => {
    const file = '---\npool: server\nconfig_dir: ~/.profiles/personal\nprofile: lead\ncwd: ~/projects\n---\n'

    expect(seatAccount(file, pools, '/home/example')).toEqual({
      configDir: PERSONAL,
      poolDir: SERVER,
      profile: 'lead',
      cwd: '/home/example/projects',
    })
  })

  it("falls back to the pool's dir, and to none when the pool is unknown", () => {
    expect(seatAccount('---\npool: server\n---\n', pools, '/home/example')).toEqual({
      configDir: SERVER,
      poolDir: SERVER,
    })
    expect(seatAccount('---\npool: other\n---\n', pools, '/home/example')).toBeUndefined()
  })
})

describe('accountRefusal (CC-1053)', () => {
  const row: SeatAgent = {
    name: 'lead-seat',
    profile: 'lead',
    state: 'exited',
    spawnedBy: 'human',
    agentId: 'g1',
  }

  // Catches: a raw string compare without home expansion or trailing-slash normalisation.
  it('allows a dir equal to the pool dir or the spawned row dir after normalising', () => {
    const home = '/home/example'
    expect(
      accountRefusal({ configDir: '~/.profiles/personal', poolDir: PERSONAL }, row, home),
    ).toBeUndefined()
    expect(
      accountRefusal({ configDir: `${PERSONAL}/` }, { ...row, configDir: PERSONAL }, home),
    ).toBeUndefined()
  })

  it('names both allowed dirs when the config_dir matches neither', () => {
    const refusal = accountRefusal({ configDir: PERSONAL, poolDir: SERVER }, { ...row, configDir: '' })

    expect(refusal).toBe(
      `seat config_dir ${PERSONAL} is neither its pool's (${SERVER}) nor spawned row g1's (unrecorded)`,
    )
  })
})

describe('spawnLineage (CC-1053)', () => {
  const adopted = row('teleport-140', { origin: 'adopted', sessionId: 'shared' })

  it('holds when a retired spawned row of the seat ran as the adopted session', () => {
    const rows = [row('teleport-138', { origin: 'spawned', state: 'retired', sessionId: 'shared' }), adopted]

    expect(spawnLineage(adopted, rows)).toBe(true)
  })

  it('fails when no spawned row of the seat ran as the adopted session', () => {
    expect(spawnLineage(adopted, INCIDENT)).toBe(false)
  })

  // Catches: dropping the name filter.
  it("fails when only another seat's spawned row ran as it", () => {
    const other = row('w1', { name: 'other-seat', origin: 'spawned', sessionId: 'shared' })

    expect(spawnLineage(adopted, [other, adopted])).toBe(false)
  })

  // Catches: dropping the origin filter, which makes an adopted row its own lineage.
  it('fails when only an adopted row carries the session id', () => {
    expect(spawnLineage(adopted, [adopted])).toBe(false)
  })
})

describe('withoutLineage (CC-1053)', () => {
  const target = seatTarget(INCIDENT, 'lead-seat', { configDir: PERSONAL })

  it('turns a resume of a session with no lineage into a fresh launch that keeps the adopted latest', () => {
    expect(withoutLineage(target, INCIDENT)).toEqual({
      kind: 'fresh',
      latest: INCIDENT[2],
      stale: ['teleport-138'],
      spawned: INCIDENT[0],
    })
  })

  it('keeps the resume when a spawned row of the seat ran as the session', () => {
    const rows = [...INCIDENT, row('teleport-137', { origin: 'spawned', sessionId: 'session-teleport-140' })]

    expect(withoutLineage(target, rows)).toBe(target)
  })
})
