import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { accountUsageLine, readBudget, STALE_AFTER_SECONDS } from '../agents/budget.js'
import { USAGE_TAIL_BYTES } from '../agents/transcript-usage.js'
import { ToolHandler } from '../server/tools.js'
import type { BrokerClient } from '../client/broker-client.js'
import type { AgentIdentity, ServerMessage } from '../protocol.js'

/**
 * CC-179: a headless agent draws no status line, so its fill comes from the last
 * `message.usage` in its transcript. Everything lives under a temp config dir.
 */

const NOW_S = 1_700_000_000
const SESSION = 'headless-1'

let configDir: string
let cacheDir: string

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-cc179-'))
  cacheDir = path.join(configDir, 'status-cache', 'sessions')
})

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true })
})

const assistant = (atS: number, usage: Record<string, number>, model = 'claude-opus-5'): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(atS * 1000).toISOString(),
    message: { model, usage },
  })

const writeTranscript = (lines: string[]): void => {
  const dir = path.join(configDir, 'projects', '-repo')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), lines.join('\n') + '\n')
}

const writeStatusLine = (): void => {
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(
    path.join(cacheDir, `${SESSION}.json`),
    JSON.stringify({
      session_id: SESSION,
      model_id: 'claude-opus-5',
      written_at: NOW_S,
      context: { used_pct: 12, window_size: 200000, input_tokens: 24000, exceeds_200k: false },
      rate_limits: { seven_day: { used_percentage: 40 } },
    }),
  )
}

const agent: AgentIdentity = {
  agentId: 'a1',
  name: 'worker',
  profile: 'implementer',
  state: 'live',
  origin: 'spawned',
  spawnedBy: 'human',
  spawnedAt: 0,
  brief: '',
  cwd: '/repo',
  isolation: 'none',
  surface: 'headless',
  sessionId: SESSION,
  lastEventAt: 0,
  generation: 1,
}

async function callTool(tool: 'session_budget' | 'agent_list', nowS: number): Promise<string> {
  const reply: ServerMessage = { t: 'agents_result', agents: [{ ...agent, configDir }] }
  const handler = new ToolHandler({ request: async () => reply } as unknown as BrokerClient)
  const realNow = Date.now
  Date.now = () => nowS * 1000
  try {
    const result = await handler.handle(tool, tool === 'session_budget' ? { name: 'worker' } : {})
    return (result as { content: { text: string }[] }).content[0]!.text
  } finally {
    Date.now = realNow
  }
}

describe('a headless agent with no status line', () => {
  it('reports the fill from the last usage record in its transcript', async () => {
    writeTranscript([
      assistant(NOW_S - 100, {
        input_tokens: 1,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 0,
      }),
      assistant(NOW_S - 30, {
        input_tokens: 5,
        cache_read_input_tokens: 90_000,
        cache_creation_input_tokens: 4995,
      }),
      JSON.stringify({ type: 'user', timestamp: new Date(NOW_S * 1000).toISOString(), message: {} }),
    ])

    const out = await callTool('session_budget', NOW_S)

    expect(out).toContain(
      'worker: 95k tokens of context, window unknown (source: transcript, last usage record 30s old)',
    )
    expect(out).toContain('rate limits are not observable from a transcript')
    expect(out).toContain('"source":"transcript"')
  })

  it('marks the transcript reading stale under the same rule as a status-line reading', () => {
    writeTranscript([assistant(NOW_S, { input_tokens: 10 })])

    const read = readBudget(SESSION, (NOW_S + STALE_AFTER_SECONDS + 1) * 1000, configDir)

    expect(read).toMatchObject({ found: true, source: 'transcript', stale: true })
  })

  it('puts the transcript reading on the roster row but not in the account header', async () => {
    writeTranscript([assistant(NOW_S - 5, { input_tokens: 42_000 })])

    const out = await callTool('agent_list', NOW_S)

    expect(out).toContain('claude-opus-5 · 42k tokens of context, window unknown [transcript]')
    expect(out).toContain('Account usage: no budget reading available from any row.')
  })

  it('finds a usage record in a transcript far larger than the bounded tail', () => {
    const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1024) } })
    writeTranscript([
      ...Array(Math.ceil((USAGE_TAIL_BYTES * 2) / 1024)).fill(filler),
      assistant(NOW_S, { input_tokens: 7 }),
    ])

    expect(readBudget(SESSION, NOW_S * 1000, configDir)).toMatchObject({ found: true, source: 'transcript' })
  })
})

describe('when both sources exist', () => {
  it('prefers the status-line reading over the transcript', async () => {
    writeStatusLine()
    writeTranscript([assistant(NOW_S, { input_tokens: 150_000 })])

    const out = await callTool('session_budget', NOW_S)

    expect(out).toContain('worker: 12% of 200k context')
    expect(out).not.toContain('source: transcript')
    expect(
      accountUsageLine([{ name: 'worker', read: readBudget(SESSION, NOW_S * 1000, configDir) }]),
    ).toContain('seven_day 40%')
  })
})

describe('a transcript that yields no reading', () => {
  it('reports NOT_FOUND with the reason when the transcript is malformed', async () => {
    writeTranscript(['{not json', '{"type":"assistant","message":{"usage":"lots"}}', '\u0000\u0001'])

    const out = await callTool('session_budget', NOW_S)

    expect(out).toMatch(/^NOT_FOUND: no budget reading for worker/)
    expect(out).toContain('Transcript fallback: no assistant usage record in the transcript tail')
  })

  it('reports NOT_FOUND rather than throwing when the transcript path is a directory', async () => {
    fs.mkdirSync(path.join(configDir, 'projects', '-repo', `${SESSION}.jsonl`), { recursive: true })

    const out = await callTool('session_budget', NOW_S)

    expect(out).toMatch(/^NOT_FOUND: .*Transcript fallback: unreadable transcript/)
  })

  it('reports NOT_FOUND naming the missing transcript when none was written', async () => {
    const out = await callTool('session_budget', NOW_S)

    expect(out).toContain('Transcript fallback: no transcript written')
  })
})
