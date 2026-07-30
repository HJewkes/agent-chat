import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { projectSlug } from '../agents/transcript.js'
import { readTurns } from '../agents/turns.js'
import { ToolHandler } from '../server/tools.js'
import type { BrokerClient } from '../client/broker-client.js'
import type { AgentIdentity, ServerMessage } from '../protocol.js'

/**
 * A fake `~/.claude`, for the same reason transcript.test.ts uses one: nothing
 * here may read the developer's real transcripts.
 *
 * Every row below is shaped after real rows from a live transcript on this
 * machine (`~/.claude/projects/-Users-hjewkes-projects-agent-chat`), including
 * the ones we ignore — `mode`, `file-history-snapshot` and `attachment` are all
 * types Claude Code really writes, and a reader that rendered them would show a
 * caller rows that are not turns.
 */
let configDir: string

const CWD = '/Users/hjewkes/projects/agent-chat'
const SESSION = '4dea7315-2125-4326-b31b-4f2d0ee6fbcc'

const write = (rows: unknown[], trailing = ''): void => {
  const dir = path.join(configDir, 'projects', projectSlug(CWD))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${SESSION}.jsonl`),
    `${rows.map(r => JSON.stringify(r)).join('\n')}\n${trailing}`,
  )
}

const say = (type: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type,
  timestamp: '2026-07-30T11:04:22.913Z',
  sessionId: SESSION,
  cwd: CWD,
  gitBranch: 'main',
  message: { role: type, content },
  ...extra,
})

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-turns-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR
  fs.rmSync(configDir, { recursive: true, force: true })
})

describe('reading recent turns', () => {
  it('returns the newest turns last, capped at the limit', () => {
    write([say('user', 'first'), say('assistant', [{ type: 'text', text: 'second' }]), say('user', 'third')])
    const read = readTurns(CWD, SESSION, 2)
    expect(read.transcript.exists).toBe(true)
    expect(read.turns.map(t => t.text)).toEqual(['second', 'third'])
    expect(read.turns.map(t => t.role)).toEqual(['assistant', 'user'])
  })

  it('reports the branch from the newest row that carried one', () => {
    write([say('user', 'a'), say('assistant', 'b', { gitBranch: 'feat/cc19-transcript-observation' })])
    expect(readTurns(CWD, SESSION, 10).branch).toBe('feat/cc19-transcript-observation')
  })

  it('skips rows that are not turns at all', () => {
    write([
      { type: 'mode', mode: 'normal', sessionId: SESSION },
      { type: 'file-history-snapshot', messageId: 'x', snapshot: {} },
      say('user', 'the only turn'),
    ])
    expect(readTurns(CWD, SESSION, 10).turns).toHaveLength(1)
  })

  it('survives a partially flushed final line, which is normal on a live tail', () => {
    write([say('user', 'complete')], '{"type":"assistant","mess')
    expect(readTurns(CWD, SESSION, 10).turns.map(t => t.text)).toEqual(['complete'])
  })

  it('marks a subagent turn so it is not read as the session speaking', () => {
    write([say('assistant', 'mine'), say('assistant', 'a subagent', { isSidechain: true })])
    expect(readTurns(CWD, SESSION, 10).turns.map(t => t.sidechain)).toEqual([false, true])
  })
})

describe('rendering content blocks', () => {
  it('names a tool call and summarises its input rather than dumping it', () => {
    write([say('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }])])
    expect(readTurns(CWD, SESSION, 1).turns[0]?.text).toBe('[tool Bash] {"command":"ls -la"}')
  })

  it('flags an errored tool result, which is how a denial shows up', () => {
    write([say('user', [{ type: 'tool_result', is_error: true, content: 'permission denied' }])])
    expect(readTurns(CWD, SESSION, 1).turns[0]?.text).toBe('[tool result, error] permission denied')
  })

  /** Permitted to read, deliberately not reproduced — see the note in turns.ts. */
  it('reports a thinking block by size instead of quoting it', () => {
    write([say('assistant', [{ type: 'thinking', thinking: 'x'.repeat(4000) }])])
    expect(readTurns(CWD, SESSION, 1).turns[0]?.text).toBe('[thinking, 4000 chars]')
  })

  it('names an unrecognised block by its type rather than dropping the turn', () => {
    write([say('assistant', [{ type: 'some_future_block' }, { type: 'text', text: 'and text' }])])
    expect(readTurns(CWD, SESSION, 1).turns[0]?.text).toBe('[some_future_block]\nand text')
  })

  it('truncates one enormous turn instead of handing it to the caller whole', () => {
    write([say('assistant', 'y'.repeat(5000))])
    const rendered = readTurns(CWD, SESSION, 1).turns[0]?.text ?? ''
    expect(rendered.length).toBeLessThan(800)
    expect(rendered).toContain('more chars)')
  })

  it('drops a row whose content is missing or an unexpected shape', () => {
    write([
      { type: 'assistant', message: { role: 'assistant' } },
      { type: 'user', message: 7 },
    ])
    expect(readTurns(CWD, SESSION, 10).turns).toEqual([])
  })
})

describe('when there is nothing to read', () => {
  it('treats an absent transcript as a miss rather than an error', () => {
    const read = readTurns(CWD, SESSION, 10)
    expect(read.transcript.exists).toBe(false)
    expect(read.turns).toEqual([])
  })
})

describe('the chat_transcript tool', () => {
  const stubBroker = (reply: ServerMessage) => ({ request: async () => reply }) as unknown as BrokerClient

  const textOf = (result: { content: { text: string }[] }): string => result.content[0]!.text

  const agent = (over: Partial<AgentIdentity>): AgentIdentity => ({
    agentId: 'a1',
    name: 'scout',
    profile: 'reviewer',
    state: 'live',
    origin: 'adopted',
    spawnedBy: 'human',
    spawnedAt: 0,
    brief: '',
    cwd: CWD,
    isolation: 'none',
    surface: 'headless',
    sessionId: SESSION,
    lastEventAt: 0,
    generation: 1,
    ...over,
  })

  const noAgents = () => stubBroker({ t: 'agents_result', agents: [] })

  afterEach(() => {
    delete process.env.CLAUDE_CODE_SESSION_ID
  })

  /**
   * The self path asks the broker nothing at all: the cwd is this process's and
   * the session id is in this process's environment.
   */
  it('reads its own transcript with no name, no broker call and no registration', async () => {
    write([say('assistant', 'what I was doing')])
    process.env.CLAUDE_CODE_SESSION_ID = SESSION
    const handler = new ToolHandler({
      request: async () => {
        throw new Error('the self path must not need the broker')
      },
    } as unknown as BrokerClient)

    const spy = { cwd: process.cwd }
    process.cwd = () => CWD
    try {
      expect(textOf(await handler.handle('chat_transcript', {}))).toContain('what I was doing')
    } finally {
      process.cwd = spy.cwd
    }
  })

  it('says plainly when this process has no session id to derive a path from', async () => {
    const handler = new ToolHandler(noAgents())
    expect(textOf(await handler.handle('chat_transcript', {}))).toContain('CLAUDE_CODE_SESSION_ID')
  })

  /**
   * CC-19's actual subject. Nothing is asked of the observed session and nothing
   * new is published: the registry already holds its cwd and session id because
   * `hostIdentity()` sends both on every register.
   */
  it("reads another session's transcript from what the registry already knows", async () => {
    write([say('assistant', 'a peer at work')])
    const handler = new ToolHandler(stubBroker({ t: 'agents_result', agents: [agent({ name: 'peer' })] }))

    const rendered = textOf(await handler.handle('chat_transcript', { name: 'peer', limit: 5 }))
    expect(rendered).toContain('a peer at work')
    expect(rendered).toContain('peer:')
  })

  it('reports a miss for a name with no durable identity rather than failing', async () => {
    const handler = new ToolHandler(noAgents())
    expect(textOf(await handler.handle('chat_transcript', { name: 'ghost' }))).toContain('no transcript')
  })

  it('answers for a session whose transcript has not been written yet', async () => {
    const handler = new ToolHandler(stubBroker({ t: 'agents_result', agents: [agent({ name: 'peer' })] }))
    const rendered = textOf(await handler.handle('chat_transcript', { name: 'peer' }))
    expect(rendered).toContain('No transcript on disk')
    expect(rendered).toContain('miss, not an error')
  })
})
