import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SHADOW_MAX_RECORDS,
  SHADOW_RETENTION_MS,
  ShadowRecordV1,
  writeShadowRecord,
  type ShadowCapture,
} from '../agents/burndown/shadow-record.js'
import { TickConfigSchema } from '../agents/burndown/source.js'

/** CC-1193 S0a: the shadow record's content-addressed ledgers, its retention, and the v1 contract fixture. */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'shadow-record.v1.json')
const NOW = new Date('2026-10-13T12:00:00.000Z')
const HOUR = 3_600_000

let dir: string

const capture = (ledgerText = '{"version":1,"claims":[]}'): ShadowCapture => ({
  ledgerText,
  config: TickConfigSchema.parse({ enabled: true }),
  decisions: {
    steps: [],
    dispatches: [],
    refusals: [],
    triage: [],
    briefs: { approved: [], routed: [] },
    closing: [],
    reasons: [],
  },
})

const list = (sub: 'records' | 'ledgers'): string[] => fs.readdirSync(path.join(dir, sub)).sort()
const at = (ms: number): Date => new Date(NOW.getTime() + ms)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-shadow-'))
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('writeShadowRecord', () => {
  it('stores an unchanged ledger once for two ticks, and a changed one beside it', () => {
    writeShadowRecord(dir, capture(), at(0))
    writeShadowRecord(dir, capture(), at(60_000))
    writeShadowRecord(dir, capture('{"version":1,"claims":[1]}'), at(120_000))

    expect(list('records')).toHaveLength(3)
    expect(list('ledgers')).toHaveLength(2)
  })

  it('keys the record by the tick time and the sha of the ledger it stored', () => {
    writeShadowRecord(dir, capture(), NOW)

    const [name] = list('records')
    const record = ShadowRecordV1.parse(JSON.parse(fs.readFileSync(path.join(dir, 'records', name!), 'utf8')))
    expect(record.ts).toBe(NOW.toISOString())
    expect(list('ledgers')).toEqual([`${record.ledgerSha}.json`])
  })

  it('drops records older than 72 h and the ledgers only they named', () => {
    writeShadowRecord(dir, capture('{"old":true}'), at(-SHADOW_RETENTION_MS - HOUR))
    writeShadowRecord(dir, capture(), at(-HOUR))

    writeShadowRecord(dir, capture(), NOW)

    expect(list('records')).toHaveLength(2)
    expect(list('ledgers')).toHaveLength(1)
  })

  it('keeps at most 500 records, the newest', () => {
    for (let i = 0; i <= SHADOW_MAX_RECORDS; i += 1) writeShadowRecord(dir, capture(), at(i * 1000))

    const names = list('records')
    expect(names).toHaveLength(SHADOW_MAX_RECORDS)
    expect(names[0]).toMatch(new RegExp(`^0*${NOW.getTime() + 1000}-`))
  })
})

describe('the shadow-record v1 fixture', () => {
  it('parses under the v1 schema with every decision list present', () => {
    const fixture = ShadowRecordV1.parse(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))

    expect(Object.keys(fixture.decisions).sort()).toEqual(
      Object.keys(ShadowRecordV1.shape.decisions.shape).sort(),
    )
  })
})
