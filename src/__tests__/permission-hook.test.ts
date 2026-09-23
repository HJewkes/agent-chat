import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { APPROVAL_TTL_MS, EventLog } from '../broker/event-log.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'
import { hookFrame, hookOutput, parseHookInput } from '../cli/verbs/permission-hook.js'

/**
 * CC-144: a headless agent's PermissionRequest hook files its prompt over an
 * unregistered connection and blocks on it. Driven in-process against a real
 * EventLog; the CLI round trip lives in permission-hook-cli.test.ts.
 */

interface Wire {
  conn: Conn
  frames: ServerMessage[]
  /** Feeds one frame through the real line reader, as bytes on the socket would. */
  send: (msg: ClientMessage) => void
  close: () => void
}

const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function makeCore(): BrokerCore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-hook-'))
  dirs.push(dir)
  return new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
}

function wireFor(server: SocketServer): Wire {
  const frames: ServerMessage[] = []
  const emitter = new EventEmitter()
  const conn = Object.assign(emitter, {
    write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
  }) as unknown as Conn
  server.onConnection(conn)
  return {
    conn,
    frames,
    send: msg => emitter.emit('data', JSON.stringify(msg) + '\n'),
    close: () => emitter.emit('close'),
  }
}

function setup(): { core: BrokerCore; server: SocketServer; wire: () => Wire } {
  const core = makeCore()
  const server = new SocketServer(core)
  return { core, server, wire: () => wireFor(server) }
}

const BASH_PROMPT: Extract<ClientMessage, { t: 'permission_hook' }> = {
  t: 'permission_hook',
  session: 'scout',
  toolName: 'Bash',
  toolInput: { command: 'date > hello.txt', description: 'Write the date' },
  description: 'Write the date',
}

function fileHookPrompt(hook: Wire): string {
  hook.send(BASH_PROMPT)
  const result = hook.frames.find(f => f.t === 'permission_hook_result')
  if (result?.t !== 'permission_hook_result' || !result.ok || !result.msgId) throw new Error('not filed')
  return result.msgId
}

function registered(wire: () => Wire, name: string): Wire {
  const session = wire()
  session.send({ t: 'register', name, workingOn: 'testing', cwd: '/tmp', pid: 1 })
  return session
}

const verdicts = (frames: ServerMessage[]) => frames.filter(f => f.t === 'permission_verdict')

const resolutionOf = (core: BrokerCore, msgId: string): string | undefined =>
  core.events.since(0, 1000).find(row => row.kind === 'resolution' && row.ref === msgId)?.body ?? undefined

describe('a hook filing a prompt', () => {
  it('lands in the human queue as an approval_request with source hook and the whole input', () => {
    const { core, wire } = setup()
    const msgId = fileHookPrompt(wire())

    const item = core.events.humanQueue().find(i => i.msgId === msgId)
    expect(item).toMatchObject({ kind: 'approval_request', from: 'scout', text: 'Bash: Write the date' })
    expect(item?.meta).toMatchObject({ source: 'hook', tool_name: 'Bash' })
    expect(JSON.parse(item?.meta.input_preview ?? '')).toEqual(BASH_PROMPT.toolInput)
  })

  it('is refused from a registered session, which cannot fabricate prompts for another', () => {
    const { core, wire } = setup()
    const peer = registered(wire, 'peer')

    peer.send(BASH_PROMPT)

    expect(peer.frames.at(-1)).toMatchObject({ t: 'permission_hook_result', ok: false })
    expect(core.events.humanQueue()).toHaveLength(0)
    expect(core.events.history(50).some(i => i.kind === 'verdict_refused')).toBe(true)
  })

  it('stays answerable past the channel TTL, since the hook is still blocking', () => {
    const { core, wire } = setup()
    const msgId = fileHookPrompt(wire())
    const log = core.events as unknown as { db: { exec: (sql: string) => void } }

    log.db.exec(`UPDATE events SET ts = ts - ${APPROVAL_TTL_MS * 3} WHERE kind = 'approval_request'`)

    expect(core.events.openApproval(msgId)).toMatchObject({ source: 'hook', session: 'scout' })
    expect(core.events.humanQueue().map(i => i.msgId)).toContain(msgId)
  })
})

