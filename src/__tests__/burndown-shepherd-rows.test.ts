import { describe, expect, it } from 'vitest'
import { advance, claimKey, type Observation } from '../agents/burndown/advance.js'
import type { Runner } from '../agents/burndown/exec.js'
import type { Claim } from '../agents/burndown/ledger.js'
import { observe } from '../agents/burndown/observe.js'
import { registerWithShepherd, shepherdRows } from '../agents/burndown/shepherd.js'

/** CC-791: one row Shepherd's status answers in a shape this build does not know must not blind the whole read. */

const NOW = new Date('2026-10-06T12:00:00.000Z')
const PR = 'https://github.com/o/r/pull/9'
const good = { repo: 'o/r', pr: 9, runId: 'run-9', phase: 'ci', headSha: 'h9', stalled: null }
const other = { ...good, pr: 10, runId: 'run-10', phase: 'review' }

function status(stdout: string, code = 0): Runner {
  return (_bin, args) => (args[1] === 'status' ? { status: code, stdout } : { status: 0, stdout: '' })
}

function read(rows: unknown[]): { rows: ReturnType<typeof shepherdRows>; logged: unknown[][] } {
  const logged: unknown[][] = []
  const result = shepherdRows(status(JSON.stringify(rows)), (event, detail) => logged.push([event, detail]))
  return { rows: result, logged }
}

const shepherding: Claim = {
  taskId: 'CC-1',
  initiative: 'demo',
  agentId: 'a1',
  agentName: 'bd-cc-1',
  spawned: ['bd-cc-1'],
  spawnedAt: '2026-10-06T11:00:00.000Z',
  phase: 'shepherding',
  phaseAt: '2026-10-06T11:00:00.000Z',
  pr: PR,
}

describe('reading Shepherd status row by row (CC-791)', () => {
  it('keeps a held row as unknown beside good rows and logs it once', () => {
    const { rows, logged } = read([other, { ...good, phase: 'held' }])

    expect(rows).toEqual([other, { ...good, phase: 'unknown' }])
    expect(logged).toEqual([
      ['burndown_shepherd_row_unknown_phase', { target: 'o/r#9', runId: 'run-9', phase: 'held' }],
    ])
  })

  it('keeps any phase this build has never seen as unknown', () => {
    const { rows } = read([{ ...good, phase: 'quarantined-by-owner' }])

    expect(rows).toEqual([{ ...good, phase: 'unknown' }])
  })

  it('skips a malformed row with its reason and keeps the good rows', () => {
    const { rows, logged } = read([good, { repo: 'o/r', pr: 'eleven' }, other])

    expect(rows).toEqual([good, other])
    expect(logged).toEqual([
      ['burndown_shepherd_row_skipped', { index: 1, reason: expect.stringContaining('pr') }],
    ])
  })

  it.each([
    ['the command fails', status('', 1)],
    ['the answer is not JSON', status('Shepherd is starting')],
    ['the answer is not an array', status('{"rows":[]}')],
  ])('is still undefined when %s', (_case, exec) => {
    expect(shepherdRows(exec, () => {})).toBeUndefined()
  })

  it('observes the claim beside a held row instead of withholding every PR claim', async () => {
    const held = { ...other, phase: 'held' }
    const rows = shepherdRows(status(JSON.stringify([good, held])), () => {})

    const { observations, unread } = await observe(
      [shepherding, { ...shepherding, taskId: 'CC-2', pr: 'https://github.com/o/r/pull/10' }],
      { agents: [] },
      { root: '/active-work', inboxSince: async () => [], shepherdRows: () => rows },
    )

    expect(unread).toEqual([])
    expect(observations.get(claimKey(shepherding))?.shepherd?.row?.phase).toBe('ci')
  })

  it('leaves a claim whose own row is unknown shepherding, neither merged, ended nor re-registered', () => {
    const obs: Observation = { shepherd: { row: { ...good, phase: 'unknown' } } }

    const actions = advance([shepherding], new Map([[claimKey(shepherding), obs]]), NOW)

    expect(actions).toEqual([])
  })

  it('does not re-register a PR whose listed row is in an unknown phase', () => {
    const calls: string[][] = []
    const exec: Runner = (_bin, args) => {
      calls.push(args)
      return { status: 0, stdout: args[1] === 'status' ? JSON.stringify([{ ...good, phase: 'held' }]) : '' }
    }

    registerWithShepherd(
      { target: { repo: 'o/r', pr: 9 }, task: 'demo/CC-1', implementer: 'w', headSha: 'h9' },
      exec,
    )

    expect(calls.some(a => a[1] === 'register')).toBe(false)
  })
})
