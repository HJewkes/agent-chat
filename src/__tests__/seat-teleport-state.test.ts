import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { readBootInbox, readLogSection } from '../agents/seats/boot-read.js'
import type { ShepherdRow } from '../agents/burndown/shepherd.js'
import {
  nextTeleportNumber,
  renderTeleportState,
  seatShepherdRows,
  writeTeleportState,
  type SeatTeleportDeps,
} from '../agents/seats/teleport-state.js'

/** CC-863: the 'State at teleport N' block agent-chat writes for a seat. Every name and path is synthetic. */

const NOW = new Date(2026, 9, 2, 9, 30)
/** The teleporting session began at 08:30 local. */
const SESSION_START = new Date(2026, 9, 2, 8, 30).getTime()
const TODAY = '2026-10-02'

let dir: string
let root: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-tstate-'))
  root = path.join(dir, 'autonomy')
  fs.mkdirSync(path.join(root, 'seats'), { recursive: true })
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const seatFile = (seat: string, extra = ''): void =>
  fs.writeFileSync(
    path.join(root, 'seats', `${seat}.md`),
    `---\nname: ${seat}\nprefix: al\npool: p1\n${extra}---\n\nprose\n`,
  )

const writeLog = (seat: string, text: string): void => {
  fs.mkdirSync(path.join(root, 'logs', seat), { recursive: true })
  fs.writeFileSync(path.join(root, 'logs', seat, `${TODAY}.md`), text)
}

const readLog = (seat: string): string =>
  fs.readFileSync(path.join(root, 'logs', seat, `${TODAY}.md`), 'utf8')

const row = (over: Partial<ShepherdRow>): ShepherdRow => ({
  repo: 'example/widgets',
  pr: 7,
  runId: 'run-1',
  phase: 'review',
  headSha: 'abcdef0123456789',
  stalled: null,
  branch: 'agent-chat/al-fix-7',
  task: 'demo/D-7',
  held: null,
  ...over,
})

const deps = (shepherd: () => Promise<ShepherdRow[] | undefined>): SeatTeleportDeps => ({
  autonomyRoot: root,
  now: () => NOW,
  shepherd,
})

const running = [
  { name: 'al-fix-7', profile: 'implementer', state: 'live' as const },
  { name: 'al-plan-2', profile: 'planner', state: 'detached' as const },
]

describe('nextTeleportNumber', () => {
  it('is 1 for a day with no log or no block', () => {
    expect(nextTeleportNumber(undefined)).toBe(1)
    expect(nextTeleportNumber('09:00 heartbeat\n')).toBe(1)
  })

  it('is one past the highest block in the log', () => {
    expect(nextTeleportNumber('## State at teleport 4\nx\n## State at teleport 5\ny\n')).toBe(6)
  })
})

describe('seatShepherdRows', () => {
  it('keeps the seat’s unfinished runs and drops other prefixes and finished runs', () => {
    const rows = [
      row({ runId: 'mine' }),
      row({ runId: 'other-seat', branch: 'agent-chat/zz-fix-1' }),
      row({ runId: 'merged', phase: 'done' }),
      row({ runId: 'cancelled', phase: 'cancelled' }),
      row({ runId: 'no-branch', branch: null }),
      row({ runId: 'prefix-only', branch: 'agent-chat/alfix' }),
    ]
    expect(seatShepherdRows(rows, 'al').map(r => r.runId)).toEqual(['mine'])
  })
})

