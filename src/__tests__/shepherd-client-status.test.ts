import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Runner } from '../exec.js'
import {
  SHEPHERD_STATUS_ALL_ARGS,
  SHEPHERD_STATUS_DEPLOY_ARGS,
  parseShepherdStatus,
  shepherdRows,
  shepherdStatus,
} from '../shepherd-client.js'

/** CC-1106: one Shepherd read carries both the rows and the review slots. */

const LIVE = readFileSync(join(__dirname, 'fixtures/shepherd-status-deploy-2026-10-14.json'), 'utf8')
const row = { repo: 'o/r', pr: 9, runId: 'run-9', phase: 'review', headSha: 'h9', stalled: null }
const quiet = (): void => undefined

describe('reading shepherd status with --deploy', () => {
  it('reads the rows and slots of a live --all --deploy answer, finished runs included', () => {
    const status = parseShepherdStatus(LIVE, quiet)

    expect(status?.rows).toHaveLength(9)
    expect(status?.rows.filter(r => r.phase === 'done')).toHaveLength(1)
    expect(status?.reviewSlots).toEqual({ cap: 24, running: ['rv-hjewkes-agent-chat-931-2'] })
  })

  it('reads a bare array from an older Shepherd as rows with no slots', () => {
    const status = parseShepherdStatus(JSON.stringify([row]), quiet)

    expect(status).toEqual({ rows: [row] })
  })

  it('keeps the cap and drops running when the roster read failed', () => {
    const slots = { running: [], cap: 16, readAt: 'x', rosterError: 'agent-chat timed out after 30 s' }

    const status = parseShepherdStatus(JSON.stringify({ rows: [row], reviewSlots: slots }), quiet)

    expect(status?.reviewSlots).toEqual({ cap: 16 })
  })

  it('reads malformed slots as absent and logs why', () => {
    const logged: string[] = []

    const status = parseShepherdStatus(JSON.stringify({ rows: [row], reviewSlots: { cap: 'many' } }), e =>
      logged.push(e),
    )

    expect(status).toEqual({ rows: [row] })
    expect(logged).toEqual(['shepherd_review_slots_unread'])
  })

  it.each([['not json'], ['{"deploy": {}}'], ['null'], ['7']])('reads %s as unread', body => {
    expect(parseShepherdStatus(body, quiet)).toBeUndefined()
  })

  it('runs status --json --all --deploy and reads nothing when Shepherd is down', () => {
    const calls: string[][] = []
    const down: Runner = (_bin, args) => (calls.push(args), { status: 1, stdout: '' })

    expect(shepherdStatus(down, quiet)).toBeUndefined()
    expect(calls).toEqual([['shepherd', 'status', '--json', '--all', '--deploy']])
    expect(SHEPHERD_STATUS_DEPLOY_ARGS).toEqual([...SHEPHERD_STATUS_ALL_ARGS, '--deploy'])
  })

  it('leaves shepherdRows on the bare --all read', () => {
    const calls: string[][] = []
    const up: Runner = (_bin, args) => (calls.push(args), { status: 0, stdout: JSON.stringify([row]) })

    expect(shepherdRows(up, quiet)).toEqual([row])
    expect(calls).toEqual([SHEPHERD_STATUS_ALL_ARGS])
  })
})
