import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { EventLog, APPROVAL_TTL_MS } from '../broker/event-log.js'

/**
 * Permission relay, observe-only. Drives the real notification Claude Code
 * sends when a tool-approval dialog opens, and asserts we surface it without
 * ever answering it.
 */

const execFileAsync = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-appr-'))

const ChannelNotification = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string()).optional() }),
})

let transport: StdioClientTransport
let client: Client
const inbox: unknown[] = []

const cli = (args: string[]) =>
  execFileAsync(process.execPath, [CLI, ...args], { env: { ...process.env, AGENT_CHAT_HOME: TEST_HOME } })

const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
  const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] }
  return result.content[0]?.text ?? ''
}

/** Impersonates Claude Code opening a permission dialog in this session. */
const openDialog = (params: Record<string, string>) =>
  client.notification({ method: 'notifications/claude/channel/permission_request', params })

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 250))

beforeAll(async () => {
  expect(fs.existsSync(CLI), 'run `npm run build` first').toBe(true)
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    env: { ...process.env, AGENT_CHAT_HOME: TEST_HOME },
  })
  client = new Client({ name: 'test-worker', version: '0.0.1' }, { capabilities: {} })
  client.setNotificationHandler(ChannelNotification, n => void inbox.push(n.params))
  await client.connect(transport)
  await call('chat_register', { name: 'worker', working_on: 'a migration' })
}, 30000)

afterAll(async () => {
  await transport.close().catch(() => undefined)
  fs.rmSync(TEST_HOME, { recursive: true, force: true })
})

describe('capability', () => {
  it('declares permission relay so Claude Code forwards prompts', () => {
    expect(client.getServerCapabilities()?.experimental).toHaveProperty('claude/channel/permission')
  })
})

describe('observing a permission prompt', () => {
  it('surfaces the pending prompt in the human queue', async () => {
    await openDialog({
      request_id: 'qxrtm',
      tool_name: 'Bash',
      description: 'Run shell command',
      input_preview: 'rm -rf build/',
    })
    await settle()

    const { stdout } = await cli(['inbox'])
    expect(stdout).toContain('APPR')
    expect(stdout).toContain('Bash: Run shell command')
    // The description is frequently useless, so the preview must be shown.
    expect(stdout).toContain('rm -rf build/')
    expect(stdout).toContain('worker blocked on a permission prompt')
  })

  it('never sends a verdict back', async () => {
    // A verdict would arrive as a notification to the client; nothing should.
    expect(inbox).toHaveLength(0)
  })

  it('marks the session blocked, which chat_list reports', async () => {
    const { stdout } = await cli(['ps'])
    expect(stdout).toContain('blocked')
  })

  it('clears blocked when the session next does anything', async () => {
    // A session waiting on a dialog cannot call tools, so any call proves it closed.
    await call('chat_status', { status: 'working', working_on: 'a migration' })
    await settle()

    const { stdout } = await cli(['ps'])
    expect(stdout).toContain('working')
    expect(stdout).not.toContain('blocked')
  })

  it('keeps the prompt in the log even after the session unblocks', async () => {
    const { stdout } = await cli(['history', '50'])
    expect(stdout).toContain('approval_request')
  })
})

describe('stale approvals', () => {
  it('drops a pending approval from the queue once it ages out', () => {
    // Claude Code sends no event when the local dialog wins, so an unanswered
    // approval must be presumed resolved rather than lingering forever.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ttl-'))
    const log = new EventLog(path.join(dir, 'events.db'))

    log.append({ kind: 'approval_request', actor: 'worker', target: 'human', body: 'Bash: old one' })
    expect(log.humanQueue()).toHaveLength(1)

    const db = log as unknown as { db: { exec: (sql: string) => void } }
    db.db.exec(`UPDATE events SET ts = ts - ${APPROVAL_TTL_MS + 1000} WHERE kind = 'approval_request'`)

    expect(log.humanQueue()).toHaveLength(0)
    log.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('does not age out questions, which stay until answered', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ttl-'))
    const log = new EventLog(path.join(dir, 'events.db'))

    log.append({ kind: 'question', actor: 'worker', target: 'human', body: 'still relevant?' })
    const db = log as unknown as { db: { exec: (sql: string) => void } }
    db.db.exec(`UPDATE events SET ts = ts - ${APPROVAL_TTL_MS * 10}`)

    expect(log.humanQueue()).toHaveLength(1)
    log.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
