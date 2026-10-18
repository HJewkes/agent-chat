import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildHookSettings, inboxHookCommand } from '../agents/launch-files.js'
import { buildLaunchPlan } from '../agents/launch-plan.js'
import type { AgentProfile } from '../agents/types.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { deliver, SocketServer } from '../broker/socket.js'
import { BrokerClient } from '../client/broker-client.js'
import type { DeliveredMessage } from '../protocol.js'
import { channelDelivery } from '../server/index.js'
import { inboxSpoolDir, resolveInboxSpool } from '../server/inbox-spool.js'

/**
 * CC-1455 S4: the hook installed in a spawned agent's settings.json shows a message
 * that reached its print-mode MCP server mid-turn. Run against the built `dist/cli.js`,
 * a real socket broker, and the exact command string from the generated settings.
 * Every name and id is synthetic.
 */

const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
const AGENT = 'ag0000x1'
const PRINT_ARGV = 'claude -p --output-format stream-json --verbose --channels plugin:agent-chat@local'
const POST = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })

interface HookEntry {
  matcher?: string
  hooks: Array<{ command: string; timeout: number }>
}
type Hooks = Record<string, HookEntry[]>

const profile: AgentProfile = {
  name: 'test',
  description: 'a profile',
  model: 'sonnet',
  allowedTools: ['Read'],
  isolation: 'none',
  surface: 'headless',
  promptPrelude: 'Be brief.',
}

let dir: string
let server: net.Server | undefined
const clients: BrokerClient[] = []
const previousHome = process.env['AGENT_CHAT_HOME']

beforeEach(async () => {
  expect(fs.existsSync(CLI), 'run `npm run build` first').toBe(true)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac1455-'))
  process.env['AGENT_CHAT_HOME'] = dir
  const core = new BrokerCore(deliver, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
  const socketServer = new SocketServer(core)
  const listener = net.createServer(conn => socketServer.onConnection(conn))
  server = listener
  await new Promise<void>(resolve => listener.listen(path.join(dir, 'chat.sock'), resolve))
})

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  const listener = server
  server = undefined
  if (listener !== undefined) await new Promise<void>(resolve => listener.close(() => resolve()))
  if (previousHome === undefined) delete process.env['AGENT_CHAT_HOME']
  else process.env['AGENT_CHAT_HOME'] = previousHome
  fs.rmSync(dir, { recursive: true, force: true })
})

async function registered(name: string, onDeliver: (message: DeliveredMessage) => void = () => undefined) {
  const client = new BrokerClient(onDeliver)
  clients.push(client)
  await client.connect()
  await client.request(
    { t: 'register', name, workingOn: 'testing CC-1455', cwd: '/tmp', pid: process.pid },
    'register_result',
  )
  return client
}

/** The agent's MCP server as `startMcpServer` wires it, with its launch env and a print host. */
function printModeDelivery(): (message: DeliveredMessage) => void {
  const plan = buildLaunchPlan({
    agentId: AGENT,
    sessionId: '00000000-0000-4000-8000-000000000001',
    name: 'agent-x',
    profile,
    brief: 'stand by',
    cwd: '/repo',
    cwdHoldsUserSettings: false,
    adopted: false,
    mcpConfigPath: path.join(dir, 'mcp.json'),
  })
  const spoolDir = resolveInboxSpool({ agentId: AGENT, env: plan.env, hostPid: 4242, read: () => PRINT_ARGV })
  return channelDelivery(
    () => undefined,
    () => undefined,
    spoolDir,
  ).deliver
}

const hooksFor = (agentId: string): Hooks =>
  (buildHookSettings(CLI, undefined, undefined, agentId) as { hooks: Hooks }).hooks

const runUnderSh = (command: string, input: string) =>
  spawnSync('sh', ['-c', command], { input, encoding: 'utf8', env: { ...process.env, AGENT_CHAT_HOME: dir } })

async function eventually(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 80 && !predicate(); i += 1) await new Promise(resolve => setTimeout(resolve, 25))
}