describe('answering a hook prompt', () => {
  it('sends the verdict on the hook connection and closes the row', () => {
    const { core, wire } = setup()
    const hook = wire()
    const msgId = fileHookPrompt(hook)
    const human = wire()

    human.send({ t: 'approve_permission', msgId, behavior: 'allow' })

    expect(verdicts(hook.frames)).toEqual([{ t: 'permission_verdict', requestId: msgId, behavior: 'allow' }])
    expect(human.frames.at(-1)).toMatchObject({ t: 'answer_result', ok: true })
    expect(resolutionOf(core, msgId)).toBe('allow')
    expect(core.events.openApproval(msgId)).toBeUndefined()
  })

  it('never routes to the session of the same name, whose MCP server did not ask', () => {
    const { wire } = setup()
    const scout = registered(wire, 'scout')
    const msgId = fileHookPrompt(wire())

    wire().send({ t: 'approve_permission', msgId, behavior: 'allow' })

    expect(verdicts(scout.frames)).toHaveLength(0)
  })

  it('refuses approve_permission from a registered session and leaves the hook waiting', () => {
    const { core, wire } = setup()
    const hook = wire()
    const msgId = fileHookPrompt(hook)
    const scout = registered(wire, 'scout')

    scout.send({ t: 'approve_permission', msgId, behavior: 'allow' })

    expect(scout.frames.at(-1)).toMatchObject({ t: 'answer_result', ok: false })
    expect(verdicts(hook.frames)).toHaveLength(0)
    expect(core.events.openApproval(msgId)).toBeDefined()
  })

  it('denies the hook when the human dismisses the row instead', () => {
    const { wire } = setup()
    const hook = wire()
    const msgId = fileHookPrompt(hook)

    wire().send({ t: 'dismiss', msgId })

    expect(verdicts(hook.frames)).toEqual([{ t: 'permission_verdict', requestId: msgId, behavior: 'deny' }])
  })
})

describe('a hook that stops waiting', () => {
  it('closes its row when it withdraws, without waiting for the TTL', () => {
    const { core, wire } = setup()
    const hook = wire()
    const msgId = fileHookPrompt(hook)

    hook.send({ t: 'permission_hook_withdrawn', msgId })

    expect(core.events.openApproval(msgId)).toBeUndefined()
    expect(resolutionOf(core, msgId)).toBe('withdrawn')
    expect(hook.frames.at(-1)).toMatchObject({ t: 'permission_hook_result', ok: true, msgId })
  })

  it('closes its row when its connection closes', () => {
    const { core, wire } = setup()
    const hook = wire()
    const msgId = fileHookPrompt(hook)

    hook.close()

    expect(core.events.openApproval(msgId)).toBeUndefined()
    expect(core.events.humanQueue()).toHaveLength(0)
  })

  it('refuses a withdrawal from any connection but the one that filed it', () => {
    const { core, wire } = setup()
    const msgId = fileHookPrompt(wire())
    const other = wire()

    other.send({ t: 'permission_hook_withdrawn', msgId })

    expect(other.frames.at(-1)).toMatchObject({ t: 'permission_hook_result', ok: false })
    expect(core.events.openApproval(msgId)).toBeDefined()
  })

  it('reports an answer that arrives after the hook left as undeliverable', () => {
    const { wire } = setup()
    const hook = wire()
    const msgId = fileHookPrompt(hook)
    hook.close()
    const human = wire()

    human.send({ t: 'approve_permission', msgId, behavior: 'allow' })

    expect(human.frames.at(-1)).toMatchObject({ t: 'answer_result', ok: false })
  })

  it('has its row closed by the next broker, since no hook connection survives a restart', () => {
    const core = makeCore()
    const first = new SocketServer(core)
    const msgId = fileHookPrompt(wireFor(first))

    new SocketServer(core)

    expect(core.events.openApproval(msgId)).toBeUndefined()
    expect(resolutionOf(core, msgId)).toBe('withdrawn')
  })
})

describe('the hook process contract', () => {
  it('prints the allow decision Claude Code 2.1.280 accepts', () => {
    expect(JSON.parse(hookOutput('allow'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    })
  })

  it('prints a deny decision that carries a message', () => {
    const decision = (JSON.parse(hookOutput('deny')) as { hookSpecificOutput: { decision: unknown } })
      .hookSpecificOutput.decision
    expect(decision).toMatchObject({ behavior: 'deny', message: expect.any(String) })
  })

  it('files under the spawned name, falling back to the Claude session id', () => {
    const input = parseHookInput(
      JSON.stringify({ session_id: 'f91c0f3a-4584', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    )

    expect(hookFrame(input, { AGENT_CHAT_NAME: 'scout' }).session).toBe('scout')
    expect(hookFrame(input, {}).session).toBe('claude-f91c0f3a')
    expect(hookFrame(input, {})).not.toHaveProperty('description')
  })
})
