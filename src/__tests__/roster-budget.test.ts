import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STALE_AFTER_SECONDS } from '../agents/budget.js'
import { ToolHandler } from '../server/tools.js'
import type { BrokerClient } from '../client/broker-client.js'
import type { AgentIdentity, ServerMessage, SessionInfo } from '../protocol.js'

/**
 * CC-94 — model, cost and context fill on roster rows. The reader under test
 * (`readBudget`) is already covered by budget.test.ts; this file covers the
 * wiring into `agent_list` and `chat_list`: a fresh row, a stale row, and a row
 * with no reading at all must all render, on one roster call.
 */

let cacheDir: string

const NOW = 1_700_000_000

const payload = (sessionId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  session_id: sessionId,
  model_id: 'claude-opus-5',
  written_at: NOW,
  context: { used_pct: 43.2, window_size: 200000, exceeds_200k: false },
  cost: { total_cost_usd: 1.25 },
  rate_limits: { five_hour: { used_percentage: 21.4 }, seven_day: { used_percentage: 58.1 } },
  ...over,
})

const write = (sessionId: string, doc: unknown): void => {
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, `${sessionId}.json`), JSON.stringify(doc))
}

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-roster-budget-'))
  process.env.AGENT_CHAT_STATUS_CACHE = cacheDir
})

afterEach(() => {
  delete process.env.AGENT_CHAT_STATUS_CACHE
  fs.rmSync(cacheDir, { recursive: true, force: true })
})

const stubBroker = (reply: ServerMessage) => ({ request: async () => reply }) as unknown as BrokerClient
const textOf = (result: { content: { text: string }[] }): string => result.content[0]!.text

describe('agent_list carries budget per row', () => {
  const agent = (over: Partial<AgentIdentity>): AgentIdentity => ({
    agentId: 'a1',
    name: 'scout',
    profile: 'reviewer',
    state: 'live',
    origin: 'spawned',
    spawnedBy: 'human',
    spawnedAt: 0,
    brief: '',
    cwd: '/repo',
    isolation: 'none',
    surface: 'headless',
    sessionId: 'sess-fresh',
    lastEventAt: 0,
    generation: 1,
    ...over,
  })

  it('renders a fresh reading, a stale reading, and a row with none — none of them fail the call', async () => {
    write('sess-fresh', payload('sess-fresh'))
    write('sess-stale', payload('sess-stale'))

    const handler = new ToolHandler(
      stubBroker({
        t: 'agents_result',
        agents: [
          agent({ name: 'fresh-scout', sessionId: 'sess-fresh' }),
          agent({ name: 'stale-scout', sessionId: 'sess-stale' }),
          agent({ name: 'silent-scout', sessionId: 'sess-never-written' }),
        ],
      }),
    )

    const now = (NOW + STALE_AFTER_SECONDS + 1) * 1000
    const realNow = Date.now
    Date.now = () => now
    let out: string
    try {
      out = textOf(await handler.handle('agent_list', {}))
    } finally {
      Date.now = realNow
    }

    expect(out).toContain('fresh-scout')
    expect(out).toContain('stale-scout')
    expect(out).toContain('silent-scout')
    expect(out).toMatch(/stale-scout.*\[stale \d+s\]/)
    expect(out).toContain('no budget reading')
    expect(out).toContain('claude-opus-5 · $1.3 · 43.2%/200k')
  })

  it('prints the account rate limit once in the header, not once per row', async () => {
    write('sess-fresh', payload('sess-fresh'))
    const handler = new ToolHandler(
      stubBroker({
        t: 'agents_result',
        agents: [agent({ name: 'fresh-scout', sessionId: 'sess-fresh' })],
      }),
    )

    const out = textOf(await handler.handle('agent_list', {}))
    const occurrences = out.match(/five_hour/g) ?? []
    expect(occurrences).toHaveLength(1)
    expect(out).toContain("Account usage (from fresh-scout's reading")
  })

  it('never fails the roster call when nothing has written a reading', async () => {
    const handler = new ToolHandler(
      stubBroker({ t: 'agents_result', agents: [agent({ name: 'silent-scout', sessionId: 'sess-ghost' })] }),
    )
    const out = textOf(await handler.handle('agent_list', {}))
    expect(out).toContain('silent-scout')
    expect(out).toContain('no budget reading')
    expect(out).toContain('Account usage: no budget reading available')
  })
})

describe('chat_list carries budget per row', () => {
  const session = (over: Partial<SessionInfo>): SessionInfo => ({
    name: 'cc-relay',
    workingOn: 'narrowing broadcast fanout',
    cwd: '/repo',
    status: 'working',
    dnd: false,
    idleMs: 12_000,
    registeredAt: 0,
    ...over,
  })

  it('renders a row with a reading and a row with none, keyed off the observed session id', async () => {
    write('sess-fresh', payload('sess-fresh'))
    const handler = new ToolHandler(
      stubBroker({
        t: 'list_result',
        sessions: [
          session({ name: 'has-reading', observed: { claudeSessionId: 'sess-fresh' } }),
          // A raw socket client never sent CLAUDE_CODE_SESSION_ID, so there is no
          // id to look a reading up by at all.
          session({ name: 'raw-client' }),
        ],
      }),
    )

    const out = textOf(await handler.handle('chat_list', {}))
    expect(out).toContain('claude-opus-5 · $1.3 · 43.2%/200k')
    expect(out).toContain('- raw-client')
    expect(out.split('\n').find(line => line.startsWith('- raw-client'))).toContain('no budget reading')
  })
})
