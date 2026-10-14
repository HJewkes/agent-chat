import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reviewBacklog } from '../agents/burndown/review-backlog.js'
import { parseShepherdStatus, type ShepherdRow } from '../shepherd-client.js'

/** CC-1106: the queued-review count review backpressure gates on. */

const base = { repo: 'o/r', headSha: 'h', stalled: null }
let n = 0
function row(phase: ShepherdRow['phase'], held?: string): ShepherdRow {
  n += 1
  return { ...base, pr: n, runId: `run-${n}`, phase, held: held === undefined ? null : { reason: held } }
}

const rows = [
  row('review'),
  row('review'),
  row('review'),
  row('review', 'g10-adversary: security touch'),
  row('review', 'account-exhausted: /accounts/review until 2026-10-14T18:00:00.000Z; TP-1955'),
  row('fixing'),
  row('awaiting-approval'),
]

describe('counting queued reviews', () => {
  it('counts unheld and account-held review rows, leaving out other holds and other phases', () => {
    const backlog = reviewBacklog(rows, { cap: 16, running: ['rv-1'] })

    expect(backlog).toEqual({ queued: 3, waiting: 4, running: 1, cap: 16 })
  })

  it('takes every slot as busy when the roster was unread', () => {
    expect(reviewBacklog(rows, { cap: 3 })).toEqual({ queued: 1, waiting: 4, running: 3, cap: 3 })
    expect(reviewBacklog(rows, { cap: 16 })).toEqual({ queued: 0, waiting: 4, running: 4, cap: 16 })
  })

  it('never reports a negative queue when more reviewers run than reviews wait', () => {
    const backlog = reviewBacklog([row('review')], { cap: 16, running: ['rv-1', 'rv-2', 'rv-3'] })

    expect(backlog).toEqual({ queued: 0, waiting: 1, running: 3, cap: 16 })
  })

  it('is unknown when Shepherd carried no review slots', () => {
    expect(reviewBacklog(rows, undefined)).toEqual({ unknown: 'shepherd status carried no reviewSlots' })
  })

  it('reads the live 2026-10-14 answer as nothing queued: every review row was g10- or reviewer-held', () => {
    const live = readFileSync(join(__dirname, 'fixtures/shepherd-status-deploy-2026-10-14.json'), 'utf8')
    const status = parseShepherdStatus(live, () => undefined)

    expect(reviewBacklog(status?.rows ?? [], status?.reviewSlots)).toEqual({
      queued: 0,
      waiting: 0,
      running: 1,
      cap: 24,
    })
  })
})
