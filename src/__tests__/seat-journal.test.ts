import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { advance, claimKey } from '../agents/burndown/advance.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { readRollup } from '../agents/burndown/observe.js'
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
  fs.writeFileSync(path.join(dir, 'seats', `${SEAT}.md`), '---\nprefix: sx\npool: pool-a\n---\n')
  return dir
}

const journalOver = (dir: string): SeatJournal =>
  seatJournal(dir, { now: () => AT, log: event => void logged.push(event) })

const journalText = (dir = root): string | undefined => {
  const file = seatLogPath(dir, SEAT, AT)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined
}

function supervisorWith(journal: SeatJournal): Supervisor {
  sup = new Supervisor(core, {
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
  it('is read from the PR the tick observes', () => {
    const json = JSON.stringify({ state: 'MERGED', statusCheckRollup: [], headRefOid: HEAD })

    expect(readRollup(json)).toEqual({ state: 'merged', checks: 'pending', head: HEAD })
  })

  it('is recorded on the claim when the merge is observed', () => {
    const waiting = claim({ phase: 'awaiting-merge', pr: PR })
    const seen = new Map([
      [claimKey(waiting), { pr: { state: 'merged', checks: 'pass', head: HEAD } } as const],
    ])

    const actions = advance([waiting], seen, AT)

    expect(actions[0]).toMatchObject({ kind: 'update', patch: { phase: 'done', prHead: HEAD } })
  })
})

describe('a line that is already there', () => {
  it('is not written again when the seat wrote the same event and agent by hand in the same minute', () => {
    const file = seatLogPath(root, SEAT, AT)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const byHand = `04:05 SPAWNED ${AGENT} for the fix (implementer)\n`
    fs.writeFileSync(file, byHand)

    journalOver(root)({ event: 'spawn', agent: AGENT })

    expect(journalText()).toBe(byHand)
  })

  it('is written when the line by hand is another event, agent or minute', () => {
    const file = seatLogPath(root, SEAT, AT)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const byHand = `04:05 retired ${AGENT}\n04:05 spawned ${AGENT}-r0\n04:04 spawned ${AGENT}\n`
    fs.writeFileSync(file, byHand)

    journalOver(root)({ event: 'spawn', agent: AGENT })

    expect(journalText()).toBe(`${byHand}04:05 spawn AB-12 ${AGENT} -\n`)
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
})

describe('the watchdog reading a journal the broker also writes', () => {
  it('still reads the seat’s own pause line as its latest, and not the broker’s line as activity', () => {
    const log = `03:10 PARKED until the owner answers\n04:05 retire AB-12 ${AGENT} -\n`

    const verdict = readSeatLog(log, AT)

    expect(verdict.stop).toMatch(/PARKED until the owner answers/)
    expect(verdict.activityAt).toBe(new Date(2026, 1, 3, 3, 10).getTime())
  })
})
