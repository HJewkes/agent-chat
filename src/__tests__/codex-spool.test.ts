import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexHostDir, codexPendingDir } from '../paths.js'
import { chatInbox } from '../server/commands/chat-inbox.js'
import {
  adoptCodexHost,
  CODEX_KEEP_ENV,
  codexInboxSpoolDir,
  codexKeepName,
  parkCodexHost,
  readCodexHostStamp,
  resolveInboxSpool,
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

const spooled = (dir: string): string[] =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.json')) : []

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

  it('removes the Codex host dir of an unnamed host when the server exits', () => {
    // Catches: an unnamed host, which no later session can claim, leaving its records behind.
    const dir = codexInboxSpoolDir(CODEX_PID + 2)
    const proc = new EventEmitter()
    adoptCodexHost(CODEX_PID + 2, undefined, proc)
    spoolRecord(dir, record('msg-1'))

    proc.emit('exit', 0)

    expect(fs.existsSync(codexHostDir(CODEX_PID + 2))).toBe(false)
  })
})

describe('parking a named Codex host (CC-1683)', () => {
  const HOST = CODEX_PID + 10
  const NAME = 'cc1683-spool'
  const DEAD = 70_999
  const hostInbox = codexInboxSpoolDir(HOST)
  const pending = codexPendingDir(NAME)

  afterEach(() => {
    fs.rmSync(codexHostDir(HOST), { recursive: true, force: true })
    fs.rmSync(pending, { recursive: true, force: true })
  })

  const claim = (holder: number, msgId: string): void => {
    spoolRecord(hostInbox, record(msgId))
    const name = spooled(hostInbox).find(file => file.endsWith(`-${msgId}.json`)) ?? ''
    fs.mkdirSync(path.join(hostInbox, '.claimed'), { recursive: true })
    fs.renameSync(path.join(hostInbox, name), path.join(hostInbox, '.claimed', `${holder}-${name}`))
  }

  it('moves waiting records and dead claims to the name, and removes the host dir', () => {
    // Catches: the original bug, the exit handler deleting what the supervisor returned.
    const proc = new EventEmitter()
    adoptCodexHost(HOST, NAME, proc, { isAlive: () => false })
    spoolRecord(hostInbox, record('waiting'))
    claim(DEAD, 'claimed')

    proc.emit('exit', 137)

    expect(
      spooled(pending)
        .map(name => name.replace(/^\d+-\d+-/, ''))
        .sort(),
    ).toEqual(['claimed.json', 'waiting.json'])
    expect(fs.existsSync(codexHostDir(HOST))).toBe(false)
  })

  it('leaves a claim whose holder lives, and the dir it sits in, for that holder', () => {
    // Catches: the MCP server taking a record the supervisor may yet deliver, which sends it twice.
    claim(DEAD, 'in-flight')

    parkCodexHost(HOST, NAME, { isAlive: pid => pid === DEAD })

    expect(fs.existsSync(pending)).toBe(false)
    expect(fs.readdirSync(path.join(hostInbox, '.claimed'))).toHaveLength(1)
  })

  it('keeps the dir when a record could not move', () => {
    // Catches: removing the host dir after a failed rename, which loses the record.
    spoolRecord(hostInbox, record('stuck'))
    const refusing = {
      ...fs,
      renameSync: () => {
        throw Object.assign(new Error('refused'), { code: 'EACCES' })
      },
    } as typeof fs

    parkCodexHost(HOST, NAME, { fs: refusing })

    expect(spooled(hostInbox)).toHaveLength(1)
  })

  it("a stranger reusing the pid parks a dead owner's dir under that owner, not itself", () => {
    // Catches: a reused pid inheriting records, when both the owner's exit handler and supervisor died.
    const dead = new EventEmitter()
    adoptCodexHost(HOST, NAME, dead, { pid: DEAD })
    spoolRecord(hostInbox, record('stale'))

    adoptCodexHost(HOST, 'cc1683-stranger', new EventEmitter(), { isAlive: () => false })

    expect(spooled(pending)).toHaveLength(1)
    expect(spooled(hostInbox)).toEqual([])
    expect(readCodexHostStamp(HOST)).toEqual({ mcpPid: process.pid, keepAs: 'cc1683-stranger' })
    expect(fs.existsSync(codexPendingDir('cc1683-stranger'))).toBe(false)
  })

  it("an unnamed stranger drops an unnamed dead owner's records instead of reading them", () => {
    // Catches: the unnamed path, which has no pending dir, leaving records for the new owner.
    adoptCodexHost(HOST, undefined, new EventEmitter(), { pid: DEAD })
    spoolRecord(hostInbox, record('stale'))

    adoptCodexHost(HOST, undefined, new EventEmitter(), { isAlive: () => false })

    expect(spooled(hostInbox)).toEqual([])
  })

  it('leaves the dir of a live sibling server alone', () => {
    // Catches: a second server on a multi-thread host wiping the first one's spool.
    adoptCodexHost(HOST, NAME, new EventEmitter(), { pid: DEAD })
    spoolRecord(hostInbox, record('live'))

    adoptCodexHost(HOST, undefined, new EventEmitter(), { isAlive: () => true })

    expect(spooled(hostInbox)).toHaveLength(1)
    expect(readCodexHostStamp(HOST)?.mcpPid).toBe(DEAD)
  })

  it('takes the keep name only when it is a valid agent name', () => {
    // Catches: an env value walking out of the pending root.
    expect(codexKeepName({ [CODEX_KEEP_ENV]: 'scout' })).toBe('scout')
    expect(codexKeepName({ [CODEX_KEEP_ENV]: '../escape' })).toBeUndefined()
    expect(codexKeepName({})).toBeUndefined()
  })
})
