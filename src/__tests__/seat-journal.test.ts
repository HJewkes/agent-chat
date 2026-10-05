import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { advance, claimKey } from '../agents/burndown/advance.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { deliverSeatEvents, type SeatSender } from '../agents/burndown/seat-deliver.js'
import { seatLogPath } from '../agents/seats/io.js'
import { seatJournal, type SeatJournal } from '../agents/seats/journal.js'
import { readSeatLog } from '../agents/seats/stops.js'
import { Supervisor } from '../agents/supervisor.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-316: the broker writes a seat's spawn, retire, park, merged and stalled
 * journal lines. Every seat, prefix, task id and repository here is synthetic,
 * and the autonomy root is a temp directory. The park line is in agent-park.test.ts.
 */

const SEAT = 'seat-x'
const AGENT = 'sx-ab-12-fix'
/** Local time, as the journal's clock is: 04:05 in any zone. */
const AT = new Date(2026, 1, 3, 4, 5)
const HEAD = 'abcdef1234567890abcdef1234567890abcdef12'
const PR = 'https://github.com/example-org/widget/pull/7'

const tmpDirs: string[] = []
let root: string
let core: BrokerCore
let sup: Supervisor
let stopAutoAttach: () => void
let logged: string[]

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

function autonomyRoot(): string {
  const dir = tmp('journal-root-')
  fs.mkdirSync(path.join(dir, 'seats'))
  seatFile(dir, SEAT, 'sx')
  return dir
}

const journalOver = (dir: string): SeatJournal =>
  seatJournal(dir, { now: () => AT, log: event => void logged.push(event) })

const journalText = (dir = root): string | undefined => {
  const file = seatLogPath(dir, SEAT, AT)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined
}

function seatWrote(text: string): string {
  const file = seatLogPath(root, SEAT, AT)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return text
}

const seatFile = (dir: string, seat: string, prefix: string): void =>
  fs.writeFileSync(path.join(dir, 'seats', `${seat}.md`), `---\nprefix: ${prefix}\npool: pool-a\n---\n`)

function supervisorWith(journal: SeatJournal, attachMs?: number): Supervisor {
  sup = new Supervisor(core, {
    ...(attachMs === undefined ? {} : { attachMs }),
    surface: {
      platform: 'linux',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
    },
    seatJournal: journal,
  })
  return sup
}

const spawnReq = (name: string) => ({
  name,
  profile: 'explorer',
  brief: 'do the task',
  requestedBy: 'human',
  cwd: tmp('journal-ws-'),
  isolation: 'none' as const,
  surface: 'headless' as const,
  spawnerConfigDir: tmp('journal-account-'),
})

const claim = (over: Partial<Claim> = {}): Claim => ({
  taskId: 'AB-12',
  initiative: 'demo',
  spawnedAt: AT.toISOString(),
  phase: 'implementing',
  phaseAt: AT.toISOString(),
  seat: SEAT,
  namePrefix: 'sx',
  agentId: 'id-1',
  notified: ['dispatched'],
  ...over,
})

const ledger = (...claims: Claim[]): Ledger => ({ ...EMPTY_LEDGER, claims })

const sender = (ok: boolean): SeatSender => ({
  send: async () => ({ ok }),
  notify: async () => ({ ok: true }),
  close: () => undefined,
})

const deliver = (before: Ledger, after: Ledger, ok = true) =>
  deliverSeatEvents(
    { seats: [SEAT], before, after, spawns: [] },
    { open: async () => sender(ok), log: () => {}, now: AT, journal: journalOver(root) },
  )

beforeEach(() => {
  logged = []
  root = autonomyRoot()
  const home = tmp('journal-home-')
  process.env.AGENT_CHAT_HOME = home
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
})

