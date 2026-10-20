import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexHostDir } from '../paths.js'
import { chatInbox } from '../server/commands/chat-inbox.js'
import {
  codexInboxSpoolDir,
  resolveInboxSpool,
  retireCodexHostOnExit,
  spoolRecord,
  type SpoolRecord,
} from '../server/inbox-spool.js'

/**
 * CC-1509: a Codex host renders no channel push, so its MCP server spools every
 * push under the Codex pid. Each test names the mutation it catches. Every pid,
 * name and id is synthetic.
 */

const CODEX_PID = 70_001
const PRINT_ARGV = 'claude -p --output-format stream-json --channels plugin:agent-chat@local'
const INTERACTIVE_ARGV = 'claude --channels plugin:agent-chat@local'

const record = (msgId: string): SpoolRecord => ({
  kind: 'message',
  msgId,
  meta: { from: 'scout', msg_id: msgId },
  text: `note ${msgId}`,
})

const spooled = (dir: string): string[] => fs.readdirSync(dir).filter(name => name.endsWith('.json'))

describe('resolveInboxSpool for a Codex host', () => {
  it('spools under the Codex pid with no agentId, no opt-in and an interactive argv', () => {
    // Catches: leaving the Codex branch behind the agentId or print gates.
    const dir = resolveInboxSpool({
      agentId: undefined,
      env: {},
      hostPid: CODEX_PID,
      harness: 'codex',
      read: () => INTERACTIVE_ARGV,
    })

    expect(dir).toBe(path.join(codexHostDir(CODEX_PID), 'inbox'))
    expect(dir?.endsWith(path.join('codex-hosts', String(CODEX_PID), 'inbox'))).toBe(true)
  })

  it('does not spool for an interactive Claude Code host', () => {
    // Catches: spooling for every harness instead of Codex only.
    const dir = resolveInboxSpool({
      agentId: undefined,
      env: {},
      hostPid: CODEX_PID,
      harness: 'claude-code',
      read: () => INTERACTIVE_ARGV,
    })

    expect(dir).toBeUndefined()
  })

  it('keeps the print-mode path on the agent dir for a Claude Code host', () => {
    // Catches: routing a spawned print-mode agent to the Codex dir.
    const dir = resolveInboxSpool({
      agentId: 'agent-x',
      env: { AGENT_CHAT_INBOX_SPOOL: '1' },
      hostPid: CODEX_PID,
      harness: 'claude-code',
      read: () => PRINT_ARGV,
    })

    expect(dir?.endsWith(path.join('agents', 'agent-x', 'inbox'))).toBe(true)
  })

  it('does not spool for a Codex host whose pid is unknown', () => {
    // Catches: a shared spool keyed by an undefined pid.
    expect(
      resolveInboxSpool({ agentId: undefined, env: {}, hostPid: undefined, harness: 'codex' }),
    ).toBeUndefined()
  })
})

describe('the Codex spool on disk', () => {
  it('creates the spool dir with mode 0700', () => {
    // Arrange
    const dir = codexInboxSpoolDir(CODEX_PID)

    // Act
    spoolRecord(dir, record('msg-1'))

    // Assert
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(spooled(dir)).toHaveLength(1)
    fs.rmSync(codexHostDir(CODEX_PID), { recursive: true, force: true })
  })

  it('chat_inbox clears the records it returned and leaves the rest', async () => {
    // Arrange
    const dir = codexInboxSpoolDir(CODEX_PID + 1)
    spoolRecord(dir, record('msg-1'))
    spoolRecord(dir, record('msg-2'))
    const broker = {
      request: async () => ({
        t: 'inbox_result',
        messages: [{ msgId: 'msg-1', from: 'scout', text: 'note' }],
      }),
    }

    // Act
    await chatInbox.run(chatInbox.args.parse({}) as never, { broker, inboxSpool: dir } as never)

    // Assert
    expect(spooled(dir)).toHaveLength(1)
    expect(spooled(dir)[0]).toMatch(/-msg-2\.json$/)
    fs.rmSync(codexHostDir(CODEX_PID + 1), { recursive: true, force: true })
  })

  it('removes the Codex host dir when the server exits', () => {
    // Arrange
    const dir = codexInboxSpoolDir(CODEX_PID + 2)
    spoolRecord(dir, record('msg-1'))
    const proc = new EventEmitter()
    retireCodexHostOnExit(CODEX_PID + 2, proc)

    // Act
    proc.emit('exit', 0)

    // Assert
    expect(fs.existsSync(codexHostDir(CODEX_PID + 2))).toBe(false)
  })
})
