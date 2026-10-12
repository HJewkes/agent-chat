import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seatDispatchLog, type SeatDispatchLog, type SpawnFacts } from '../agents/seats/dispatch-log.js'
import { UNREAD_OUTCOME } from '../agents/seats/retire-outcome.js'

/**
 * TP-2529 a: Shepherd's `rv-*` reviewers match no seat, so their dispatched and retired rows go to
 * `logs/shepherd/dispatch.jsonl`. Seats, names and roots here are synthetic temp directories.
 */

const AT = new Date('2026-02-03T04:05:00Z')
const REVIEWER = 'rv-example-repo-1257'
const USAGE = { input: 10, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, output: 5 }
const SPEND = { tokens: 15, usd_est: 0.02, usage: USAGE, models: ['model-a'], price_table: 1 }

const tmpDirs: string[] = []
let root: string
let activeWork: string

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

const writer = (): SeatDispatchLog => seatDispatchLog(root, { now: () => AT, activeWork, log: () => {} })

const facts = (agent: string, spawner = 'shepherd-daemon'): SpawnFacts => ({
  profile: 'reviewer',
  agent,
  agent_id: 'id-1',
  spawner,
  model: 'model-a',
  predecessor: null,
})

const rowsOf = (dir: string): Record<string, unknown>[] => {
  const file = path.join(root, 'logs', dir, 'dispatch.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

const spawnAndRetire = (agent: string, spawner?: string): void => {
  const log = writer()
  log.dispatched(facts(agent, spawner))
  log.retired(facts(agent, spawner), 'session-rv', SPEND, UNREAD_OUTCOME)
}

beforeEach(() => {
  root = tmp('shepherd-rv-root-')
  activeWork = tmp('shepherd-rv-aw-')
  fs.mkdirSync(path.join(root, 'seats'))
  fs.writeFileSync(path.join(root, 'seats', 'seat-x.md'), '---\nprefix: sx\npool: pool-a\n---\n')
})

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('dispatch rows for Shepherd reviewers that match no seat', () => {
  it('writes the dispatched and retired rows of an rv- reviewer to the shepherd log, with session and spend', () => {
    spawnAndRetire(REVIEWER)

    const rows = rowsOf('shepherd')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ agent: REVIEWER, outcome: 'dispatched', task: null, by: 'broker' })
    expect(rows[1]).toMatchObject({
      agent: REVIEWER,
      outcome: 'retired',
      session_id: 'session-rv',
      tokens: 15,
      usd_est: 0.02,
      usage: USAGE,
      models: ['model-a'],
    })
  })

  it('leaves a seat agent in its own seat log and writes nothing to the shepherd log', () => {
    spawnAndRetire('sx-ab-12-fix', 'seat-x')

    expect(rowsOf('seat-x')).toHaveLength(2)
    expect(rowsOf('shepherd')).toEqual([])
  })

  it('writes nothing for an unseated agent whose name does not start with rv-', () => {
    spawnAndRetire('other-ab-12-fix', 'human')

    expect(fs.existsSync(path.join(root, 'logs'))).toBe(false)
  })
})