afterEach(() => {
  stopAutoAttach()
  sup?.close()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('a seat agent’s lifecycle', () => {
  it('writes one spawn line when the agent is spawned', async () => {
    const spawned = await supervisorWith(journalOver(root)).spawn(spawnReq(AGENT))

    expect(spawned.reason).toBeUndefined()
    expect(journalText()).toBe(`04:05 spawn AB-12 ${AGENT} -\n`)
  })

  it('writes one retire line when the agent is retired', async () => {
    core.append({ kind: 'agent_spawned', actor: 'human', target: AGENT, msgId: 'a1', body: 'work' })

    const retired = await supervisorWith(journalOver(root)).retire(AGENT)

    expect(retired.ok).toBe(true)
    expect(journalText()).toBe(`04:05 retire AB-12 ${AGENT} -\n`)
  })

  it('writes a dash for the task when the agent name carries none', async () => {
    await supervisorWith(journalOver(root)).spawn(spawnReq('sx-reviewer'))

    expect(journalText()).toBe('04:05 spawn - sx-reviewer -\n')
  })

  it('writes nothing for a spawn that fails', async () => {
    const spawned = await supervisorWith(journalOver(root)).spawn({
      ...spawnReq(AGENT),
      surface: 'iterm-pane' as const,
    })

    expect(spawned.ok).toBe(false)
    expect(journalText()).toBeUndefined()
  })

  it('writes nothing for a spawn whose agent never attaches', async () => {
    vi.useFakeTimers()
    stopAutoAttach()

    const spawning = supervisorWith(journalOver(root), 1000).spawn(spawnReq(AGENT))
    await vi.advanceTimersByTimeAsync(1000)
    const spawned = await spawning

    expect(spawned.reason).toMatch(/never registered/)
    expect(journalText()).toBeUndefined()
  })

  it('names the day file and the clock in local time, not UTC', () => {
    const zone = process.env.TZ
    process.env.TZ = 'Pacific/Kiritimati'
    try {
      const at = new Date(2026, 1, 3, 4, 5)
      expect(at.toISOString()).toBe('2026-02-02T14:05:00.000Z')

      seatJournal(root, { now: () => at })({ event: 'spawn', agent: AGENT })

      const file = path.join(root, 'logs', SEAT, '2026-02-03.md')
      expect(fs.readFileSync(file, 'utf8')).toBe(`04:05 spawn AB-12 ${AGENT} -\n`)
    } finally {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    }
  })
})

describe('a seat claim’s events from the tick', () => {
  it('writes one merged line with the PR and its head once the seat is told', async () => {
    const before = ledger(
      claim({ phase: 'awaiting-merge', pr: PR, notified: ['dispatched', 'ready-to-merge'] }),
    )
    const after = ledger({ ...before.claims[0]!, phase: 'done', prHead: HEAD })

    await deliver(before, after)

    expect(journalText()).toBe('04:05 merged AB-12 sx-ab-12 example-org/widget#7@abcdef1\n')
  })

  it('writes one stalled line once the seat is told', async () => {
    const before = ledger(claim())
    const after = ledger(claim({ stalledReason: 'implementing past its timeout' }))

    await deliver(before, after)

    expect(journalText()).toBe('04:05 stalled AB-12 sx-ab-12 -\n')
  })

  it('writes the PR and its head on a stalled line when the claim holds both', async () => {
    const stalled = claim({ stalledReason: 'PR closed without merging', pr: PR, prHead: HEAD })

    await deliver(ledger(claim({ pr: PR })), ledger(stalled))

    expect(journalText()).toBe('04:05 stalled AB-12 sx-ab-12 example-org/widget#7@abcdef1\n')
  })

  it('writes nothing for an event the seat was not told, which the next tick sends again', async () => {
    const after = ledger(claim({ stalledReason: 'implementing past its timeout' }))

    await deliver(ledger(claim()), after, false)

    expect(journalText()).toBeUndefined()
  })

  it('writes no line for the other event kinds', async () => {
    const after = ledger(claim({ phase: 'parked' }))

    await deliver(ledger(claim()), after)

    expect(journalText()).toBeUndefined()
  })
})

describe('the PR head a merged line carries', () => {
  const row = (phase: 'done' | 'cancelled') =>
    ({ repo: 'example-org/widget', pr: 7, runId: 'run-7', phase, headSha: HEAD, stalled: null }) as const

  it('is recorded on the claim when Shepherd has landed the PR', () => {
    const waiting = claim({ phase: 'shepherding', pr: PR })
    const seen = new Map([[claimKey(waiting), { shepherd: { row: row('done'), landed: true } }]])

    const actions = advance([waiting], seen, AT)

    expect(actions[0]).toMatchObject({ kind: 'update', patch: { phase: 'done', prHead: HEAD } })
  })

  it('is recorded on the claim when Shepherd ends the run without merging', () => {
    const waiting = claim({ phase: 'shepherding', pr: PR })
    const seen = new Map([[claimKey(waiting), { shepherd: { row: row('cancelled') } }]])

    const actions = advance([waiting], seen, AT)

    expect(actions).toEqual([
      {
        kind: 'update',
        key: { taskId: 'AB-12', slice: undefined },
        patch: {
          stalledClass: 'failed',
          stallCode: 'shepherd-ended',
          stalledReason: 'Shepherd run run-7 ended cancelled without merging',
          prHead: HEAD,
        },
      },
    ])
  })
})

describe('a line that is already there', () => {
  it('is not written again when the seat wrote the same line by hand in the same minute', () => {
    const byHand = seatWrote(`04:05 spawn AB-12 ${AGENT} -\n`)

    journalOver(root)({ event: 'spawn', agent: AGENT })

    expect(journalText()).toBe(byHand)
  })

  it('is written when the line by hand is another minute, event or agent, or only mentions the agent', () => {
    const byHand = seatWrote(
      [
        `04:04 park AB-12 ${AGENT} -`,
        `04:05 retire AB-12 ${AGENT} -`,
        `04:05 park AB-12 ${AGENT}-r0 -`,
        `04:05 PARKED until ${AGENT} reports`,
        `04:05 parked ${AGENT} for the night`,
        '',
      ].join('\n'),
    )

    journalOver(root)({ event: 'park', agent: AGENT })

    expect(journalText()).toBe(`${byHand}04:05 park AB-12 ${AGENT} -\n`)
  })

  it('writes the second spawn of a name retired and spawned again within one minute', async () => {
    const supervisor = supervisorWith(journalOver(root))

    await supervisor.spawn(spawnReq(AGENT))
    await supervisor.retire(AGENT, true)
    const again = await supervisor.spawn(spawnReq(AGENT))

    expect(again.reason).toBeUndefined()
    expect(journalText()).toBe(
      `04:05 spawn AB-12 ${AGENT} -\n04:05 retire AB-12 ${AGENT} -\n04:05 spawn AB-12 ${AGENT} -\n`,
    )
  })
})

const PAUSE = '03:10 PARKED until the owner answers\n'

describe('a field that is not one plain token', () => {
  const names = {
    spaces: 'sx-cc-2 with spaces',
    'a newline, a heading and a forged line': 'sx-cc-2\n## Handoff\n04:06 x',
    'a tab': 'sx-cc-2\tfix',
    'a heading on the same line': 'sx-cc-2 # Handoff',
    'a control character': 'sx-cc-2\u001b[2J',
    'a carriage return': 'sx-cc-2\r04:06 x',
  }

  it.each(Object.entries(names))(
    'writes no line for an agent name with %s, and the seat’s stop stands',
    async (_what, name) => {
      seatWrote(PAUSE)

      const spawned = await supervisorWith(journalOver(root)).spawn(spawnReq(name))

      expect(spawned.reason).toBeUndefined()
      expect(journalText()).toBe(PAUSE)
      expect(readSeatLog(journalText() ?? '', AT).stop).toMatch(/PARKED until the owner answers/)
      expect(logged).toEqual(['seat_journal_refused'])
    },
  )

  const fields = {
    'an empty task': { event: 'merged', agent: AGENT, task: '' },
    'a task of two words': { event: 'merged', agent: AGENT, task: 'AB-12 PARKED' },
    'an empty PR reference': { event: 'merged', agent: AGENT, pr: '' },
    'a PR reference with a newline': {
      event: 'merged',
      agent: AGENT,
      pr: 'example-org/widget#7@abcdef1\n04:06 x',
    },
    'a PR reference with a short head': { event: 'merged', agent: AGENT, pr: 'example-org/widget#7@abc' },
    'a PR reference on a spawn': { event: 'spawn', agent: AGENT, pr: 'example-org/widget#7@abcdef1' },
    'an agent name that is only the prefix': { event: 'spawn', agent: 'sx-' },
  } as const

  it.each(Object.entries(fields))('writes no line for %s, and the seat’s stop stands', (_what, entry) => {
    seatWrote(PAUSE)

    journalOver(root)(entry)

    expect(journalText()).toBe(PAUSE)
    expect(logged).toEqual(['seat_journal_refused'])
  })

  it('writes nothing and logs nothing for an empty agent name, which no seat owns', () => {
    journalOver(root)({ event: 'spawn', agent: '' })

    expect(journalText()).toBeUndefined()
    expect(logged).toEqual([])
  })

  it('logs a run of refusals once, and again after a line was written between them', () => {
    const journal = journalOver(root)

    journal({ event: 'spawn', agent: 'sx-cc-2 one' })
    journal({ event: 'spawn', agent: 'sx-cc-2 two' })
    journal({ event: 'spawn', agent: AGENT })
    journal({ event: 'spawn', agent: 'sx-cc-2 three' })

    expect(journalText()).toBe(`04:05 spawn AB-12 ${AGENT} -\n`)
    expect(logged).toEqual(['seat_journal_refused', 'seat_journal_refused'])
  })
})

describe('an agent no seat owns', () => {
  it('writes nothing when its name has no seat prefix', async () => {
    const spawned = await supervisorWith(journalOver(root)).spawn(spawnReq('scout'))

    expect(spawned.reason).toBeUndefined()
    expect(fs.existsSync(path.join(root, 'logs'))).toBe(false)
    expect(logged).toEqual([])
  })

  it('writes nothing when no seat file declares its prefix', async () => {
    const spawned = await supervisorWith(journalOver(root)).spawn(spawnReq('zz-ab-12-fix'))

    expect(spawned.reason).toBeUndefined()
    expect(fs.existsSync(path.join(root, 'logs'))).toBe(false)
    expect(logged).toEqual([])
  })

  it('writes nothing when its name only starts with a seat’s prefix, without the dash', () => {
    journalOver(root)({ event: 'spawn', agent: 'sxy-ab-12-fix' })
    journalOver(root)({ event: 'spawn', agent: 'sx' })

    expect(fs.existsSync(path.join(root, 'logs'))).toBe(false)
    expect(logged).toEqual([])
  })
})

describe('two seats that declare one prefix', () => {
  it('writes to neither and logs once, then writes again once one seat is left', () => {
    seatFile(root, 'seat-a', 'sx')
    const journal = journalOver(root)

    journal({ event: 'spawn', agent: AGENT })
    journal({ event: 'retire', agent: AGENT })

    expect(fs.existsSync(path.join(root, 'logs'))).toBe(false)
    expect(logged).toEqual(['seat_journal_ambiguous'])

    fs.rmSync(path.join(root, 'seats', 'seat-a.md'))
    journal({ event: 'spawn', agent: AGENT })
    seatFile(root, 'seat-a', 'sx')
    journal({ event: 'retire', agent: AGENT })

    expect(journalText()).toBe(`04:05 spawn AB-12 ${AGENT} -\n`)
    expect(fs.existsSync(path.join(root, 'logs', 'seat-a'))).toBe(false)
    expect(logged).toEqual(['seat_journal_ambiguous', 'seat_journal_ambiguous'])
  })
})

describe('an autonomy root the broker cannot use', () => {
  it('writes nothing for a missing root, logs once, and the spawn and retire still succeed', async () => {
    const missing = path.join(tmp('journal-none-'), 'absent')
    const supervisor = supervisorWith(journalOver(missing))

    const spawned = await supervisor.spawn(spawnReq(AGENT))
    const retired = await supervisor.retire(AGENT, true)

    expect(spawned.reason).toBeUndefined()
    expect(retired.ok).toBe(true)
    expect(fs.existsSync(missing)).toBe(false)
    expect(logged).toEqual(['seat_journal_unavailable'])
  })

  it('writes nothing for an unreadable root, logs once, and the spawn and retire still succeed', async () => {
    const unreadable = tmp('journal-bad-')
    fs.writeFileSync(path.join(unreadable, 'seats'), 'not a directory\n')
    const supervisor = supervisorWith(journalOver(unreadable))

    const spawned = await supervisor.spawn(spawnReq(AGENT))
    const retired = await supervisor.retire(AGENT, true)

    expect(spawned.reason).toBeUndefined()
    expect(retired.ok).toBe(true)
    expect(fs.existsSync(path.join(unreadable, 'logs'))).toBe(false)
    expect(logged).toEqual(['seat_journal_unavailable'])
  })

  it('logs again when the root is lost a second time, after a line was written in between', () => {
    const journal = journalOver(root)
    const seats = path.join(root, 'seats')
    const away = path.join(root, 'seats-away')

    fs.renameSync(seats, away)
    journal({ event: 'spawn', agent: AGENT })
    journal({ event: 'retire', agent: AGENT })
    fs.renameSync(away, seats)
    journal({ event: 'spawn', agent: AGENT })
    fs.renameSync(seats, away)
    journal({ event: 'retire', agent: AGENT })

    expect(journalText()).toBe(`04:05 spawn AB-12 ${AGENT} -\n`)
    expect(logged).toEqual(['seat_journal_unavailable', 'seat_journal_unavailable'])
  })
})

describe('a teleport whose successor did not start (CC-402)', () => {
  it('writes a teleport-failed line to the seat’s own log for the seat itself, which is no stop and no activity', () => {
    journalOver(root)({ event: 'teleport-failed', agent: SEAT })

    expect(journalText()).toBe(`04:05 teleport-failed - ${SEAT} -\n`)
    expect(readSeatLog(journalText() ?? '', AT)).toEqual({})
  })

  it('writes a teleport-failed line with the task for one of the seat’s agents', () => {
    journalOver(root)({ event: 'teleport-failed', agent: AGENT })

    expect(journalText()).toBe(`04:05 teleport-failed AB-12 ${AGENT} -\n`)
  })

  it('writes the line for a seat whose name has no dash', () => {
    seatFile(root, 'coord', 'co')

    journalOver(root)({ event: 'teleport-failed', agent: 'coord' })

    const file = seatLogPath(root, 'coord', AT)
    expect(fs.readFileSync(file, 'utf8')).toBe('04:05 teleport-failed - coord -\n')
    expect(readSeatLog(fs.readFileSync(file, 'utf8'), AT)).toEqual({})
  })

  it('still writes no other event under the seat’s own name', () => {
    journalOver(root)({ event: 'spawn', agent: SEAT })

    expect(journalText()).toBeUndefined()
  })
})

describe('the watchdog reading a journal the broker also writes', () => {
  const at = AT.getTime()
  const brokerLines = [
    `spawn AB-12 ${AGENT} -`,
    `retire - sx-reviewer -`,
    `park AB-12 ${AGENT} -`,
    'merged AB-12 sx-ab-12 example-org/widget#7@abcdef1',
    'stalled AB-12 sx-ab-12 -',
    `teleport-failed - ${SEAT} -`,
    'teleport-failed - coord -',
  ]

  it.each(brokerLines)('keeps the seat’s pause under the broker line "%s", which is no activity', line => {
    const verdict = readSeatLog(`${PAUSE}04:05 ${line}\n`, AT)

    expect(verdict.stop).toMatch(/PARKED until the owner answers/)
    expect(verdict.activityAt).toBe(new Date(2026, 1, 3, 3, 10).getTime())
  })

  const prose = [
    'spawn the next reviewer',
    'spawn - reviewers -',
    'retire the old reviewer',
    'retire AB-12 tomorrow -',
    'park it for now',
    'park AB-12 sx-ab-12-fix after review',
    'merged the fix today',
    'merged AB-12 sx-ab-12 widget#7',
    'stalled on the owner',
    'stalled AB-12 needs owner',
    `spawn AB-12 ${AGENT} example-org/widget#7@abcdef1`,
    `spawn AB-12 ${AGENT} - and told the owner`,
    `RETIRE AB-12 ${AGENT} -`,
  ]

  it.each(prose)('reads the seat’s own line "%s" as its activity, which lifts an earlier pause', line => {
    const verdict = readSeatLog(`${PAUSE}04:05 ${line}\n`, AT)

    expect(verdict).toEqual({ activityAt: at })
  })
})
