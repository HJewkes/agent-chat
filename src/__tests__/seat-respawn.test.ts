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
  name: 'titan-coord',
  profile: '',
  state: 'exited',
  spawnedBy: 'human',
  agentId: '51174805',
  origin: 'adopted',
  sessionId: '7016a7ee',
  cwd: SEAT_CWD,
}

/** The incident: teleport 138 spawned on server, then teleport 140 started by hand on personal. */
const incident: SeatRelaunchPlan = {
  target: {
    kind: 'resume-session',
    latest: handStarted,
    sessionId: '7016a7ee',
    cwd: SEAT_CWD,
    stale: ['7b1a88f1'],
  },
  account: { configDir: PERSONAL, profile: 'lead', cwd: SEAT_CWD },
  message: 'Watchdog: resume',
  fresh: 'HANDOFF',
}

const retired = (agentId: string) => ({ t: 'spawn_result', ok: true, agentId, name: 'titan-coord' })
const spawned = { t: 'spawn_result', ok: true, agentId: 'new' }

describe('respawnSeat', () => {
  // Catches: the retire sent by name, the configDir dropped, or the latest session not resumed.
  it('retires the stale row by id, then resumes the latest session on the seat file account', async () => {
    const b = broker([retired('7b1a88f1'), spawned])

    const out = await respawnSeat(b.client, 'titan-coord', incident, HEADLESS)

    expect(b.frames).toEqual([
      { t: 'retire', name: 'titan-coord', agentId: '7b1a88f1' },
      {
        t: 'spawn',
        name: 'titan-coord',
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
    const b = broker([retired('7b1a88f1'), refused, spawned])

    const out = await respawnSeat(b.client, 'titan-coord', incident, HEADLESS)

    expect(b.frames[2]).toMatchObject({ t: 'spawn', brief: 'HANDOFF', configDir: PERSONAL })
    expect(b.frames[2]).not.toHaveProperty('resumeSession')
    expect(out.ok).toBe(true)
    expect(out.detail).toMatch(/^relaunched fresh \(no transcript found/)
  })

  // Catches: an old broker's retire by name read as success, which would launch past an unchecked lease.
  it('launches nothing when the broker retired by name and echoed no id', async () => {
    const b = broker([{ t: 'spawn_result', ok: true }])

    const out = await respawnSeat(b.client, 'titan-coord', incident, HEADLESS)

    expect(b.frames).toHaveLength(1)
    expect(out).toMatchObject({ ok: false, unsupported: true })
  })

  it('launches nothing when the broker refuses the retire', async () => {
    const b = broker([
      {
        ...retired('7b1a88f1'),
        ok: false,
        reason: 'agent 7b1a88f1 (titan-coord) is still live; not retired',
      },
    ])

    const out = await respawnSeat(b.client, 'titan-coord', incident, HEADLESS)

    expect(b.frames).toHaveLength(1)
    expect(out).toEqual({
      ok: false,
      detail: 'retire 7b1a88f1 refused: agent 7b1a88f1 (titan-coord) is still live; not retired',
    })
  })

  // Catches: a fresh launch that leaves the latest wrong-account row leasing the name, which the broker refuses.
  it('retires a latest spawned row on another account too, then spawns fresh with Remote Control', async () => {
    const onServer: SeatAgent = { ...handStarted, agentId: 'g10', origin: 'spawned', profile: 'lead' }
    const plan: SeatRelaunchPlan = { ...incident, target: { kind: 'fresh', latest: onServer, stale: ['g9'] } }
    const b = broker([retired('g9'), retired('g10'), spawned])

    await respawnSeat(b.client, 'titan-coord', plan, { surface: 'tmux-window', from: 'seat file' })

    expect(b.frames.map(f => f.agentId ?? f.t)).toEqual(['g9', 'g10', 'spawn'])
    expect(b.frames[2]).toMatchObject({
      brief: 'HANDOFF',
      surface: 'tmux-window',
      remoteControl: true,
      configDir: PERSONAL,
    })
  })

  it('falls back to headless when the visible launch fails', async () => {
    const b = broker([
      retired('7b1a88f1'),
      { t: 'spawn_result', ok: false, code: 'surface_refused', reason: 'iTerm2 is down' },
      spawned,
    ])

    const out = await respawnSeat(b.client, 'titan-coord', incident, {
      surface: 'iterm-window',
      from: 'seat file',
    })

    expect(b.frames[2]).toMatchObject({ surface: 'headless', resumeSession: '7016a7ee' })
    expect(b.frames[2]).not.toHaveProperty('remoteControl')
    expect(out.detail).toBe(
      `relaunched session 7016a7ee on ${PERSONAL}, headless (iterm-window refused: iTerm2 is down)`,
    )
  })
})
