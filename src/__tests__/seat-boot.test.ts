import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOG_CAP, latestTeleportState } from '../agents/seats/boot-read.js'
import { BOOT_CAP, renderBoot, seatBoot, type BootDeps } from '../agents/seats/boot.js'
import type { SeatStatus } from '../agents/seats/status.js'
import { EventLog } from '../broker/event-log.js'
import { bootReport } from '../cli/verbs/seats.js'

/**
 * CC-318: `seats boot` prints one capped digest for a coordinator seat.
 * The autonomy root, events.db, the seat status and every name are synthetic.
 */

const SEAT = 'sample-coord'
const NOW = new Date(2026, 8, 30, 12, 0)

const SEAT_FILE = `---
name: ${SEAT}
prefix: sc
pool: pool-a
config_dir: /tmp/pool-a
spend:
  per_run_points: 30
  per_day_points: 20
concurrency:
  implementers: 5
  reviewers: 2
  planners: 1
scope_tags: [alpha, beta]
excluded_tags: [human-only]
grants_extra:
  - merge-authority   # a comment the digest drops
  - restart-window
---
# ${SEAT}

SEAT PROSE THAT THE BOOT MUST NOT PRINT.
`

const IN_FLIGHT = '## In flight\n\n- sc-one: task A, PR open\n\n### Waiting\n\n- sc-two: review'
const NEXT = '## Next (before the scorer)\n\n1. task B\n2. task C'
const QUEUE = `# Queue: ${SEAT}\n\n${IN_FLIGHT}\n\n${NEXT}\n\n## Morning queue (owner only)\n\nOWNER ONLY LINE\n`

const STATUS: SeatStatus = {
  seat: SEAT,
  at: NOW.toISOString(),
  implementers: { active: 2, cap: 5, atCap: false, names: ['sc-a', 'sc-b'], detached: [], waitingOwner: [] },
  reviewers: { active: 1, cap: 2, atCap: false, names: ['sc-r'], detached: [], waitingOwner: [] },
  planners: { active: 0, cap: 1, atCap: false, names: [], detached: [], waitingOwner: [] },
  other: { active: 0, names: [], detached: [] },
  parked: { count: 3, names: ['sc-p1', 'sc-p2', 'sc-p3'], treeOnDisk: [] },
  budget: {
    pool: 'pool-a',
    sevenDay: 41,
    fiveHour: 12,
    ageSeconds: 30,
    stale: false,
    staleOk: false,
    stop: null,
    margin: 'seven_day 41 < 65',
    sonnetOnly: false,
    spendSince: null,
    note: null,
    allowance: {
      source: 'per_day_points',
      points: null,
      stopLine: 65,
      sevenDay: 41,
      dayStartSevenDay: 41,
      basis: 'current',
      daysToReset: null,
      resetsAt: null,
    },
  },
  inbox: { unread: 4, sinceLastSend: '2026-09-30T09:00:00.000Z' },
  eligible: { top: [], skipped: 0, today: '2026-09-30' },
  machine: {
    headlessAgents: { live: 3, limit: 10 },
    memoryFree: { percent: 35, limit: 15 },
    swap: { usedPercent: 40 },
    fullSuiteSlots: { inUse: 0, total: 4 },
  },
  stop: null,
  machineStop: null,
}

let tmp: string
let root: string
let events: EventLog

const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

const writeLog = (text: string): void => write(`logs/${SEAT}/2026-09-30.md`, text)

/** Messages to the seat with ids m1..mN after the seat's own send m0, each body `bodyChars` long. */
function sendMessages(count: number, bodyChars = 20): void {
  events.append({ kind: 'message', actor: SEAT, target: 'peer', msgId: 'm0', body: 'handoff' })
  for (let i = 1; i <= count; i++)
    events.append({
      kind: 'message',
      actor: 'peer',
      target: SEAT,
      msgId: `m${i}`,
      body: `msg ${i}\nline two `.padEnd(bodyChars, 'x'),
    })
}

const deps = (over: Partial<BootDeps> = {}): BootDeps => ({
  now: () => NOW,
  autonomyRoot: root,
  homeDir: tmp,
  eventsDb: path.join(tmp, 'events.db'),
  status: async () => STATUS,
  ...over,
})

async function boot(after?: string, over: Partial<BootDeps> = {}): Promise<string[]> {
  const report = await bootReport(deps(over), SEAT, after, false)
  expect(report.ok).toBe(true)
  return report.lines
}

