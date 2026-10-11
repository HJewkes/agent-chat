import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseShepherdRows, type ShepherdRow } from '../agents/burndown/shepherd.js'
import { seatDispatchLog, seatMergedLog, type SpawnFacts } from '../agents/seats/dispatch-log.js'
import { foldDispatch } from '../agents/seats/dispatch-record.js'
import type { RetireOutcome } from '../agents/seats/retire-outcome.js'
import { retireSeatOutcome } from '../agents/seats/retire-seat-outcome.js'

/**
 * TP-1570: at retire the broker appends a seat agent's `merged` or `done` row from Shepherd and the report.
 * Every seat, prefix, repository and sha here is synthetic, and the autonomy root is a temp directory.
 */

const IMPLEMENTER = 'sx-ab-12'
const REVIEWER = 'sx-ab-12-review'
const REPO = 'example-org/widget'
const PR = `${REPO}#7`
const HEAD = '0123456789abcdef0123456789abcdef01234567'
const AT = new Date('2026-02-03T04:05:00.000Z')

const shepherdRow = (over: Partial<ShepherdRow> = {}): ShepherdRow => ({
  repo: REPO,
  pr: 7,
  runId: 'run-1',
  phase: 'done',
  headSha: HEAD,
  stalled: null,
  implementer: IMPLEMENTER,
  outcome: { kind: 'merged' },
  ...over,
})

const reported = (over: Partial<RetireOutcome> = {}): RetireOutcome => ({
  pr: null,
  head: null,
  failure_class: 'none',
  tool_errors: 0,
  ...over,
})

describe('retireSeatOutcome', () => {
  it('gives merged with the PR and head when the implementer matches a merged row', () => {
    const ended = retireSeatOutcome({
      agent: IMPLEMENTER,
      outcome: reported({ pr: PR }),
      shepherd: [shepherdRow()],
    })

    expect(ended).toEqual({ outcome: 'merged', pr: PR, head: HEAD })
  })

  it('matches on the agent-chat branch when the row names no implementer', () => {
    const row = shepherdRow({ implementer: undefined, branch: `agent-chat/${IMPLEMENTER}` })

    expect(retireSeatOutcome({ agent: IMPLEMENTER, outcome: reported(), shepherd: [row] })?.outcome).toBe(
      'merged',
    )
  })

  it('gives a reviewer whose report names the merged PR done, not merged', () => {
    const ended = retireSeatOutcome({
      agent: REVIEWER,
      outcome: reported({ pr: PR, head: HEAD }),
      shepherd: [shepherdRow()],
    })

    expect(ended).toEqual({ outcome: 'done', pr: PR, head: HEAD })
  })

  it('counts a post-merge row with no outcome yet as merged', () => {
    const row = shepherdRow({ phase: 'post-merge', outcome: null })

    expect(retireSeatOutcome({ agent: IMPLEMENTER, outcome: reported(), shepherd: [row] })?.outcome).toBe(
      'merged',
    )
  })

  it('gives nothing to an implementer whose PR is still in review', () => {
    const row = shepherdRow({ phase: 'review', outcome: null })

    expect(retireSeatOutcome({ agent: IMPLEMENTER, outcome: reported(), shepherd: [row] })).toBeUndefined()
  })

  it('gives nothing to an agent that sent no report', () => {
    const outcome = reported({ failure_class: 'no-report' })

    expect(retireSeatOutcome({ agent: REVIEWER, outcome, shepherd: [] })).toBeUndefined()
  })

  it('gives nothing when Shepherd was not read', () => {
    expect(retireSeatOutcome({ agent: REVIEWER, outcome: reported(), shepherd: undefined })).toBeUndefined()
  })
})

describe('the Shepherd row schema', () => {
  it('still parses a row from an older Shepherd with no implementer or outcome', () => {
    const old = { repo: REPO, pr: 7, runId: 'run-1', phase: 'review', headSha: HEAD, stalled: null }

    const rows = parseShepherdRows(JSON.stringify([old]), () => undefined)

    expect(rows).toHaveLength(1)
    expect(rows?.[0]?.implementer).toBeUndefined()
  })
})

