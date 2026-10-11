import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { invokeCommand } from '@titan-design/registry'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadProfile } from '../agents/profiles.js'
import type { AgentProfile } from '../agents/types.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { BrokerClient } from '../client/broker-client.js'
import type { VerbContext } from '../cli/command.js'
import { queueReadVerb } from '../cli/verbs/queue-read.js'
import type { ClientMessage, QueueItem, ServerMessage } from '../protocol.js'

/**
 * CC-426: the decider's read of the human queue. It must list what is open and be
 * unable, by construction, to answer, approve or endorse any of it.
 */

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-queue-read-'))
  process.env.AGENT_CHAT_HOME = home
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(home, { recursive: true, force: true })
})

function makeEnv() {
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  const server = new SocketServer(core)
  const sent: ClientMessage[] = []
  const wire = () => {
    const frames: ServerMessage[] = []
    const conn = {
      write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
    } as unknown as Conn
    return { conn, frames }
  }
  const asker = wire()
  server.handleMessage(asker.conn, { t: 'register', name: 'asker', workingOn: 'w', cwd: '/tmp', pid: 1 })
  server.handleMessage(wire().conn, {
    t: 'register',
    name: 'bob',
    workingOn: 'w',
    cwd: '/tmp',
    pid: 2,
    sessionId: 'session-bob',
  })
  server.handleMessage(asker.conn, {
    t: 'approval',
    requestId: 'r1',
    toolName: 'Bash',
    description: 'Run',
    inputPreview: 'ls',
  })
  server.handleMessage(asker.conn, { t: 'ask', text: 'Which store for the cache?', recommended: 'sqlite' })
  server.handleMessage(asker.conn, { t: 'endorse', to: 'bob', text: 'please rebase' })
  const ctx: VerbContext = {
    warnings: [],
    format: 'human',
    withBroker: async fn => {
      const human = wire()
      const broker = {
        request: async (frame: ClientMessage, expected: string) => {
          sent.push(frame)
          server.handleMessage(human.conn, frame)
          return human.frames.find(f => f.t === expected)
        },
      }
      return fn(broker as unknown as BrokerClient)
    },
  }
  return { core, ctx, sent }
}

const run = async (ctx: VerbContext, args: Record<string, unknown>) => invokeCommand(queueReadVerb, args, ctx)

describe('agent-chat queue', () => {
  // Mutation caught: dropping the --questions filter, which hands the decider approvals and endorsements to act on.
  it('lists only open questions as JSON with --questions --json', async () => {
    const { ctx } = makeEnv()

    const { envelope } = await run(ctx, { questions: true, json: true })

    expect(envelope.ok).toBe(true)
    const lines = (envelope as { data: { lines: string[] } }).data.lines
    const { items } = JSON.parse(lines[0]!) as { items: QueueItem[] }
    expect(items.map(i => [i.kind, i.text])).toEqual([['question', 'Which store for the cache?']])
  })

  // Mutation caught: routing the reader through inbox/run.ts or apply.ts, which sends approve and endorse frames.
  it('sends only the queue frame and leaves every open item open', async () => {
    const { core, ctx, sent } = makeEnv()
    const before = core.events.humanQueue().map(i => i.msgId)

    await run(ctx, {})
    await run(ctx, { questions: true, json: true })

    expect(sent.map(f => f.t)).toEqual(['queue', 'queue'])
    expect(core.events.humanQueue().map(i => i.msgId)).toEqual(before)
    expect(core.events.humanQueue().map(i => i.kind)).toEqual(
      expect.arrayContaining(['approval_request', 'question', 'endorse_request']),
    )
  })

  // Mutation caught: adding inbox's --batch/--answers to the reader, a flag a caller could flip into a writer.
  it.each([{ batch: true }, { answers: '-' }, { answers: '1: approve' }])(
    'refuses %o, since it takes no answer input',
    async args => {
      const { ctx, sent } = makeEnv()

      const { envelope } = await run(ctx, args)

      expect(envelope.ok).toBe(false)
      expect(sent).toEqual([])
    },
  )
})

describe('the reader module', () => {
  const SRC = path.join(__dirname, '..')

  function reachable(file: string, seen = new Set<string>()): Set<string> {
    if (seen.has(file)) return seen
    seen.add(file)
    const text = fs.readFileSync(file, 'utf8')
    for (const [, spec] of text.matchAll(/from '(\.[^']+)'/g)) {
      reachable(path.resolve(path.dirname(file), spec!.replace(/\.js$/, '.ts')), seen)
    }
    return seen
  }

  // Mutation caught: importing the inbox dispatcher or the human verdict helpers into the reader.
  it('cannot reach the inbox dispatcher or any human verdict code', () => {
    const files = [...reachable(path.join(SRC, 'cli/verbs/queue-read.ts'))].map(f => path.relative(SRC, f))

    expect(files.filter(f => f.startsWith('inbox/'))).toEqual([])
    expect(files).not.toContain('cli/human.ts')
    expect(files.filter(f => /approve|endorse|answer|dismiss/.test(f))).toEqual([])
  })
})

describe('the shipped decider profile', () => {
  const profile = loadProfile('decider', path.join(__dirname, '../../profiles')) as AgentProfile

  // Mutation caught: re-allowing inbox, or dropping a deny that lets the decider approve, endorse or answer.
  it('allows the read-only reader and denies every verb that answers for the human', () => {
    expect(profile.allowedTools).toContain('Bash(agent-chat queue:*)')
    expect(profile.allowedTools?.some(t => t.startsWith('Bash(agent-chat inbox'))).toBe(false)
    expect(profile.disallowedTools).toEqual(
      expect.arrayContaining([
        'Bash(agent-chat inbox:*)',
        'Bash(agent-chat approve:*)',
        'Bash(agent-chat endorse:*)',
        'Bash(agent-chat answer:*)',
        'mcp__plugin_agent-chat_agent-chat__chat_endorse',
      ]),
    )
  })

  it('points the prelude at the reader, not the inbox', () => {
    expect(profile.promptPrelude).toContain('agent-chat queue --questions --json')
    expect(profile.promptPrelude).not.toContain('agent-chat inbox')
  })
})