const inboxLines = (lines: string[]): string[] => {
  const start = lines.findIndex(line => line.startsWith('== inbox'))
  const end = lines.findIndex(line => line === '== status')
  return lines.slice(start + 1, end)
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-boot-')))
  root = path.join(tmp, 'autonomy')
  events = new EventLog(path.join(tmp, 'events.db'))
  write(`seats/${SEAT}.md`, SEAT_FILE)
  write(`queues/${SEAT}.md`, QUEUE)
  writeLog('09:00 started\n## State at teleport 1\n- sc-one: task A\n')
})

afterEach(() => {
  events.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the seat section', () => {
  it('digests the frontmatter with the path and mtime and leaves the prose out', async () => {
    const lines = await boot()

    const text = lines.join('\n')
    expect(lines[0]).toBe(`== seat ${SEAT}`)
    expect(lines[1]).toContain(path.join(root, 'seats', `${SEAT}.md`))
    expect(lines[1]).toMatch(/modified \d{4}-\d\d-\d\dT/)
    expect(lines).toContain('concurrency: implementers 5, reviewers 2, planners 1')
    expect(lines).toContain('spend: per_run_points 30, per_day_points 20')
    expect(lines).toContain('scope_tags: alpha, beta')
    expect(lines).toContain('grants_extra: merge-authority, restart-window')
    expect(text).not.toContain('SEAT PROSE')
    expect(text).not.toContain('a comment the digest drops')
  })
})

describe('the queue section', () => {
  it('prints In flight and Next verbatim and nothing else from the queue', async () => {
    const text = (await boot()).join('\n')

    expect(text).toContain(IN_FLIGHT)
    expect(text).toContain(NEXT)
    expect(text).not.toContain('OWNER ONLY LINE')
  })

  it('prints one line for a missing queue file and still succeeds', async () => {
    fs.rmSync(path.join(root, 'queues'), { recursive: true })

    const lines = await boot()

    expect(lines.filter(line => line.includes('queue'))).toEqual([
      `== queue: no queue file at ${path.join(root, 'queues', `${SEAT}.md`)}`,
    ])
  })
})

