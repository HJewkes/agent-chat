import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PRICE_TABLE_VERSION, findPrice, type PriceRow } from '@titan-design/session-analytics'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readTranscriptSpend } from '../agents/transcript-spend.js'

const MODEL_A = 'claude-opus-5-5'
const MODEL_B = 'claude-haiku-4-5'
const TS = '2026-02-03T04:05:00.000Z'
const MILLION = 1_000_000

const tmpDirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function transcript(...lines: (object | string)[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-spend-'))
  tmpDirs.push(dir)
  const file = path.join(dir, 'session.jsonl')
  fs.writeFileSync(
    file,
    lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n',
  )
  return file
}

const assistant = (id: string | undefined, usage: object, over: Record<string, unknown> = {}) => ({
  type: 'assistant',
  timestamp: TS,
  ...over,
  message: { ...(id === undefined ? {} : { id }), model: over.model ?? MODEL_A, role: 'assistant', usage },
})

/** The rates come from the platform's table; none is written here. */
function rates(model: string): PriceRow {
  const row = findPrice(model, TS)
  if (row === null) throw new Error(`the price table has no row for ${model}`)
  return row
}

const perMillion = (tokens: number, rate: number): number =>
  Math.round(((tokens * rate) / MILLION) * 1e4) / 1e4

async function spent(file: string) {
  const read = await readTranscriptSpend(file)
  if (!read.ok) throw new Error(`expected a spend, got: ${read.reason}`)
  return read
}

describe('readTranscriptSpend', () => {
  it('sums every request of the transcript, not the last one', async () => {
    const file = transcript(
      { type: 'user', timestamp: TS, message: { role: 'user', content: 'hello' } },
      assistant('msg-1', { input_tokens: 10, output_tokens: 20 }),
      assistant('msg-2', { input_tokens: 30, output_tokens: 40, cache_read_input_tokens: 50 }),
    )

    const read = await spent(file)

    expect(read).toMatchObject({
      path: file,
      tokens: 150,
      usage: { input: 40, cache_read: 50, cache_write_5m: 0, cache_write_1h: 0, output: 60 },
      models: [MODEL_A],
      unpriced: [],
      price_table: PRICE_TABLE_VERSION,
    })
  })

  it('counts two records with one message id once', async () => {
    const usage = { input_tokens: 10, output_tokens: MILLION }
    const file = transcript(assistant('msg-1', usage), assistant('msg-1', usage))

    const read = await spent(file)

    expect(read.usage.output).toBe(MILLION)
    expect(read.tokens).toBe(MILLION + 10)
    expect(read.usd_est).toBe(
      perMillion(MILLION, rates(MODEL_A).output) + perMillion(10, rates(MODEL_A).input),
    )
  })

  it('takes the last record of a message id', async () => {
    const file = transcript(
      assistant('msg-1', { input_tokens: 10, output_tokens: 1 }),
      assistant('msg-2', { input_tokens: 5, output_tokens: 5 }),
      assistant('msg-1', { input_tokens: 10, output_tokens: 90 }),
    )

    expect((await spent(file)).usage).toMatchObject({ input: 15, output: 95 })
  })

  it('counts each record that carries no message id', async () => {
    const usage = { input_tokens: 10, output_tokens: 20 }
    const file = transcript(assistant(undefined, usage), assistant(undefined, usage))

    expect((await spent(file)).tokens).toBe(60)
  })

  it('prices 5m and 1h cache writes at their own rates', async () => {
    const row = rates(MODEL_A)
    const write = (split: object) => ({ cache_creation_input_tokens: MILLION, cache_creation: split })
    const fiveMinute = transcript(assistant('msg-1', write({ ephemeral_5m_input_tokens: MILLION })))
    const oneHour = transcript(assistant('msg-1', write({ ephemeral_1h_input_tokens: MILLION })))

    const [short, long] = [await spent(fiveMinute), await spent(oneHour)]

    expect(row.cacheWrite1h).not.toBe(row.cacheWrite5m)
    expect(short.usage).toMatchObject({ cache_write_5m: MILLION, cache_write_1h: 0 })
    expect(short.usd_est).toBe(row.cacheWrite5m)
    expect(long.usage).toMatchObject({ cache_write_5m: 0, cache_write_1h: MILLION })
    expect(long.usd_est).toBe(row.cacheWrite1h)
    expect(long.tokens).toBe(MILLION)
  })

  it('splits one request that wrote both cache lifetimes', async () => {
    const row = rates(MODEL_A)
    const file = transcript(
      assistant('msg-1', {
        cache_creation_input_tokens: 3 * MILLION,
        cache_creation: { ephemeral_5m_input_tokens: MILLION, ephemeral_1h_input_tokens: 2 * MILLION },
      }),
    )

    const read = await spent(file)

    expect(read.usage).toMatchObject({ cache_write_5m: MILLION, cache_write_1h: 2 * MILLION })
    expect(read.tokens).toBe(3 * MILLION)
    expect(read.usd_est).toBe(row.cacheWrite5m + 2 * row.cacheWrite1h)
  })

  it('counts a cache write without the split as 5m', async () => {
    const file = transcript(assistant('msg-1', { cache_creation_input_tokens: MILLION }))

    const read = await spent(file)

    expect(read.usage).toMatchObject({ cache_write_5m: MILLION, cache_write_1h: 0 })
    expect(read.usd_est).toBe(rates(MODEL_A).cacheWrite5m)
  })

  it('prices a cache read at the read rate', async () => {
    const row = rates(MODEL_A)
    const file = transcript(assistant('msg-1', { input_tokens: 0, cache_read_input_tokens: MILLION }))

    const read = await spent(file)

    expect(row.cacheRead).not.toBe(row.input)
    expect(read.usage).toMatchObject({ input: 0, cache_read: MILLION })
    expect(read.usd_est).toBe(row.cacheRead)
  })

  it('prices two models in one transcript separately', async () => {
    const file = transcript(
      assistant('msg-1', { output_tokens: MILLION }),
      assistant('msg-2', { output_tokens: MILLION }, { model: MODEL_B }),
    )

    const read = await spent(file)

    expect(rates(MODEL_A).output).not.toBe(rates(MODEL_B).output)
    expect(read.models).toEqual([MODEL_A, MODEL_B])
    expect(read.usd_est).toBe(rates(MODEL_A).output + rates(MODEL_B).output)
  })

  it('gives a null usd_est and real tokens for a model with no price row', async () => {
    const file = transcript(
      assistant('msg-1', { input_tokens: 100, output_tokens: 200 }),
      assistant('msg-2', { input_tokens: 1, output_tokens: 2 }, { model: 'model-unknown-9' }),
    )

    const read = await spent(file)

    expect(read.usd_est).toBeNull()
    expect(read.tokens).toBe(303)
    expect(read.unpriced).toEqual(['model-unknown-9'])
    expect(read.models).toEqual([MODEL_A, 'model-unknown-9'])
  })

  it('never prices a request that names no model', async () => {
    const file = transcript({
      type: 'assistant',
      timestamp: TS,
      message: { id: 'msg-1', role: 'assistant', usage: { input_tokens: 10, output_tokens: 20 } },
    })

    const read = await spent(file)

    expect(read.usd_est).toBeNull()
    expect(read.tokens).toBe(30)
    expect(read.unpriced).toEqual(['unknown'])
  })

  it('prices a request at its own timestamp, and leaves one with no timestamp unpriced', async () => {
    const usage = { input_tokens: 1000, output_tokens: 1000 }
    const dated = await spent(transcript(assistant('msg-1', usage)))
    const undated = await spent(transcript(assistant('msg-1', usage, { timestamp: undefined })))

    expect(dated.usd_est).toBe(
      perMillion(1000, rates(MODEL_A).input) + perMillion(1000, rates(MODEL_A).output),
    )
    expect(undated.tokens).toBe(2000)
    expect(undated.usd_est).toBeNull()
  })

  it('counts a negative token count as zero', async () => {
    const read = await spent(transcript(assistant('msg-1', { input_tokens: -50, output_tokens: 20 })))

    expect(read.usage.input).toBe(0)
    expect(read.tokens).toBe(20)
  })

  it('skips a <synthetic> record', async () => {
    const file = transcript(
      assistant('msg-1', { input_tokens: 10, output_tokens: 20 }),
      assistant('msg-2', { input_tokens: 500, output_tokens: 500 }, { model: '<synthetic>' }),
    )

    const read = await spent(file)

    expect(read.tokens).toBe(30)
    expect(read.models).toEqual([MODEL_A])
  })

  it("counts a subagent's sidechain turns", async () => {
    const file = transcript(
      assistant('msg-1', { input_tokens: 10, output_tokens: 20 }),
      assistant('msg-2', { input_tokens: 1, output_tokens: 2 }, { isSidechain: true }),
    )

    expect((await spent(file)).tokens).toBe(33)
  })

  it('rounds usd_est to 4 places', async () => {
    const file = transcript(assistant('msg-1', { output_tokens: 12_345 }))

    const usd = (await spent(file)).usd_est ?? Number.NaN

    expect(usd).toBeGreaterThan(0)
    expect(usd).toBe(perMillion(12_345, rates(MODEL_A).output))
    expect(Number(usd.toFixed(4))).toBe(usd)
  })

  it('returns a reason for a missing file', async () => {
    const file = path.join(os.tmpdir(), 'agent-chat-spend-absent', 'session.jsonl')

    await expect(readTranscriptSpend(file)).resolves.toEqual({
      ok: false,
      path: file,
      reason: 'no transcript written',
    })
  })

  it('returns a reason for a garbage file', async () => {
    const file = transcript(
      'not json at all',
      '{"type":"assistant","message":{"usage":',
      '\u0000\u0001"usage"\u0002',
    )

    await expect(readTranscriptSpend(file)).resolves.toEqual({
      ok: false,
      path: file,
      reason: 'no assistant usage record in the transcript',
    })
  })

  it('returns a reason for a path it cannot read as a file', async () => {
    const dir = path.dirname(transcript())

    const read = await readTranscriptSpend(dir)

    expect(read).toEqual({ ok: false, path: dir, reason: 'unreadable transcript (EISDIR)' })
  })

  it('skips garbage lines between real records', async () => {
    const file = transcript(
      'not json',
      assistant('msg-1', { input_tokens: 10, output_tokens: 20 }),
      '{"type":"assistant","message":{"usage":',
      { type: 'assistant', timestamp: TS, message: 'a string, not a message with "usage"' },
    )

    expect((await spent(file)).tokens).toBe(30)
  })

  it('reads a transcript of many chunks as a stream and never whole', async () => {
    const padding = 'x'.repeat(1500)
    const records = Array.from({ length: 300 }, (_, i) =>
      assistant(`msg-${i}`, { input_tokens: 1, output_tokens: 2 }, { padding }),
    )
    const file = transcript(...records, assistant('msg-last', { input_tokens: 7 }))
    // A live transcript's last record may have no newline yet.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').trimEnd())
    const stream = vi.spyOn(fs, 'createReadStream')
    const whole = [
      vi.spyOn(fs, 'readFileSync'),
      vi.spyOn(fs, 'readFile'),
      vi.spyOn(fs.promises, 'readFile'),
      vi.spyOn(fs, 'readSync'),
    ]

    const read = await spent(file)

    expect(fs.statSync(file).size).toBeGreaterThan(4 * 64 * 1024)
    expect(read.tokens).toBe(300 * 3 + 7)
    expect(stream).toHaveBeenCalledWith(file, 'utf8')
    for (const spy of whole) expect(spy).not.toHaveBeenCalled()
  })
})