describe('renderTeleportState', () => {
  it('lists the roster, then the Shepherd rows, then the inbox cursor', () => {
    const text = renderTeleportState({
      n: 3,
      running,
      shepherd: [row({ held: { reason: 'g10-review:\nopus' } })],
      inboxThrough: '0000aa42',
    })
    expect(text).toBe(
      [
        '## State at teleport 3 (agent-chat)',
        '- al-fix-7 (profile implementer, live)',
        '- al-plan-2 (profile planner, detached)',
        '- Shepherd example/widgets#7 demo/D-7 review, held g10-review: opus, at abcdef01 (al-fix-7)',
        'Inbox handled through 0000aa42.',
      ].join('\n'),
    )
  })

  it('quotes the seat file’s grant on the first State line', () => {
    const text = renderTeleportState({
      n: 1,
      grant: 'merge on green, owner 2026-01-01',
      running: [],
      shepherd: [],
      inboxThrough: undefined,
    })
    expect(text.split('\n')).toEqual([
      '## State at teleport 1 (agent-chat)',
      'GRANT: merge on green, owner 2026-01-01',
      '- No agent in flight.',
      'Inbox: no message had arrived, so boot without --after.',
    ])
  })

  it('says Shepherd could not be read, and still lists the roster', () => {
    const text = renderTeleportState({ n: 2, running, shepherd: undefined, inboxThrough: '0000aa01' })
    expect(text).toContain('- al-fix-7 (profile implementer, live)')
    expect(text).toContain('- Shepherd unreachable at teleport; its runs are not listed.')
    expect(text.endsWith('Inbox handled through 0000aa01.')).toBe(true)
  })
})

describe('writeTeleportState', () => {
  it('writes nothing for a name with no seat file', async () => {
    const written = await writeTeleportState(
      deps(async () => []),
      {
        seat: 'scout',
        running,
        inboxThrough: '0000aa01',
        sessionStart: SESSION_START,
      },
    )
    expect(written).toBeUndefined()
    expect(fs.existsSync(path.join(root, 'logs', 'scout'))).toBe(false)
  })

  it('appends block N+1 after a seat block from an earlier session, carrying the grant line', async () => {
    seatFile('alpha', 'grant: merge on green\n')
    writeLog('alpha', '07:00 boot\n## State at teleport 4\nold\n09:00 heartbeat')

    const written = await writeTeleportState(
      deps(async () => [row({})]),
      {
        seat: 'alpha',
        running,
        inboxThrough: '0000aa09',
        sessionStart: SESSION_START,
      },
    )

    expect(written).toMatchObject({ n: 5, written: true, after: '0000aa09', cursorMissing: false })
    const log = readLog('alpha')
    expect(
      log.startsWith(
        '07:00 boot\n## State at teleport 4\nold\n09:00 heartbeat\n\n## State at teleport 5 (agent-chat)\n',
      ),
    ).toBe(true)
    expect(log).toContain('\nGRANT: merge on green\n- al-fix-7')
  })

  it('still writes the block when Shepherd is down', async () => {
    seatFile('alpha')
    const written = await writeTeleportState(
      deps(async () => {
        throw new Error('spawn titan-factory ENOENT')
      }),
      { seat: 'alpha', running, inboxThrough: '0000aa09', sessionStart: SESSION_START },
    )
    expect(written?.n).toBe(1)
    const log = readLog('alpha')
    expect(log).toContain('- al-plan-2 (profile planner, detached)')
    expect(log).toContain('Shepherd unreachable at teleport')
    expect(log).toContain('Inbox handled through 0000aa09.')
  })

  it('keeps the block the seat wrote this session, and boots after its own cursor', async () => {
    seatFile('alpha')
    const seatBlock =
      '09:10 writing state\n## State at teleport 7\n- al-fix-7 mid-review\nInbox handled through 0000aa05.\n'
    writeLog('alpha', seatBlock)

    const written = await writeTeleportState(
      deps(async () => [row({})]),
      { seat: 'alpha', running, inboxThrough: '0000aa09', sessionStart: SESSION_START },
    )

    expect(written).toEqual({
      file: expect.any(String),
      n: 7,
      written: false,
      after: '0000aa05',
      cursorMissing: false,
    })
    expect(readLog('alpha')).toBe(seatBlock)
    expect(readLogSection(root, 'alpha', NOW).section).toContain('- al-fix-7 mid-review')
  })

  it('reads the seat’s cursor when it writes it as a bullet', async () => {
    seatFile('alpha')
    writeLog(
      'alpha',
      '09:10 writing state\n## State at teleport 7\n- al-fix-7 mid-review\n- Inbox handled through 0000aa05.\n',
    )

    const written = await writeTeleportState(
      deps(async () => []),
      { seat: 'alpha', running, inboxThrough: '0000aa09', sessionStart: SESSION_START },
    )

    expect(written).toMatchObject({ written: false, after: '0000aa05', cursorMissing: false })
  })

  it('keeps a seat block with no readable cursor, and says the cursor is missing', async () => {
    seatFile('alpha')
    writeLog(
      'alpha',
      '09:10 writing state\n## State at teleport 7\n- al-fix-7 mid-review\nInbox: read up to the review.\n',
    )

    const written = await writeTeleportState(
      deps(async () => []),
      { seat: 'alpha', running, inboxThrough: '0000aa09', sessionStart: SESSION_START },
    )

    expect(written).toMatchObject({ written: false, after: undefined, cursorMissing: true })
  })

  it('keeps the block a seat wrote just before midnight in yesterday’s log', async () => {
    seatFile('alpha')
    const dir = path.join(root, 'logs', 'alpha')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, '2026-10-01.md'),
      '23:59 state\n## State at teleport 3\nInbox handled through 0000aa05.\n',
    )
    const lateStart = new Date(2026, 9, 1, 22, 0).getTime()

    const written = await writeTeleportState(
      deps(async () => []),
      { seat: 'alpha', running, inboxThrough: '0000aa09', sessionStart: lateStart },
    )

    expect(written).toMatchObject({ n: 3, written: false, after: '0000aa05' })
    expect(fs.existsSync(path.join(dir, `${TODAY}.md`))).toBe(false)
  })

  it('supersedes its own earlier block, whatever its time', async () => {
    seatFile('alpha')
    writeLog(
      'alpha',
      '09:10 x\n## State at teleport 2 (agent-chat)\n- old\nInbox handled through 0000aa01.\n',
    )

    const written = await writeTeleportState(
      deps(async () => []),
      { seat: 'alpha', running, inboxThrough: '0000aa09', sessionStart: SESSION_START },
    )

    expect(written).toMatchObject({ n: 3, written: true, after: '0000aa09' })
  })

  it('says why Shepherd runs are missing when the seat file has no prefix', async () => {
    fs.writeFileSync(path.join(root, 'seats', 'alpha.md'), '---\nname: alpha\npool: p1\n---\n')

    await writeTeleportState(
      deps(async () => [row({})]),
      { seat: 'alpha', running: [], inboxThrough: '0000aa09', sessionStart: SESSION_START },
    )

    const log = readLog('alpha')
    expect(log).toContain('- Shepherd runs not listed: the seat file has no prefix to match their branches.')
  })
})

