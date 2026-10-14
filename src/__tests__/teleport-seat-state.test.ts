import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { autoAttach } from './broker-harness.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { planPath } from '../agents/launch-files.js'
import type { LaunchPlan } from '../agents/types.js'
import type { SeatHandoffDeps } from '../agents/teleport.js'
import { appendSeatEvent, seatEventsPath } from '../agents/seats/seat-event-log.js'
import { SEAT_PORT_MS, type SeatStateSources } from '../agents/seats/seat-state-ports.js'
import type { ShepherdFlight } from '../agents/seats/in-flight-read.js'

/**
 * TP-1600 e: a seat's teleport composes its successor's first prompt from the seat event log and
 * the broker's reads, then closes the generation in the log. Every source is a stub, no process
 * is launched or signalled, and every name and path is synthetic.
 */

const COUNTDOWN_MS = 1000
const SEAT = 'seat-a'
const AT = '2026-10-14T09:00:00.000Z'

const tmpDirs: string[] = []
let core: BrokerCore
let supervisor: Supervisor
let stopAutoAttach: () => void
let root: string
let sources: SeatStateSources
let inboxAsked: Array<string | undefined>

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const flight: ShepherdFlight = {
  repo: 'example/widgets',
  pr: 7,
  branch: 'agent-chat/sa-fix-7',
  runId: 'run-1',
  task: 'demo/D-7',
  phase: 'review',
  headSha: 'abcdef0123456789',
  nextAction: null,
  pendingGate: null,
  held: false,
  stalled: false,
}

function stubSources(): SeatStateSources {
  return {
    inFlight: {
      roster: async () => [],
      shepherd: async () => [flight],
      verdicts: async () => [],
      claims: async () => [],
    },
    pace: async () => ({ found: true, pools: new Map([['pool-a', { behind: 3, readingAt: Date.now() }]]) }),
    recent: async () => [],
    inbox: async after => {
      inboxAsked.push(after)
      return {
        after: after ?? null,
        warning: null,
        messages: [{ msgId: '0000bb01', from: 'peer-b', text: 'rebase please' }],
      }
    },
    worktreeClaims: async () => [],
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  inboxAsked = []
  const signalled = new Set<number>()
  vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: unknown) => {
    if (signal === 0 && signalled.has(pid)) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    if (signal !== 0) signalled.add(pid)
    return true
  })
  const home = tempDir('ac-tele-seat-')
  process.env.AGENT_CHAT_HOME = home
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(home, 'active-work')
  root = tempDir('ac-seat-root-')
  fs.mkdirSync(path.join(root, 'seats'))
  fs.writeFileSync(
    path.join(root, 'seats', `${SEAT}.md`),
    `---\nname: ${SEAT}\nprefix: sa\npool: pool-a\n---\n`,
  )
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  stopAutoAttach = autoAttach(core)
  sources = stubSources()
  const seatTeleport: SeatHandoffDeps = {
    autonomyRoot: root,
    now: () => new Date(),
    shepherd: async () => undefined,
    stateSources: () => sources,
  }
  supervisor = new Supervisor(core, {
    countdownMs: COUNTDOWN_MS,
    seatTeleport,
    argvReader: () => 'claude',
    launcherRunning: async () => false,
    surface: {
      platform: 'linux',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
    },
  })
})

