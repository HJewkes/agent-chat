import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventLog } from '../broker/event-log.js'
import { buildHookSettings } from '../agents/launch-files.js'
import {
  openBlocks,
  paneQuestionVerdict,
  parseToolHook,
  recordToolCall,
  seatBlockReport,
} from '../seat-blocks.js'

const MIN = 60_000
let dir: string
let log: EventLog

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-blocks-'))
  log = new EventLog(path.join(dir, 'events.db'))
})
afterEach(() => {
  log.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const ask = { sessionId: 's1', toolName: 'AskUserQuestion' }
const bash = { sessionId: 's1', toolName: 'Bash' }

/** Rewrites row timestamps so a window can be asserted without sleeping. */
function setTimes(times: number[]): void {
  const ids = log.seatBlockRows(0, Date.now() + MIN).map(r => r.id)
  const db = log.ledgerHandle()
  times.forEach((ts, i) => db.prepare('UPDATE events SET ts = ? WHERE id = ?').run(ts, ids[i] as number))
}

describe('seat block instrument', () => {
  it('reports the minutes between a block and its unblock', () => {
    recordToolCall(log, 'coord', 'pre', ask)
    recordToolCall(log, 'coord', 'post', ask)
    setTimes([1_000_000, 1_000_000 + 90 * MIN])

    const report = seatBlockReport(log, 0, 1_000_000 + 120 * MIN)

    expect(report.minutesBySeat).toEqual({ coord: 90 })
    expect(report.open).toEqual([])
  })

  it('lists a block with no answer as open and counts it to now', () => {
    recordToolCall(log, 'coord', 'pre', ask)
    setTimes([1_000_000])

    const open = openBlocks(log, 1_000_000 + 7 * MIN)

    expect(open).toEqual([{ seat: 'coord', sessionId: 's1', since: 1_000_000, minutes: 7 }])
    expect(openBlocks(log, 1_000_000 + 7 * MIN, 10)).toEqual([])
    expect(seatBlockReport(log, 0, 1_000_000 + 7 * MIN).minutesBySeat).toEqual({ coord: 7 })
  })

  it('counts only the part of a block inside the window', () => {
    recordToolCall(log, 'coord', 'pre', ask)
    recordToolCall(log, 'coord', 'post', ask)
    setTimes([1_000_000, 1_000_000 + 60 * MIN])

    const report = seatBlockReport(log, 1_000_000 + 30 * MIN, 1_000_000 + 120 * MIN)

    expect(report.minutesBySeat).toEqual({ coord: 30 })
  })

  it('ends a block when the session runs another tool', () => {
    recordToolCall(log, 'coord', 'pre', ask)
    recordToolCall(log, 'coord', 'pre', bash)
    setTimes([1_000_000, 1_000_000 + 5 * MIN])

    const report = seatBlockReport(log, 0, 1_000_000 + 60 * MIN)

    expect(report.minutesBySeat).toEqual({ coord: 5 })
    expect(report.open).toEqual([])
  })

  it('closes a block at the next prompt or session end with no tool call', () => {
    recordToolCall(log, 'coord', 'pre', ask)
    recordToolCall(log, 'coord', 'end', ask)
    setTimes([1_000_000, 1_000_000 + 4 * MIN])

    const report = seatBlockReport(log, 0, 1_000_000 + 60 * MIN)

    expect(report).toEqual({ minutesBySeat: { coord: 4 }, open: [] })
  })

  it('writes nothing at a prompt when no block is open', () => {
    recordToolCall(log, 'coord', 'end', bash)

    expect(log.seatBlockRows(0, Date.now() + MIN)).toEqual([])
  })

  it('reports nothing for a seat that never blocks', () => {
    recordToolCall(log, 'coord', 'pre', bash)

    const report = seatBlockReport(log, 0, Date.now() + MIN)

    expect(report).toEqual({ minutesBySeat: {}, open: [] })
  })

  it('writes nothing for a session that is not a seat', () => {
    recordToolCall(log, undefined, 'pre', ask)
    recordToolCall(log, undefined, 'pre', bash)

    expect(log.seatBlockRows(0, Date.now() + MIN)).toEqual([])
  })

  it('writes at most one activity row per session per minute', () => {
    recordToolCall(log, 'coord', 'pre', bash)
    recordToolCall(log, 'coord', 'pre', bash)
    setTimes([Date.now() - 2 * MIN])
    recordToolCall(log, 'coord', 'pre', bash)

    const rows = log.seatBlockRows(0, Date.now() + MIN)
    expect(rows.map(r => r.kind)).toEqual(['seat_activity', 'seat_activity'])
  })

  it('ignores a hook payload it cannot read', () => {
    expect(parseToolHook('not json')).toBeUndefined()
    expect(parseToolHook('{"session_id":"s1","tool_name":"Bash"}')).toEqual(bash)
  })

  it('installs the hooks for a spawned agent only, closing a block on a prompt, stop and session end', () => {
    const hooks = buildHookSettings('/x/cli.js').hooks as Record<string, unknown>
    const commands = (event: string): string => JSON.stringify(hooks[event])

    expect(commands('PreToolUse')).toContain('seat-hook pre')
    expect(commands('PostToolUse')).toContain('seat-hook post')
    for (const event of ['UserPromptSubmit', 'Stop', 'SessionEnd'])
      expect(commands(event)).toContain('seat-hook end')
  })
})

describe('a seat pane question (CC-1092)', () => {
  it('denies a seat asking a pane question', () => {
    expect(paneQuestionVerdict('demo-coord', 'AskUserQuestion', () => true)).toBe('deny')
  })

  it('lets a non-seat attended session keep AskUserQuestion', () => {
    expect(paneQuestionVerdict('tp-operator', 'AskUserQuestion', () => false)).toBe('allow')
  })

  it("leaves a seat's other tools untouched, without looking the seat up", () => {
    let lookedUp = false
    const isSeat = (): boolean => {
      lookedUp = true
      return true
    }

    expect(paneQuestionVerdict('demo-coord', 'Bash', isSeat)).toBe('allow')
    expect(lookedUp).toBe(false)
  })

  it('writes seat_ask_denied for a denied question and never seat_blocked', () => {
    recordToolCall(log, 'demo-coord', 'pre', ask, true)

    const rows = log.ledgerHandle().prepare('SELECT kind FROM events ORDER BY id').all() as { kind: string }[]
    expect(rows.map(r => r.kind)).toEqual(['seat_ask_denied'])
    expect(openBlocks(log, Date.now() + MIN)).toEqual([])
  })
})