const tmpDirs: string[] = []
let root: string
let logged: string[]

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

const logFile = (): string => path.join(root, 'logs', 'seat-x', 'dispatch.jsonl')

const rows = (): Record<string, unknown>[] =>
  fs.existsSync(logFile())
    ? fs
        .readFileSync(logFile(), 'utf8')
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line) as Record<string, unknown>)
    : []

const facts = (agent: string): SpawnFacts => ({
  profile: 'implementer',
  agent,
  agent_id: `id-${agent}`,
  spawner: 'seat-x',
  model: 'model-a',
  predecessor: null,
})

const SPEND = { usage_miss: 'not read' }

const writerWith = (shepherd: () => Promise<ShepherdRow[] | undefined>) =>
  seatDispatchLog(root, {
    now: () => AT,
    activeWork: tmp('outcome-aw-'),
    log: e => void logged.push(e),
    shepherd,
  })

const endedRows = (): Record<string, unknown>[] =>
  rows().filter(row => row.outcome === 'merged' || row.outcome === 'done')

beforeEach(() => {
  root = tmp('outcome-root-')
  fs.mkdirSync(path.join(root, 'seats'))
  fs.writeFileSync(path.join(root, 'seats', 'seat-x.md'), '---\nprefix: sx\npool: pool-a\n---\n')
  logged = []
})

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the ended writer', () => {
  it('appends one merged row by agent-chat that folds as the seat’s outcome', async () => {
    const log = writerWith(async () => [shepherdRow()])

    log.dispatched(facts(IMPLEMENTER))
    log.retired(facts(IMPLEMENTER), null, SPEND, reported({ pr: PR }))
    await log.ended?.(facts(IMPLEMENTER), reported({ pr: PR }))

    expect(endedRows()).toEqual([
      {
        ts: AT.toISOString(),
        task: 'AB-12',
        agent: IMPLEMENTER,
        pr: PR,
        head: HEAD,
        outcome: 'merged',
        by: 'agent-chat',
      },
    ])
    expect(
      foldDispatch(
        rows()
          .map(row => JSON.stringify(row))
          .join('\n'),
      ).records,
    ).toMatchObject([{ agent: IMPLEMENTER, outcome: 'merged' }])
  })

  it('adds no second row when the agent is retired twice', async () => {
    const log = writerWith(async () => [shepherdRow()])

    await log.ended?.(facts(REVIEWER), reported({ pr: PR }))
    await log.ended?.(facts(REVIEWER), reported({ pr: PR }))

    expect(endedRows()).toHaveLength(1)
    expect(endedRows()[0]).toMatchObject({ agent: REVIEWER, outcome: 'done' })
  })

  it('adds nothing when the burndown tick already wrote the merged row', async () => {
    seatMergedLog(root, { now: () => AT, log: () => undefined })({ agent: IMPLEMENTER, pr: PR })

    await writerWith(async () => [shepherdRow()]).ended?.(facts(IMPLEMENTER), reported())

    expect(endedRows()).toEqual([expect.objectContaining({ outcome: 'merged', by: 'burndown' })])
  })

  it('keeps the retired row, writes no outcome and logs once when Shepherd fails', async () => {
    const log = writerWith(() => Promise.reject(new Error('shepherd down')))

    log.retired(facts(IMPLEMENTER), null, SPEND, reported())
    await log.ended?.(facts(IMPLEMENTER), reported())
    await log.ended?.(facts(IMPLEMENTER), reported())

    expect(rows().map(row => row.outcome)).toEqual(['retired'])
    expect(logged).toEqual(['seat_outcome_unavailable'])
  })

  it('never reads Shepherd for an agent no seat owns', async () => {
    let reads = 0
    const log = writerWith(async () => {
      reads += 1
      return [shepherdRow({ implementer: 'scout' })]
    })

    await log.ended?.(facts('scout'), reported())

    expect(reads).toBe(0)
    expect(fs.existsSync(path.join(root, 'logs'))).toBe(false)
  })

  it('is absent when no Shepherd reader is given', () => {
    expect(seatDispatchLog(root).ended).toBeUndefined()
  })
})
