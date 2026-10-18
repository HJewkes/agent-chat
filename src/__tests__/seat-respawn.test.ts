import { describe, expect, it } from 'vitest'
import type { SeatRelaunchPlan } from '../agents/seats/seat-target.js'
import type { SeatAgent } from '../agents/seats/watchdog.js'
import type { BrokerClient } from '../client/broker-client.js'
import { respawnSeat } from '../cli/verbs/seat-respawn.js'

/** CC-959 slice c: what the watchdog sends to bring a seat back on its own account. */

const PERSONAL = '/home/example/.profiles/personal'
const SEAT_CWD = '/home/example/projects'
const HEADLESS = { surface: 'headless' as const, from: 'seat file' }

function broker(replies: Record<string, unknown>[]): {
  frames: Record<string, unknown>[]
  client: BrokerClient
} {
  const frames: Record<string, unknown>[] = []
  const request = async (frame: Record<string, unknown>) => (frames.push(frame), replies.shift())
  return { frames, client: { request } as unknown as BrokerClient }
}

const handStarted: SeatAgent = {
  name: 'seat-x',
  profile: '',
  state: 'exited',
  spawnedBy: 'human',
  agentId: '51174805',
  origin: 'adopted',
  sessionId: '7016a7ee',
  cwd: SEAT_CWD,
}

/** Teleport 138, the last row the broker launched: its profile is the one the seat was granted. */
const onServer: SeatAgent = {
  ...handStarted,
  agentId: '7b1a88f1',
  origin: 'spawned',
  profile: 'lead',
  sessionId: 'f94d8441',
  configDir: '/home/example/.profiles/server',
}

/** The incident: teleport 138 spawned on server, then teleport 140 started by hand on personal. */
const incident: SeatRelaunchPlan = {
  target: {
    kind: 'resume-session',
    latest: handStarted,
    sessionId: '7016a7ee',
    cwd: SEAT_CWD,
    stale: ['7b1a88f1'],
    spawned: onServer,
  },
  // CC-959 review: whoever can write the seat file must not pick the profile or the cwd.
  account: { configDir: PERSONAL, poolDir: PERSONAL, profile: 'operator', cwd: '/home/example/elsewhere' },
  message: 'Watchdog: resume',
  fresh: 'HANDOFF',
}

/** CC-1053: teleport 140 is the owner's `claude --resume` of a session a spawned row of the seat ran as. */
const resumedBySeat: SeatAgent = {
  ...onServer,
  agentId: 'g7',
  sessionId: '7016a7ee',
  state: 'retired',
  spawnedAt: 0,
}
const rowsOf = (...agents: SeatAgent[]) => ({ t: 'agents_result', agents })
const lineage = rowsOf(onServer, resumedBySeat)
const ROWS = { t: 'agents', includeRetired: true }

const retired = (agentId: string) => ({ t: 'spawn_result', ok: true, agentId, name: 'seat-x' })
const spawned = { t: 'spawn_result', ok: true, agentId: 'new' }