describe('the block round-trips through the boot readers', () => {
  it('is what `seats boot` reads back, and its cursor leaves only later messages', async () => {
    seatFile('alpha')
    writeLog('alpha', '08:00 heartbeat\n')
    const dbPath = path.join(dir, 'events.db')
    const core = new BrokerCore(() => undefined, {
      events: new EventLog(dbPath),
      registry: new Registry<Conn>(),
    })
    core.append({ kind: 'message', actor: 'peer', target: 'alpha', body: 'handled before' })
    const cursor = core.events.inboxFor('alpha', 1)[0]?.msgId
    core.append({ kind: 'message', actor: 'peer', target: 'alpha', body: 'arrived after' })

    await writeTeleportState(
      deps(async () => [row({})]),
      { seat: 'alpha', running, inboxThrough: cursor, sessionStart: SESSION_START },
    )
    const section = readLogSection(root, 'alpha', NOW).section
    const expected = renderTeleportState({ n: 1, running, shepherd: [row({})], inboxThrough: cursor })
    const after = readLogSection(root, 'alpha', NOW).cursor ?? undefined
    const inbox = readBootInbox(dbPath, 'alpha', after)

    expect(section).toBe(expected)
    expect(after).toBe(cursor)
    expect(inbox.warning).toBeNull()
    expect(inbox.messages.map(m => m.text)).toEqual(['arrived after'])
  })
})
