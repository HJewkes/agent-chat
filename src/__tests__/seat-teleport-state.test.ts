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

const readLog = (seat: string): string => fs.readFileSync(path.join(root, 'logs', seat, `${TODAY}.md`), 'utf8')

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
      inboxThrough: 'msg-42',
    })
    expect(text).toBe(
      [
        '## State at teleport 3',
        '- al-fix-7 (profile implementer, live)',
        '- al-plan-2 (profile planner, detached)',
        '- Shepherd example/widgets#7 demo/D-7 review, held g10-review: opus, at abcdef01 (al-fix-7)',
        'Inbox handled through msg-42.',
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
      '## State at teleport 1',
      'GRANT: merge on green, owner 2026-01-01',
      '- No agent in flight.',
      'Inbox handled through none.',
    ])
  })

  it('says Shepherd could not be read, and still lists the roster', () => {
    const text = renderTeleportState({ n: 2, running, shepherd: undefined, inboxThrough: 'msg-1' })
    expect(text).toContain('- al-fix-7 (profile implementer, live)')
    expect(text).toContain('- Shepherd unreachable at teleport; its runs are not listed.')
    expect(text.endsWith('Inbox handled through msg-1.')).toBe(true)
  })
})

describe('writeTeleportState', () => {
  it('writes nothing for a name with no seat file', async () => {
    const written = await writeTeleportState(deps(async () => []), {
      seat: 'scout',
      running,
      inboxThrough: 'msg-1',
    })
    expect(written).toBeUndefined()
    expect(fs.existsSync(path.join(root, 'logs', 'scout'))).toBe(false)
  })

  it('appends block N+1 after today’s last block, carrying the grant line', async () => {
    seatFile('alpha', 'grant: merge on green\n')
    writeLog('alpha', '## State at teleport 4\nold\n09:00 heartbeat')

    const written = await writeTeleportState(deps(async () => [row({})]), {
      seat: 'alpha',
      running,
      inboxThrough: 'msg-9',
    })

    expect(written?.n).toBe(5)
    const log = readLog('alpha')
    expect(log.startsWith('## State at teleport 4\nold\n09:00 heartbeat\n\n## State at teleport 5\n')).toBe(true)
    expect(log).toContain('\nGRANT: merge on green\n- al-fix-7')
  })

  it('still writes the block when Shepherd is down', async () => {
    seatFile('alpha')
    const written = await writeTeleportState(
      deps(async () => {
        throw new Error('spawn titan-factory ENOENT')
      }),
      { seat: 'alpha', running, inboxThrough: 'msg-9' },
    )
    expect(written?.n).toBe(1)
    const log = readLog('alpha')
    expect(log).toContain('- al-plan-2 (profile planner, detached)')
    expect(log).toContain('Shepherd unreachable at teleport')
    expect(log).toContain('Inbox handled through msg-9.')
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

    await writeTeleportState(deps(async () => [row({})]), { seat: 'alpha', running, inboxThrough: cursor })
    const section = readLogSection(root, 'alpha', NOW).section
    const expected = renderTeleportState({ n: 1, running, shepherd: [row({})], inboxThrough: cursor })
    const after = /^Inbox handled through (\S+)\.$/m.exec(section ?? '')?.[1]
    const inbox = readBootInbox(dbPath, 'alpha', after)

    expect(section).toBe(expected)
    expect(after).toBe(cursor)
    expect(inbox.warning).toBeNull()
    expect(inbox.messages.map(m => m.text)).toEqual(['arrived after'])
  })
})