describe('respawnSeat', () => {
  // Catches: the retire sent by name, the configDir dropped, or the latest session not resumed.
  it('retires the stale row by id, then resumes the latest session on the seat file account', async () => {
    const b = broker([lineage, retired('7b1a88f1'), spawned])

    const out = await respawnSeat(b.client, 'seat-x', incident, HEADLESS)

    expect(b.frames).toEqual([
      ROWS,
      { t: 'retire', name: 'seat-x', agentId: '7b1a88f1' },
      {
        t: 'spawn',
        name: 'seat-x',
        profile: 'lead',
        brief: 'Watchdog: resume',
        isolation: 'none',
        surface: 'headless',
        configDir: PERSONAL,
        returnContract: 'none',
        cwd: SEAT_CWD,
        resumeSession: '7016a7ee',
      },
    ])
    expect(out).toEqual({
      ok: true,
      detail: `relaunched session 7016a7ee on ${PERSONAL}, headless (seat file)`,
    })
  })

  // Catches: no fallback when the transcript is not on the seat's account.
  it('spawns fresh on the handoff when the broker refuses the session', async () => {
    const refused = {
      t: 'spawn_result',
      ok: false,
      reason: 'no transcript found at /x for resume_session 7016a7ee. Not spawned',
    }
    const b = broker([lineage, retired('7b1a88f1'), refused, spawned])

    const out = await respawnSeat(b.client, 'seat-x', incident, HEADLESS)

    expect(b.frames[3]).toMatchObject({ t: 'spawn', brief: 'HANDOFF', configDir: PERSONAL })
    expect(b.frames[3]).not.toHaveProperty('resumeSession')
    expect(out.ok).toBe(true)
    expect(out.detail).toMatch(/^relaunched fresh \(no transcript found/)
  })

  // Catches: an old broker's retire by name read as success, which would launch past an unchecked lease.
  it('launches nothing when the broker retired by name and echoed no id', async () => {
    const b = broker([lineage, { t: 'spawn_result', ok: true }])

    const out = await respawnSeat(b.client, 'seat-x', incident, HEADLESS)

    expect(b.frames).toHaveLength(2)
    expect(out).toMatchObject({ ok: false, refused: true })
  })

  it('launches nothing when the broker refuses the retire', async () => {
    const b = broker([
      lineage,
      {
        ...retired('7b1a88f1'),
        ok: false,
        reason: 'agent 7b1a88f1 (seat-x) is still live; not retired',
      },
    ])

    const out = await respawnSeat(b.client, 'seat-x', incident, HEADLESS)

    expect(b.frames).toHaveLength(2)
    expect(out).toEqual({
      ok: false,
      refused: true,
      detail: 'retire 7b1a88f1 refused: agent 7b1a88f1 (seat-x) is still live; not retired',
    })
  })

  // CC-959 review, fails on b1b3297c: the retire cannot be undone, so a spawn the broker then refuses
  // (machine guard, slots, budget) must reach the human, naming what was retired and how to relaunch it.
  it('raises a spawn refused after the retire, naming the retired row and its profile and cwd', async () => {
    const machine = {
      t: 'spawn_result',
      ok: false,
      code: 'machine_memory_floor',
      reason: 'memory below floor',
    }
    const b = broker([lineage, retired('7b1a88f1'), machine])

    const out = await respawnSeat(b.client, 'seat-x', incident, HEADLESS)

    expect(out).toEqual({
      ok: false,
      refused: true,
      detail: `spawn refused: memory below floor; already retired 7b1a88f1 (profile lead, cwd ${SEAT_CWD})`,
    })
  })

  // CC-959 review: the next run's roster has no unretired spawned row, so the grant comes from the retired one.
  it('takes the granted profile from a retired spawned row when the roster has none left', async () => {
    const { spawned: _gone, ...afterRetire } = incident.target as Extract<
      SeatRelaunchPlan['target'],
      { kind: 'resume-session' }
    >
    const plan: SeatRelaunchPlan = { ...incident, target: { ...afterRetire, stale: [] } }
    const rows = [
      { ...resumedBySeat, profile: 'oldest' },
      { ...onServer, agentId: 'g8', profile: 'older', spawnedAt: 1, state: 'retired' },
      { ...onServer, spawnedAt: 2, state: 'retired' },
      { ...handStarted, profile: 'adopted', spawnedAt: 3 },
      { ...onServer, name: 'seat-w', agentId: 'w1', profile: 'other', spawnedAt: 4 },
    ]
    const b = broker([{ t: 'agents_result', agents: rows }, spawned])

    const out = await respawnSeat(b.client, 'seat-x', plan, HEADLESS)

    expect(b.frames[0]).toEqual({ t: 'agents', includeRetired: true })
    expect(b.frames[1]).toMatchObject({
      t: 'spawn',
      profile: 'lead',
      cwd: SEAT_CWD,
      resumeSession: '7016a7ee',
    })
    expect(out.ok).toBe(true)
  })

  // Catches: a fresh launch that leaves the latest wrong-account row leasing the name, which the broker refuses.
  it('retires a latest spawned row on another account too, then spawns fresh with Remote Control', async () => {
    const g10: SeatAgent = { ...onServer, agentId: 'g10' }
    const plan: SeatRelaunchPlan = {
      ...incident,
      target: { kind: 'fresh', latest: g10, stale: ['g9'], spawned: g10 },
    }
    const b = broker([retired('g9'), retired('g10'), spawned])

    await respawnSeat(b.client, 'seat-x', plan, { surface: 'tmux-window', from: 'seat file' })

    expect(b.frames.map(f => f.agentId ?? f.t)).toEqual(['g9', 'g10', 'spawn'])
    expect(b.frames[2]).toMatchObject({
      brief: 'HANDOFF',
      surface: 'tmux-window',
      remoteControl: true,
      configDir: PERSONAL,
      profile: 'lead',
      cwd: SEAT_CWD,
    })
  })

  // CC-1453: a hand-started seat's teleport successor leases the name, so a fresh spawn behind it was refused.
  it('retires a latest teleport successor on another account before the fresh spawn', async () => {
    const successor: SeatAgent = { ...handStarted, agentId: 'g6', teleportFrom: 'g5', configDir: '/x/server' }
    const plan: SeatRelaunchPlan = {
      ...incident,
      target: { kind: 'fresh', latest: successor, stale: [], spawned: onServer },
    }
    const b = broker([retired('g6'), spawned])

    await respawnSeat(b.client, 'seat-x', plan, HEADLESS)

    expect(b.frames.map(f => f.agentId ?? f.t)).toEqual(['g6', 'spawn'])
  })

  // Catches: the profile or cwd read from the seat file again; the unregistered spawn skips the broker's escalation and cwd rules.
  it('ignores a profile and cwd the seat file names, on the resume and on the fresh fallback', async () => {
    const refused = { t: 'spawn_result', ok: false, reason: 'no transcript for resume_session 7016a7ee' }
    const b = broker([lineage, retired('7b1a88f1'), refused, spawned])

    await respawnSeat(b.client, 'seat-x', incident, HEADLESS)

    expect(b.frames.slice(2).map(f => [f.profile, f.cwd])).toEqual([
      ['lead', SEAT_CWD],
      ['lead', SEAT_CWD],
    ])
  })

  // Catches: falling back to the seat file's profile when no row was ever launched by the broker.
  it('refuses, retiring nothing, when no spawned row gives the seat a granted profile', async () => {
    const { spawned: _granted, ...noGrant } = incident.target as Extract<
      SeatRelaunchPlan['target'],
      { kind: 'resume-session' }
    >
    const b = broker([{ t: 'agents_result', agents: [handStarted] }])

    const out = await respawnSeat(b.client, 'seat-x', { ...incident, target: noGrant }, HEADLESS)

    expect(b.frames).toEqual([{ t: 'agents', includeRetired: true }])
    expect(out).toEqual({
      ok: false,
      refused: true,
      detail: 'not relaunched: no spawned row under the seat name to take its granted profile from',
    })
  })

  it('refuses when the granted row recorded no cwd', async () => {
    const { cwd: _cwd, ...noCwd } = onServer
    const plan: SeatRelaunchPlan = {
      ...incident,
      target: { kind: 'fresh', latest: noCwd, stale: [], spawned: noCwd },
    }
    const b = broker([])

    const out = await respawnSeat(b.client, 'seat-x', plan, HEADLESS)

    expect(b.frames).toEqual([])
    expect(out).toEqual({ ok: false, refused: true, detail: 'not relaunched: row 7b1a88f1 recorded no cwd' })
  })

  // A visible resume launches with no prompt; catches the resume message dropped there.
  it('sends the resume message as a held send after a visible session relaunch', async () => {
    const sent = { t: 'send_result', ok: true, msgId: 'm7', recipients: ['seat-x'] }
    const b = broker([lineage, retired('7b1a88f1'), spawned, sent])

    const out = await respawnSeat(b.client, 'seat-x', incident, { surface: 'tmux-window', from: 'seat file' })

    expect(b.frames[3]).toEqual({
      t: 'human_send',
      to: 'seat-x',
      text: 'Watchdog: resume',
      source: 'watchdog',
    })
    expect(out.detail).toBe(`relaunched session 7016a7ee on ${PERSONAL}, tmux-window (seat file); message m7`)
  })

  it('falls back to headless when the visible launch fails', async () => {
    const b = broker([
      lineage,
      retired('7b1a88f1'),
      { t: 'spawn_result', ok: false, code: 'surface_refused', reason: 'iTerm2 is down' },
      spawned,
    ])

    const out = await respawnSeat(b.client, 'seat-x', incident, {
      surface: 'iterm-window',
      from: 'seat file',
    })

    expect(b.frames[3]).toMatchObject({ surface: 'headless', resumeSession: '7016a7ee' })
    expect(b.frames[3]).not.toHaveProperty('remoteControl')
    expect(out.detail).toBe(
      `relaunched session 7016a7ee on ${PERSONAL}, headless (iterm-window refused: iTerm2 is down)`,
    )
  })

  // CC-1053, catches: the check dropped, or moved after the retire (a retire frame appears).
  it('refuses, retiring nothing, a seat file config_dir that is neither the pool dir nor the spawned row dir', async () => {
    const plan: SeatRelaunchPlan = {
      ...incident,
      account: { ...incident.account, configDir: '/home/example/.profiles/workout' },
    }
    const b = broker([lineage, retired('7b1a88f1'), spawned])

    const out = await respawnSeat(b.client, 'seat-x', plan, HEADLESS)

    expect(b.frames).toEqual([ROWS])
    expect(out).toEqual({
      ok: false,
      refused: true,
      detail:
        "not relaunched: seat config_dir /home/example/.profiles/workout is neither its pool's " +
        `(${PERSONAL}) nor spawned row 7b1a88f1's (/home/example/.profiles/server)`,
    })
  })

  // CC-1053, catches: an allow-list that holds only the pool dir.
  it("relaunches on a seat file config_dir that matches the spawned row's recorded dir", async () => {
    const server = '/home/example/.profiles/server'
    const plan: SeatRelaunchPlan = { ...incident, account: { ...incident.account, configDir: server } }
    const b = broker([lineage, retired('7b1a88f1'), spawned])

    const out = await respawnSeat(b.client, 'seat-x', plan, HEADLESS)

    expect(b.frames[2]).toMatchObject({ t: 'spawn', configDir: server })
    expect(out.ok).toBe(true)
  })

  // CC-1053, catches: comparing against the spawned row's dir only, which refuses the pool's own account.
  it("relaunches on the pool's dir when the spawned row recorded another", async () => {
    const plan: SeatRelaunchPlan = { ...incident, account: { configDir: PERSONAL, poolDir: PERSONAL } }
    const b = broker([lineage, retired('7b1a88f1'), spawned])

    const out = await respawnSeat(b.client, 'seat-x', plan, HEADLESS)

    expect(b.frames[2]).toMatchObject({ t: 'spawn', configDir: PERSONAL })
    expect(out.ok).toBe(true)
  })

  // CC-1053, catches: skipping withoutLineage, or a downgrade that drops the adopted latest's origin
  // (it would then be retired as a lease holder).
  it('spawns fresh on the handoff, sending no resume note, when no spawned row ran as the adopted session', async () => {
    const b = broker([rowsOf(onServer), retired('7b1a88f1'), spawned])

    const out = await respawnSeat(b.client, 'seat-x', incident, { surface: 'tmux-window', from: 'seat file' })

    expect(b.frames.map(f => f.agentId ?? f.t)).toEqual(['agents', '7b1a88f1', 'spawn'])
    expect(b.frames[2]).toMatchObject({
      brief: 'HANDOFF',
      profile: 'lead',
      cwd: SEAT_CWD,
      configDir: PERSONAL,
    })
    expect(b.frames[2]).not.toHaveProperty('resumeSession')
    expect(out).toEqual({ ok: true, detail: `relaunched fresh on ${PERSONAL}, tmux-window (seat file)` })
  })

  // CC-1053, catches: lineage read from every row the broker returns rather than the seat's own.
  it("spawns fresh when only another seat's spawned row ran as the adopted session", async () => {
    const otherSeat: SeatAgent = { ...resumedBySeat, name: 'seat-w' }
    const b = broker([rowsOf(onServer, otherSeat), retired('7b1a88f1'), spawned])

    await respawnSeat(b.client, 'seat-x', incident, HEADLESS)

    expect(b.frames[2]).toMatchObject({ t: 'spawn', brief: 'HANDOFF' })
    expect(b.frames[2]).not.toHaveProperty('resumeSession')
  })
})
