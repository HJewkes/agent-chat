import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildProgram } from '../cli/index.js'
import {
  budgetDir,
  budgetMiss,
  budgetPath,
  formatBudget,
  parseBudget,
  readBudget,
  STALE_AFTER_SECONDS,
} from '../agents/budget.js'

/**
 * A fake status cache, so nothing here reads the developer's real sessions —
 * the same discipline transcript.test.ts uses to stay off real transcripts.
 */
let cacheDir: string

const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  session_id: 'abc-123',
  cwd: '/tmp/work',
  model_id: 'claude-opus-5',
  written_at: 1_700_000_000,
  context: {
    used_pct: 43.2,
    remaining_pct: 56.8,
    window_size: 200000,
    input_tokens: 86000,
    output_tokens: 1200,
    cache_read_tokens: 80000,
    cache_creation_tokens: 5000,
    exceeds_200k: false,
  },
  cost: { total_cost_usd: 1.25, total_duration_ms: 9000, lines_added: 10, lines_removed: 2 },
  rate_limits: {
    five_hour: { used_percentage: 21.4, resets_at: 1_700_001_000 },
    seven_day: { used_percentage: 58.1, resets_at: 1_700_500_000 },
  },
  ...over,
})

const write = (sessionId: string, doc: unknown): void => {
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, `${sessionId}.json`), JSON.stringify(doc))
}

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-budget-'))
  process.env.AGENT_CHAT_STATUS_CACHE = cacheDir
})

afterEach(() => {
  delete process.env.AGENT_CHAT_STATUS_CACHE
  fs.rmSync(cacheDir, { recursive: true, force: true })
})

describe('parsing a status-line budget document', () => {
  it('reads the fields the status line actually carries', () => {
    const budget = parseBudget(JSON.stringify(payload()))
    expect(budget?.session_id).toBe('abc-123')
    expect(budget?.context.used_pct).toBe(43.2)
    expect(budget?.context.window_size).toBe(200000)
    expect(budget?.cost.total_cost_usd).toBe(1.25)
    expect(budget?.rate_limits.five_hour).toEqual({ used_pct: 21.4, resets_at: 1_700_001_000 })
  })

  it('keeps a rate-limit window it has never heard of, rather than dropping it', () => {
    const doc = payload({ rate_limits: { spend_limit: { used_percentage: 4 }, someday: { used_pct: 9 } } })
    const budget = parseBudget(JSON.stringify(doc))
    expect(budget?.rate_limits.spend_limit).toEqual({ used_pct: 4 })
    expect(budget?.rate_limits.someday).toEqual({ used_pct: 9 })
  })

  it('degrades a field the writer stopped sending to absent, not to zero', () => {
    const doc = payload({ context: { exceeds_200k: false }, cost: {} })
    const budget = parseBudget(JSON.stringify(doc))
    expect(budget).not.toBeNull()
    expect(budget?.context.used_pct).toBeUndefined()
    expect(budget?.cost.total_cost_usd).toBeUndefined()
  })

  it('rejects a document with no session id or no timestamp', () => {
    expect(parseBudget(JSON.stringify(payload({ session_id: undefined })))).toBeNull()
    expect(parseBudget(JSON.stringify(payload({ written_at: 'soon' })))).toBeNull()
  })

  it('rejects bytes that are not JSON at all', () => {
    expect(parseBudget('')).toBeNull()
    expect(parseBudget('half a fi')).toBeNull()
    expect(parseBudget('[1,2,3]')).toBeNull()
  })
})

describe('matching a reading to a session', () => {
  it('finds the file named for the session id', () => {
    write('abc-123', payload())
    const read = readBudget('abc-123', 1_700_000_004_000)
    expect(read.found).toBe(true)
    if (!read.found) return
    expect(read.budget.session_id).toBe('abc-123')
    expect(read.age_seconds).toBe(4)
    expect(read.stale).toBe(false)
  })

  it('reports NOT_FOUND for a session nothing has written', () => {
    write('abc-123', payload())
    const read = readBudget('def-456')
    expect(read.found).toBe(false)
    if (read.found) return
    expect(read.reason).toBe('no_file')
    expect(budgetMiss('def-456', read)).toContain('NOT_FOUND')
  })

  it('reports a corrupt file as malformed rather than as no reading', () => {
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(path.join(cacheDir, 'abc-123.json'), '{"session_id":')
    const read = readBudget('abc-123')
    expect(read.found).toBe(false)
    if (read.found) return
    expect(read.reason).toBe('malformed')
  })

  it('marks a reading stale once the status line has stopped redrawing', () => {
    write('abc-123', payload())
    const later = (1_700_000_000 + STALE_AFTER_SECONDS + 1) * 1000
    const read = readBudget('abc-123', later)
    expect(read.found).toBe(true)
    if (!read.found) return
    expect(read.stale).toBe(true)
    expect(formatBudget('planner', read)).toContain('STALE')
  })

  it('refuses a session id that would escape the cache directory', () => {
    expect(() => budgetPath('../../etc/passwd')).toThrow()
    const read = readBudget('../../etc/passwd')
    expect(read.found).toBe(false)
    if (read.found) return
    expect(read.reason).toBe('malformed')
  })

  it('honours the cache override so nothing reads the real ~/.claude', () => {
    expect(budgetDir()).toBe(cacheDir)
    expect(budgetPath('abc-123')).toBe(path.join(cacheDir, 'abc-123.json'))
  })
})

