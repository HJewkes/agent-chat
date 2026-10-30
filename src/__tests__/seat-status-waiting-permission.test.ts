import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAccountBudget } from '../agents/budget.js'
import { renderBrief, renderStatus, seatStatus, type StatusDeps } from '../agents/seats/status.js'
import { readWaitingPermission, WAITING_PERMISSION_WINDOW_MS } from '../agents/seats/waiting-permission.js'
import { EventLog } from '../broker/event-log.js'
import type { AgentIdentity } from '../protocol.js'

/**
 * CC-610: `seats status` names the seat's agents parked on the permission hook.
 * The autonomy root, the events.db and every name are synthetic.
 */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'score-2026-09-29')
const SEAT = 'sample-seat'
const NOW = new Date(2026, 8, 29, 10, 0)

let tmp: string
let autonomy: string
let dbPath: string
let events: EventLog

function writeAutonomy(): void {
  const extra = 'prefix: ss\nconcurrency: {implementers: 2, reviewers: 1, planners: 3}'
  const withExtra = (file: string) =>
    fs.readFileSync(path.join(FIXTURE, file), 'utf8').replace(/\n---\n$/, `\n${extra}\n---\n`)
  fs.mkdirSync(path.join(autonomy, 'seats'), { recursive: true })
  fs.copyFileSync(path.join(FIXTURE, 'charter.md'), path.join(autonomy, 'charter.md'))
  fs.writeFileSync(path.join(autonomy, 'seats', `${SEAT}.md`), withExtra('seats/sample-seat.md'))
}

const agent = (name: string, spawnedBy: string): AgentIdentity =>
  ({ name, spawnedBy, profile: 'implementer', state: 'running', cwd: tmp }) as unknown as AgentIdentity

/** Files a hook prompt `minutesAgo` before NOW, as the broker's `handlePermissionHook` does. */
function fileHookPrompt(actor: string, tool: string, minutesAgo: number, source = 'hook'): string {
  vi.setSystemTime(NOW.getTime() - minutesAgo * 60_000)
  const { msgId } = events.append({
    kind: 'approval_request',
    actor,
    target: 'human',
    body: `${tool}: synthetic`,
    meta: { source, tool_name: tool, input_preview: '{}' },
  })
  return msgId
}

function deps(roster: AgentIdentity[], over: Partial<StatusDeps> = {}): StatusDeps {
  return {
    now: () => NOW,
    autonomyRoot: autonomy,
    homeDir: tmp,
    agents: async () => roster,
    waitingOwner: async () => [],
    readBudget: (dir, nowMs) => readAccountBudget(dir, nowMs),
    loadDoc: () => ({ seats: {}, pools: {}, stopped: {} }),
    inbox: () => ({ unread: 0, sinceLastSend: null }),
    poolPicks: () => [],
    scored: () => {
      throw new Error('no scorer in this test')
    },
    machine: () => ({
      headlessAgents: { live: 0, limit: 10 },
      memoryFree: { percent: 50, limit: 15 },
      cpuPressure: { someAvg60: null, limit: 40, skipped: true },
      swap: { usedPercent: 10 },
      fullSuiteSlots: { inUse: 0, total: 4 },
      headroom: {
        tmp_inodes: { usedPercent: 13, limit: 70 },
        tmp_bytes: { usedPercent: 20, limit: 85 },
        disk_bytes: { usedPercent: 40, limit: 90 },
      },
      holding: null,
    }),
    machineStop: () => null,
    waitingPermission: nowMs => readWaitingPermission(dbPath, nowMs),
    ...over,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-waiting-permission-')))
  autonomy = path.join(tmp, 'autonomy')
  dbPath = path.join(tmp, 'events.db')
  events = new EventLog(dbPath)
  writeAutonomy()
})

afterEach(() => {
  events.close()
  vi.useRealTimers()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('seats status lists agents waiting on a permission prompt', () => {
  it('shows only an open, in-window, hook-raised prompt of the seat’s own agent', async () => {
    fileHookPrompt('ss-open', 'Write', 4)
    const answered = fileHookPrompt('ss-answered', 'Bash', 3)
    events.append({ kind: 'resolution', actor: 'ss-answered', ref: answered, body: 'withdrawn' })
    fileHookPrompt('ss-asked', 'Edit', 2, 'mcp')
    fileHookPrompt('ss-stale', 'Read', WAITING_PERMISSION_WINDOW_MS / 60_000 + 5)
    fileHookPrompt('other-seat-agent', 'Write', 1)
    const roster = ['ss-open', 'ss-answered', 'ss-asked', 'ss-stale'].map(n => agent(n, SEAT))

    const status = await seatStatus(deps([...roster, agent('other-seat-agent', 'other-seat')]), SEAT)

    expect(status.waitingPermission).toEqual([
      { agent: 'ss-open', tool: 'Write', since: new Date(NOW.getTime() - 4 * 60_000).toISOString() },
    ])
    const waitLines = (lines: string[]) => lines.filter(l => l.startsWith('waiting-permission'))
    expect(waitLines(renderStatus(status))).toEqual(['waiting-permission ss-open (Write, 4m)'])
    expect(waitLines(renderBrief(status))).toEqual(['waiting-permission ss-open (Write, 4m)'])
  })

  it('prints no line when nothing waits', async () => {
    const status = await seatStatus(deps([agent('ss-idle', SEAT)]), SEAT)

    expect(status.waitingPermission).toEqual([])
    expect(renderStatus(status).some(l => l.startsWith('waiting-permission'))).toBe(false)
  })

  it('an unreadable events.db drops only the waiting-permission line', async () => {
    const absent = path.join(tmp, 'absent', 'events.db')
    const roster = [agent('ss-open', SEAT)]

    const status = await seatStatus(
      deps(roster, { waitingPermission: nowMs => readWaitingPermission(absent, nowMs) }),
      SEAT,
    )

    expect(status.waitingPermission).toEqual([])
    expect(renderStatus(status)[0]).toBe(`seat ${SEAT} at ${NOW.toISOString()}`)
  })
})
