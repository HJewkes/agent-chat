import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventLog } from '../broker/event-log.js'
import { handoffLastReport } from '../cli/verbs/handoff-last.js'

/** CC-524: `agent-chat handoff last <name>` prints the newest stored handoff and what became of its teleport. */

let dir: string
let dbPath: string
let log: EventLog

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-handoff-last-'))
  dbPath = path.join(dir, 'events.db')
  log = new EventLog(dbPath)
})

afterEach(() => {
  log.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const handoff = (body: string, predecessor: string, successor: string) =>
  log.append({ kind: 'agent_handoff', actor: 'lead', ref: predecessor, body, meta: { successor } })

const stoodDown = (predecessor: string) =>
  log.append({ kind: 'agent_stood_down', actor: 'lead', ref: predecessor })

describe('handoff last', () => {
  it('prints the newest handoff line for line under a header naming its row and time', () => {
    handoff('an older one', 'pred-1', 'succ-1')
    const { msgId } = handoff('step 3 failed twice\n\nread notes.md first', 'pred-2', 'succ-2')

    const report = handoffLastReport(dbPath, 'lead')

    expect(report.ok).toBe(true)
    expect(report.lines[0]).toMatch(new RegExp(`^handoff ${msgId} from lead at \\d{4}-\\d\\d-\\d\\dT`))
    expect(report.lines.slice(1)).toEqual(['', 'step 3 failed twice', '', 'read notes.md first'])
  })

  it('says the successor never registered when the predecessor stood down and nothing attached', () => {
    handoff('h', 'pred-1', 'succ-1')
    stoodDown('pred-1')

    expect(handoffLastReport(dbPath, 'lead').lines[0]).toContain('its successor succ-1 never registered')
  })

  it('says the successor registered once its identity attached', () => {
    handoff('h', 'pred-1', 'succ-1')
    stoodDown('pred-1')
    log.append({ kind: 'agent_attached', actor: 'lead', ref: 'succ-1' })

    expect(handoffLastReport(dbPath, 'lead').lines[0]).toContain('its successor succ-1 registered')
  })

  it('says the teleport did not go through when the predecessor never stood down', () => {
    handoff('h', 'pred-1', 'succ-1')

    expect(handoffLastReport(dbPath, 'lead').lines[0]).toContain('the teleport did not go through')
  })

  it('fails with a reason for a name that stored no handoff', () => {
    handoff('h', 'pred-1', 'succ-1')

    const report = handoffLastReport(dbPath, 'nobody')

    expect(report).toEqual({ ok: false, lines: [], errors: ['no stored handoff for "nobody"'] })
  })

  it('fails with a reason when the event log cannot be read', () => {
    const report = handoffLastReport(path.join(dir, 'missing', 'events.db'), 'lead')

    expect(report.ok).toBe(false)
    expect(report.errors?.[0]).toContain('cannot read')
  })
})