describe('rendering a reading for a caller', () => {
  it('leads with the context fill, the window size and the account windows', () => {
    write('abc-123', payload())
    const read = readBudget('abc-123', 1_700_000_001_000)
    expect(read.found).toBe(true)
    if (!read.found) return
    const out = formatBudget('You', read)
    expect(out).toContain('43.2% of 200k context')
    expect(out).toContain('85k cached')
    expect(out).toContain('five_hour 21.4%')
    expect(out).toContain('seven_day 58.1%')
    // The machine-readable half, so a planner does not have to parse the prose.
    expect(JSON.parse(out.slice(out.indexOf('json: ') + 6)).stale).toBe(false)
  })

  it('says so plainly when the payload carried no rate-limit windows', () => {
    write('abc-123', payload({ rate_limits: {} }))
    const read = readBudget('abc-123')
    expect(read.found).toBe(true)
    if (!read.found) return
    expect(formatBudget('You', read)).toContain('no account rate-limit windows')
  })
})

/**
 * The writer is a shell script and the reader is TypeScript, so the field names
 * agree only by hand. This drives the real script with a real status-line
 * payload, which is the one way that agreement gets checked.
 */
describe('the status-line writer and this reader agree on a shape', () => {
  const script = path.join(import.meta.dirname, '..', '..', 'scripts', 'session-budget-write.sh')

  const statusLinePayload = {
    session_id: 'e2e-session',
    model: { id: 'claude-opus-5', display_name: 'Opus 5' },
    workspace: { current_dir: '/tmp/work', project_dir: '/tmp/work' },
    cost: {
      total_cost_usd: 2.5,
      total_duration_ms: 120000,
      total_api_duration_ms: 40000,
      total_lines_added: 31,
      total_lines_removed: 7,
    },
    context_window: {
      total_input_tokens: 86000,
      total_output_tokens: 1200,
      context_window_size: 200000,
      current_usage: { cache_read_input_tokens: 80000, cache_creation_input_tokens: 5000 },
      used_percentage: 43.6,
      remaining_percentage: 56.4,
    },
    exceeds_200k_tokens: false,
    rate_limits: {
      five_hour: { used_percentage: 21.4, resets_at: 1_700_001_000 },
      seven_day: { used_percentage: 58.1, resets_at: 1_700_500_000 },
    },
  }

  const runWriter = (payload: unknown): void => {
    execFileSync(script, {
      input: JSON.stringify(payload),
      env: { ...process.env, AGENT_CHAT_STATUS_CACHE: cacheDir },
    })
  }

  it('writes a document readBudget can read every field of', () => {
    runWriter(statusLinePayload)
    const read = readBudget('e2e-session')
    expect(read.found).toBe(true)
    if (!read.found) return
    expect(read.budget.model_id).toBe('claude-opus-5')
    expect(read.budget.cwd).toBe('/tmp/work')
    expect(read.budget.context.used_pct).toBe(43.6)
    expect(read.budget.context.cache_read_tokens).toBe(80000)
    expect(read.budget.cost.lines_added).toBe(31)
    expect(read.budget.rate_limits.seven_day?.used_pct).toBe(58.1)
    expect(read.stale).toBe(false)
  })

  it('writes nothing at all rather than a partial file when the payload has no session id', () => {
    runWriter({ ...statusLinePayload, session_id: undefined })
    expect(fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'))).toEqual([])
  })

  it('refuses a session id that would put the file outside the cache directory', () => {
    runWriter({ ...statusLinePayload, session_id: '../escaped' })
    expect(fs.existsSync(path.join(cacheDir, '..', 'escaped.json'))).toBe(false)
  })
})

describe('the CLI surface', () => {
  it('exposes budget under the agent noun, with the name optional', () => {
    const agent = buildProgram().commands.find(c => c.name() === 'agent') as Command
    const budget = agent.commands.find(c => c.name() === 'budget') as Command
    expect(budget).toBeDefined()
    expect(budget.usage()).toContain('[name]')
  })
})