afterEach(() => {
  stopAutoAttach()
  supervisor.close()
  core.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete process.env.AGENT_CHAT_HOME
  delete process.env.AGENT_CHAT_ACTIVE_WORK_ROOT
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** The seat live with one message in its inbox; returns its id and that message, the cutoff. */
async function liveSeat(): Promise<{ agentId: string; cursor: string }> {
  const result = await supervisor.spawn({
    name: SEAT,
    profile: 'explorer',
    brief: 'coordinate',
    requestedBy: 'human',
    cwd: tempDir('ac-ws-'),
    isolation: 'none',
    surface: 'headless',
  })
  expect(result.ok).toBe(true)
  const { msgId: cursor } = core.append({ kind: 'message', actor: 'peer-b', target: SEAT, body: 'seen' })
  return { agentId: result.agentId as string, cursor }
}

async function teleportSeat(agentId: string): Promise<{ ok: boolean; stdin: string }> {
  const result = await supervisor.teleport({
    subject: {
      agentId,
      name: SEAT,
      cwd: tempDir('ac-ws-'),
      hostPid: 9999,
      host: os.hostname(),
      tags: [],
      subscriptions: [],
    },
    handoff: 'short note',
  })
  await vi.advanceTimersByTimeAsync(SEAT_PORT_MS + COUNTDOWN_MS)
  const plan = JSON.parse(fs.readFileSync(planPath(result.agentId as string), 'utf8')) as LaunchPlan
  return { ok: result.ok, stdin: plan.stdin ?? '' }
}

const seatEvents = (): Array<Record<string, unknown>> =>
  fs
    .readFileSync(seatEventsPath(root, SEAT), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>)

describe('a seat teleport composes the successor prompt from SeatState', () => {
  it('carries the authored block, the PR head, the background relaunch and the inbox cutoff', async () => {
    appendSeatEvent(root, SEAT, { kind: 'authored', text: 'on pr example/widgets#7: merge on green' }, AT)
    appendSeatEvent(
      root,
      SEAT,
      { kind: 'background', id: 'ci-watch', command: 'gh run watch 42', cwd: '/w/widgets' },
      AT,
    )
    const { agentId, cursor } = await liveSeat()

    const { ok, stdin } = await teleportSeat(agentId)

    expect(ok).toBe(true)
    expect(stdin).toContain('on pr example/widgets#7: merge on green')
    expect(stdin).toContain('abcdef01')
    expect(stdin).toContain('cd /w/widgets && gh run watch 42')
    expect(stdin).toContain(`== inbox after ${cursor}`)
    expect(stdin).toContain('0000bb01 peer-b: rebase please')
    expect(inboxAsked).toEqual([cursor])
    expect(stdin).not.toMatch(/(run|runs|prints).{0,20}`agent-chat seats boot/)
    expect(stdin).toContain('Do not re-run seats boot, gh pr view or git status')
  })

  it('appends authored "" and teleport after the render, so the next generation shows no stale block', async () => {
    appendSeatEvent(root, SEAT, { kind: 'authored', text: 'stale by next generation' }, AT)
    const { agentId } = await liveSeat()

    await teleportSeat(agentId)

    const [authored, teleport] = seatEvents().slice(-2)
    expect(authored).toMatchObject({ kind: 'authored', text: '' })
    expect(teleport).toMatchObject({ kind: 'teleport' })
    expect(typeof teleport?.successor).toBe('string')
  })
})

describe('a seat teleport whose sources fail', () => {
  it('reads a throwing Shepherd as unavailable and still relaunches', async () => {
    sources.inFlight.shepherd = async () => {
      throw new Error('shepherd status did not answer')
    }
    const { agentId } = await liveSeat()

    const { ok, stdin } = await teleportSeat(agentId)

    expect(ok).toBe(true)
    expect(stdin).toContain('unavailable: shepherd')
    expect(stdin).toContain('== inbox after')
    expect(seatEvents().at(-1)).toMatchObject({ kind: 'teleport' })
  })

  it('gives up on a source that never answers after the port deadline', async () => {
    sources.pace = () => new Promise(() => undefined)
    sources.inbox = () => new Promise(() => undefined)
    const { agentId } = await liveSeat()

    const { ok, stdin } = await teleportSeat(agentId)

    expect(ok).toBe(true)
    expect(stdin).toContain(`unavailable: budget (budget did not answer in ${SEAT_PORT_MS} ms)`)
    expect(stdin).toContain(`unavailable: inbox (inbox did not answer in ${SEAT_PORT_MS} ms)`)
  })
})