const spooled = (): string[] => {
  const inbox = inboxSpoolDir(AGENT)
  return fs.existsSync(inbox) ? fs.readdirSync(inbox).filter(name => name.endsWith('.json')) : []
}

describe('the installed inbox hook, end to end', () => {
  // Mutations caught: quoting the glob, and omitting AGENT_CHAT_INBOX_SPOOL from the launch env.
  it('shows a message sent mid-turn at the next tool call, and only once', async () => {
    // Arrange
    await registered('agent-x', printModeDelivery())
    const sender = await registered('scout')
    const sent = await sender.request({ t: 'send', to: 'agent-x', text: 'stand down now' }, 'send_result')
    await eventually(() => spooled().length === 1)
    const [post] = hooksFor(AGENT).PostToolUse!.filter(entry => entry.matcher === undefined)

    // Act
    const first = runUnderSh(post!.hooks[0]!.command, POST)
    const second = runUnderSh(post!.hooks[0]!.command, POST)

    // Assert
    const msgId = (sent as { msgId?: string }).msgId
    expect(msgId).toBeDefined()
    expect(first.status).toBe(0)
    const context = (
      JSON.parse(first.stdout) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string }
      }
    ).hookSpecificOutput
    expect(context.hookEventName).toBe('PostToolUse')
    expect(context.additionalContext).toContain(`msg_id="${msgId}"`)
    expect(context.additionalContext).toContain('stand down now')
    expect(second.stdout).toBe('')
    expect(spooled()).toEqual([])
  }, 30_000)
})

describe('the shell guard', () => {
  // Mutation caught: dropping the `[ -e "$f" ]` test, which execs the missing node below.
  it('starts no node for an empty inbox: a missing node path still exits 0 with no output', () => {
    // Arrange
    fs.mkdirSync(inboxSpoolDir(AGENT), { recursive: true })
    const command = inboxHookCommand(CLI, AGENT, 'post').replace(process.execPath, path.join(dir, 'no-node'))

    // Act
    const run = runUnderSh(command, POST)

    // Assert
    expect(command).toContain(path.join(dir, 'no-node'))
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe('')
  })

  it('finds a waiting record under a path with a space, so it execs (here a missing node)', () => {
    const spaced = path.join(dir, 'with space')
    process.env['AGENT_CHAT_HOME'] = spaced
    fs.mkdirSync(inboxSpoolDir(AGENT), { recursive: true })
    fs.writeFileSync(path.join(inboxSpoolDir(AGENT), 'x.json'), '{}')
    const command = inboxHookCommand(CLI, AGENT, 'post').replace(process.execPath, path.join(dir, 'no-node'))

    const run = runUnderSh(command, POST)

    expect(run.status).not.toBe(0)
  })
})

describe('buildHookSettings with an agent id', () => {
  it('installs the inbox hook on PostToolUse with no matcher, UserPromptSubmit after the stale guard, and Stop', () => {
    // Act
    const hooks = hooksFor(AGENT)

    // Assert
    const inbox = (event: string) =>
      hooks[event]!.filter(entry => entry.hooks.some(hook => hook.command.includes(' inbox-hook ')))
    expect(inbox('PostToolUse')).toHaveLength(1)
    expect(inbox('PostToolUse')[0]!.matcher).toBeUndefined()
    expect(inbox('UserPromptSubmit')).toHaveLength(1)
    expect(inbox('Stop')).toHaveLength(1)
    expect(hooks.UserPromptSubmit![0]!.hooks[0]!.command).toContain('stale-session-guard')
    expect(hooks.UserPromptSubmit![1]).toBe(inbox('UserPromptSubmit')[0])
    expect(inbox('Stop')[0]!.hooks[0]!.command).not.toContain('--block')
    for (const event of ['PostToolUse', 'UserPromptSubmit', 'Stop'])
      expect(inbox(event)[0]!.hooks[0]!.timeout).toBe(10)
  })

  it('installs no inbox hook without an agent id', () => {
    expect(JSON.stringify(buildHookSettings(CLI))).not.toContain('inbox-hook')
  })
})
