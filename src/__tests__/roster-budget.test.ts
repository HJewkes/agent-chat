import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accountUsageLine, budgetSegment, readBudget, STALE_AFTER_SECONDS } from '../agents/budget.js'
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

  /**
   * A retired or exited identity has no process left to have written a
   * reading, so its absence is the default, not information — unlike a LIVE
   * row with no reading, which still prints the segment above. On a machine
   * with a long agent history nearly every row is in one of these states, so
   * reading and rendering for them is the exact cost CC-94 must not add.
   */
  it('skips both the read and the segment for a non-live agent', async () => {
    write('sess-retired', payload('sess-retired'))
    const readFileSpy = vi.spyOn(fs, 'readFileSync')

    const handler = new ToolHandler(
      stubBroker({
        t: 'agents_result',
        agents: [
          agent({ name: 'retired-scout', state: 'retired', sessionId: 'sess-retired' }),
          agent({ name: 'exited-scout', state: 'exited', sessionId: 'sess-retired' }),
          agent({ name: 'fresh-scout', state: 'live', sessionId: 'sess-retired' }),
        ],
      }),
    )
    const out = textOf(await handler.handle('agent_list', {}))
    // Read the call history before restoring: mockRestore() also clears it.
    const readsOfThatSession = readFileSpy.mock.calls.filter(c => String(c[0]).includes('sess-retired'))
    readFileSpy.mockRestore()

    const retiredLine = out.split('\n').find(line => line.startsWith('- retired-scout'))
    const exitedLine = out.split('\n').find(line => line.startsWith('- exited-scout'))
    expect(retiredLine).not.toContain('budget')
    expect(exitedLine).not.toContain('budget')
    // The live row shares the same session id, proving the file really was
    // readable — the other two rows' absence is a filtering choice, not luck.
    expect(out).toContain('claude-opus-5 · $1.3 · 43.2%/200k')
    expect(readsOfThatSession).toHaveLength(1)
  })
})

describe('agent_list at the scale a long-lived machine actually reaches', () => {
  // Row shape and lengths lifted from a real agent_list call against the shared
  // broker on this machine, taken at review time: 216 agents, state distribution
  // 34 live / 93 detached / 89 exited / 0 retired / 0 spawning, 61,183 characters
  // total before this fix — already over the tool-result limit on its own.
  const REALISTIC_CWD = '/Users/hjewkes/projects/voltras-mcp/.worktrees/vw387-milestone-fields'
  const REALISTIC_SESSION = 'b17eb21b-75f0-49c1-a118-8bf992bbd902'

  const agent = (over: Partial<AgentIdentity>): AgentIdentity => ({
    agentId: 'a1',
    name: 'vw387-milestone-fields',
    profile: 'implementer-lite',
    state: 'exited',
    origin: 'spawned',
    spawnedBy: 'voltras-main',
    spawnedAt: 0,
    brief: '',
    cwd: REALISTIC_CWD,
    isolation: 'none',
    surface: 'iterm-pane',
    sessionId: REALISTIC_SESSION,
    lastEventAt: 0,
    generation: 1,
    ...over,
  })

  const NON_LIVE = 93 + 89 // detached + exited, from the real distribution above
  const LIVE = 34

  /**
   * Reading and rendering a segment on every one of the 182 non-live rows —
   * the naive version of this fix — would have made an already-over-limit call
   * worse. This pins that the text this fix adds scales with LIVE rows only.
   */
  it('adds text proportional to live rows, not to total rows', async () => {
    write(REALISTIC_SESSION, payload(REALISTIC_SESSION))
    const nonLive = Array.from({ length: NON_LIVE }, (_, i) =>
      agent({ name: `retired-${i}`, agentId: `r${i}`, state: i % 2 === 0 ? 'detached' : 'exited' }),
    )
    const live = Array.from({ length: LIVE }, (_, i) =>
      agent({
        name: `live-${i}`,
        agentId: `l${i}`,
        state: 'live',
        sessionId: i === 0 ? REALISTIC_SESSION : 'sess-none',
      }),
    )

    const handler = new ToolHandler(stubBroker({ t: 'agents_result', agents: [...nonLive, ...live] }))
    const out = textOf(await handler.handle('agent_list', {}))

    // One live row has a reading, the other 33 do not — every non-live row is
    // silent either way.
    expect(out.match(/no budget reading/g)).toHaveLength(LIVE - 1)
    expect(out).toContain('claude-opus-5 · $1.3 · 43.2%/200k')

    // Measured directly off what this fix actually appends (`, ` + the
    // segment, once per live row, plus the header line once total) rather than
    // reconstructing a parallel "before" render, which would drift from the
    // real formatting and give a false number.
    const foundSegment = `, ${budgetSegment(readBudget(REALISTIC_SESSION))}`
    const missingSegment = `, ${budgetSegment(readBudget('sess-none'))}`
    const header = `${accountUsageLine([{ name: 'x', read: readBudget(REALISTIC_SESSION) }])}\n`
    const addedChars = foundSegment.length + (LIVE - 1) * missingSegment.length + header.length
    // eslint-disable-next-line no-console -- measured figures for the PR report, not fixed assertions
    console.info(
      `[CC-94] ${NON_LIVE + LIVE}-row agent_list (${LIVE} live, ${NON_LIVE} non-live): ` +
        `${out.length} chars total, ${addedChars} chars added by this fix ` +
        `(${foundSegment.length} for the one found reading, ${missingSegment.length} each for ${LIVE - 1} missing, ` +
        `${header.length} for the header; 0 added per non-live row)`,
    )
    expect(addedChars).toBeLessThan(NON_LIVE * missingSegment.length)
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