describe('the State-at-teleport picker', () => {
  it('takes the newest section and stops at the next heading', () => {
    const log = [
      '## State at teleport 1',
      'old state',
      '## State at teleport 3',
      'newest state',
      '- item',
      '',
      '## Afterwards',
      'not state',
      '## State at teleport 2',
      'middle state',
    ].join('\n')

    expect(latestTeleportState(log)).toBe('## State at teleport 3\nnewest state\n- item')
  })

  it('keeps a ### subsection and stops only at a heading of level 2 or higher', () => {
    const log = '## State at teleport 1\nfirst\n### Waiting\n- sc-two\n## Afterwards\nnot state'

    expect(latestTeleportState(log)).toBe('## State at teleport 1\nfirst\n### Waiting\n- sc-two')
  })

  it('runs to the end of the file when no heading follows', () => {
    expect(latestTeleportState('## State at teleport 1\na\n10:00 line\n')).toBe(
      '## State at teleport 1\na\n10:00 line',
    )
  })

  it(`cuts a long section to ${LOG_CAP} characters`, async () => {
    writeLog(`## State at teleport 1\n${'state line\n'.repeat(400)}`)

    const lines = await boot()

    const start = lines.findIndex(line => line.startsWith('== log'))
    const section = lines
      .slice(
        start + 1,
        lines.findIndex(line => line.startsWith('== inbox')),
      )
      .join('\n')
    expect(section.length).toBeLessThanOrEqual(LOG_CAP)
    expect(section).toMatch(/^## State at teleport 1\n/)
    expect(section).toMatch(/\[cut at \d+ of \d+ chars\]$/)
  })
})

describe('the inbox section', () => {
  it('lists the messages after the cutoff, oldest first, excluding the cutoff itself', async () => {
    sendMessages(4)

    const lines = inboxLines(await boot('m2'))

    expect(lines).toEqual(['[m3] from peer: msg 3 line two xxxxx', '[m4] from peer: msg 4 line two xxxxx'])
  })

  it('says so when the cutoff leaves no messages', async () => {
    sendMessages(2)

    expect(inboxLines(await boot('m2'))).toEqual(['inbox: none after m2'])
  })

  it('warns on an unknown msg_id and falls back to the last five', async () => {
    sendMessages(7)

    const lines = inboxLines(await boot('nope'))

    expect(lines[0]).toBe('warning: unknown msg_id nope; showing the last 5')
    expect(lines.slice(1).map(line => line.slice(0, 4))).toEqual(['[m3]', '[m4]', '[m5]', '[m6]', '[m7]'])
  })

  it('cuts each message to 240 characters with newlines collapsed', async () => {
    sendMessages(1, 500)

    const [line] = inboxLines(await boot())

    expect(line).toBe(`[m1] from peer: ${'msg 1 line two '.padEnd(240, 'x')}`)
  })
})

describe('the status section', () => {
  it('renders caps, parked, pool, stop and unread', async () => {
    const lines = await boot()

    expect(lines.slice(lines.indexOf('== status'))).toEqual([
      '== status',
      'caps implementers 2/5, reviewers 1/2, planners 0/1; other 0; parked 3',
      'pool pool-a: seven_day 41%, five_hour 12% (reading 30s old)',
      'stop none; seven_day 41 < 65',
      'inbox 4 unread since 2026-09-30T09:00:00.000Z',
    ])
  })

  it('keeps every other section when the status cannot be read', async () => {
    const status = () => Promise.reject(new Error(`broker down at ${tmp}/sock`))

    const lines = await boot(undefined, { status })

    expect(lines.slice(-2)).toEqual(['== status', 'unavailable: broker down at sock'])
    expect(lines.join('\n')).toContain(IN_FLIGHT)
  })
})

describe('the 6,000-character cap', () => {
  it('drops the oldest inbox lines first and keeps the queue, log and status whole', async () => {
    sendMessages(40, 240)

    const lines = await boot('m0')

    const text = lines.join('\n')
    expect(text.length).toBeLessThanOrEqual(BOOT_CAP)
    expect(text).toContain(IN_FLIGHT)
    expect(text).toContain(NEXT)
    expect(text).toContain('## State at teleport 1\n- sc-one: task A')
    expect(lines).toContain('inbox 4 unread since 2026-09-30T09:00:00.000Z')
    const inbox = inboxLines(lines)
    expect(inbox[0]).toMatch(/^\d+ earlier messages omitted$/)
    expect(inbox.at(-1)).toMatch(/^\[m40\]/)
  })

  it('cuts the log section after the inbox is gone, never the queue', async () => {
    const bigQueue = `${IN_FLIGHT}\n${'- in flight row\n'.repeat(230)}`
    write(`queues/${SEAT}.md`, `${bigQueue}\n${NEXT}\n`)
    writeLog(`## State at teleport 1\n${'state line\n'.repeat(140)}`)
    sendMessages(10, 240)

    const lines = await boot('m0')

    const text = lines.join('\n')
    expect(text.length).toBeLessThanOrEqual(BOOT_CAP)
    expect(text).toContain(bigQueue.trimEnd())
    expect(text).toContain(NEXT)
    expect(inboxLines(lines)[0]).toBe('10 earlier messages omitted')
    expect(text).toMatch(/\[cut at \d+ of \d+ chars\]/)
    expect(lines.at(-1)).toBe('inbox 4 unread since 2026-09-30T09:00:00.000Z')
  })
})

describe('the inbox omission note', () => {
  it('uses the singular for exactly one omitted message', async () => {
    sendMessages(3, 240)
    const boot = await seatBoot(deps(), SEAT, 'm0')
    const full = renderBoot(boot, 100_000)
    const one = renderBoot(boot, full.join('\n').length - 1)

    expect(one).toContain('1 earlier message omitted')
  })
})

describe('an oversized field in text mode', () => {
  it('cuts an oversized queue under the cap and says how much was cut', async () => {
    write(`queues/${SEAT}.md`, `${IN_FLIGHT}\n${'- in flight row\n'.repeat(1_000)}\n${NEXT}\n`)

    const lines = await boot()

    const text = lines.join('\n')
    expect(text.length).toBeLessThanOrEqual(BOOT_CAP)
    expect(text).toMatch(/\[cut at \d+ of \d+ chars\]/)
  })

  it('leaves --json uncapped', async () => {
    write(`queues/${SEAT}.md`, `${IN_FLIGHT}\n${'- in flight row\n'.repeat(1_000)}\n${NEXT}\n`)

    const report = await bootReport(deps(), SEAT, undefined, true)

    expect(report.lines.join('\n').length).toBeGreaterThan(BOOT_CAP)
  })
})

describe('--json', () => {
  it('returns the sections as one object', async () => {
    sendMessages(1)

    const report = await bootReport(deps(), SEAT, undefined, true)

    const doc = JSON.parse(report.lines[0] ?? '') as Record<string, { [k: string]: unknown }>
    expect(doc.queue).toMatchObject({ found: true, inFlight: IN_FLIGHT, next: NEXT })
    expect(doc.inbox).toMatchObject({ after: null, messages: [{ msgId: 'm1', from: 'peer' }] })
    expect(doc.status).toMatchObject({ seat: SEAT })
  })

  it('reports a seat with no seat file as an error', async () => {
    const report = await bootReport(deps(), 'no-such-seat', undefined, true)

    expect(report.ok).toBe(false)
    expect(JSON.parse(report.lines[0] ?? '')).toMatchObject({ seat: 'no-such-seat' })
  })
})
