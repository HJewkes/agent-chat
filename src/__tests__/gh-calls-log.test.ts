import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ghCallsVerb } from '../cli/verbs/gh-calls.js'
import {
  appendCall,
  callLine,
  classify403,
  ghCallsDir,
  limitFromStderr,
  routeTemplate,
  type CallInput,
} from '../gh-calls/log.js'
import { readCalls, summarize } from '../gh-calls/summary.js'

const rest = (over: Partial<CallInput> = {}): CallInput => ({
  caller: 'shim',
  api: 'rest',
  method: 'GET',
  route: 'repos/{o}/{r}/pulls/{n}',
  status: 200,
  ms: 120,
  ...over,
})

let state: string
let dir: string

beforeEach(() => {
  state = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-calls-'))
  vi.stubEnv('XDG_STATE_HOME', state)
  dir = ghCallsDir()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  fs.rmSync(state, { recursive: true, force: true })
})

describe('routeTemplate', () => {
  it('replaces owner, repo and numbers and drops the query', () => {
    expect(routeTemplate('repos/HJewkes/agent-chat/pulls/755/files?per_page=100')).toBe(
      'repos/{o}/{r}/pulls/{n}/files',
    )
  })

  it('keeps a route outside repos as written', () => {
    expect(routeTemplate('/rate_limit')).toBe('rate_limit')
  })
})

describe('classify403', () => {
  it('puts a 403 with quota left under the secondary limit', () => {
    expect(classify403(callLine(rest({ status: 403, remaining: 4999 })))).toBe('secondary')
  })

  it('puts a 403 with no quota left under the primary limit', () => {
    expect(classify403(callLine(rest({ status: 403, remaining: 0 })))).toBe('primary')
  })

  it('trusts the kind a writer read from stderr over the headers', () => {
    const limit = limitFromStderr('HTTP 403: You have exceeded a secondary rate limit.')
    const line = callLine(rest({ status: 403, remaining: 0, ...(limit && { limit }) }))
    expect(classify403(line)).toBe('secondary')
  })

  it('ignores a call that was not refused', () => {
    expect(classify403(callLine(rest()))).toBeNull()
  })
})

describe('appendCall', () => {
  it('writes each UTC day to its own file', () => {
    appendCall(callLine(rest(), new Date('2026-10-11T23:59:00Z')), fs, dir)
    appendCall(callLine(rest(), new Date('2026-10-12T00:01:00Z')), fs, dir)

    expect(fs.readdirSync(dir).sort()).toEqual(['2026-10-11.jsonl', '2026-10-12.jsonl'])
    const [line] = fs.readFileSync(path.join(dir, '2026-10-12.jsonl'), 'utf8').trim().split('\n')
    expect(JSON.parse(line ?? '')).toMatchObject({ v: 1, caller: 'shim', remaining: null, resource: null })
  })

  it('prunes the eighth-day file when a new day starts', () => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '2026-10-05.jsonl'), '')
    fs.writeFileSync(path.join(dir, '2026-10-06.jsonl'), '')

    appendCall(callLine(rest(), new Date('2026-10-12T08:00:00Z')), fs, dir)

    expect(fs.readdirSync(dir).sort()).toEqual(['2026-10-06.jsonl', '2026-10-12.jsonl'])
  })

  it('reports a failed write instead of throwing', () => {
    const blocked = path.join(state, 'file')
    fs.writeFileSync(blocked, '')
    expect(appendCall(callLine(rest()), fs, path.join(blocked, 'gh-calls'))).toBe(false)
  })
})

describe('reading the log', () => {
  const at = (iso: string) => new Date(iso)

  it('reads only lines inside the window', () => {
    appendCall(callLine(rest({ caller: 'old' }), at('2026-10-10T12:00:00Z')), fs, dir)
    appendCall(callLine(rest({ caller: 'new' }), at('2026-10-12T12:00:00Z')), fs, dir)

    const lines = readCalls(at('2026-10-11T12:00:00Z'), fs, dir)

    expect(lines.map(line => line.caller)).toEqual(['new'])
  })

  it('counts the rate-limit reading apart from the calls', () => {
    const now = at('2026-10-12T12:00:00Z')
    appendCall(callLine(rest({ caller: 'tick' }), now), fs, dir)
    appendCall(
      callLine(
        rest({
          caller: 'rate-limit',
          route: 'rate_limit',
          limits: { core: 4100, graphql: 5000, search: 30 },
        }),
        now,
      ),
      fs,
      dir,
    )

    const summary = summarize(readCalls(at('2026-10-12T00:00:00Z'), fs, dir), at('2026-10-12T00:00:00Z'), 5)

    expect(summary.total).toBe(1)
    expect(summary.rateLimit?.limits).toEqual({ core: 4100, graphql: 5000, search: 30 })
  })

  it('gh-calls --top 2 --json ranks callers by count and splits 403s', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-12T12:00:00Z'), toFake: ['Date'] })
    const write = (over: Partial<CallInput>) => appendCall(callLine(rest(over)), fs, dir)
    for (let i = 0; i < 3; i++) write({ caller: 'burndown-tick' })
    for (let i = 0; i < 2; i++) write({ caller: 'shim' })
    write({ caller: 'session-miner', status: 403, remaining: 4999 })
    write({ caller: 'shim', status: 403, remaining: 0 })

    const report = await ghCallsVerb.run({ since: '24h', top: 2, json: true }, {} as never)

    const summary = JSON.parse(report.lines[0] ?? '')
    expect(summary.callers).toEqual([
      { name: 'burndown-tick', count: 3 },
      { name: 'shim', count: 3 },
    ])
    expect(summary.refused).toEqual({ secondary: 1, primary: 1, unknown: 0 })
  })

  it('gh-calls refuses a malformed --since', async () => {
    const report = await ghCallsVerb.run({ since: 'yesterday' }, {} as never)
    expect(report.ok).toBe(false)
  })
})
