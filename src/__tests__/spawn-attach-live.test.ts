import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reapBroker } from './broker-harness.js'

/**
 * CC-95, against the real thing: a built binary, a real broker on a real unix
 * socket, an isolated `AGENT_CHAT_HOME`, and a real agent process.
 *
 * Nothing below the process boundary can prove this. `agent_spawn` reported
 * success from inside the supervisor, and the supervisor was right about what it
 * had done — it had opened a pane. The claim that was false was the one the
 * REQUESTER read off the socket, so the socket is where it has to be checked.
 *
 * `claude` is stubbed by putting a directory in front of PATH. The broker passes
 * its own environment down through `run-agent`, so the agent runs the stub, and
 * no real Claude Code session is started on the machine running the suite.
 *
 * A short socket directory, deliberately — see the note in `reregister-live.test.ts`.
 */
const shortTmp = (): string => (fs.existsSync('/tmp') ? '/tmp' : os.tmpdir())

let dir: string
let workspace: string
let broker: ChildProcess | undefined

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(shortTmp(), 'ac-attach-'))
  workspace = fs.mkdtempSync(path.join(shortTmp(), 'ac-work-'))
})

afterEach(async () => {
  await reapBroker(dir)
  broker?.kill('SIGKILL')
  broker = undefined
  for (const target of [dir, workspace]) fs.rmSync(target, { recursive: true, force: true })
})

const entry = (): string => path.join(import.meta.dirname, '..', '..', 'dist', 'cli.js')

/**
 * A `claude` that does what the argument says and nothing else. `registers` runs
 * the one frame a real agent's MCP server sends before its first turn; without it
 * the stub is a process that starts, occupies a pane and never joins the bus —
 * which is precisely the failure being tested for.
 */
function stubClaude(body: string): string {
  const binDir = path.join(dir, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const script = path.join(binDir, 'stub.js')
  fs.writeFileSync(script, body)
  const stub = path.join(binDir, 'claude')
  fs.writeFileSync(stub, `#!/bin/sh\nexec '${process.execPath}' '${script}'\n`, { mode: 0o755 })
  return binDir
}

const REGISTERS = `
const net = require('node:net')
const sock = net.connect(process.env.AGENT_CHAT_HOME + '/chat.sock', () => {
  sock.write(JSON.stringify({
    t: 'register',
    name: process.env.AGENT_CHAT_NAME,
    agentId: process.env.AGENT_CHAT_AGENT_ID,
    workingOn: 'live probe',
    cwd: process.cwd(),
    pid: process.pid,
  }) + '\\n')
})
setTimeout(() => process.exit(0), 5000)
`

const DIES = `process.exit(3)`

/** Start the built broker under this test's own home, and wait for its socket. */
async function startBroker(binDir: string): Promise<void> {
  broker = spawn(process.execPath, [entry(), 'broker'], {
    cwd: workspace,
    env: { ...process.env, AGENT_CHAT_HOME: dir, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    stdio: 'ignore',
  })
  const sock = path.join(dir, 'chat.sock')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(sock)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('broker never bound its socket')
}

/** One connection, holding every reply it is sent, in order. */
async function connect(): Promise<{ send: (frame: unknown) => void; replies: Record<string, unknown>[] }> {
  const conn = net.connect(path.join(dir, 'chat.sock'))
  await new Promise<void>((resolve, reject) => {
    conn.once('connect', resolve)
    conn.once('error', reject)
  })
  const replies: Record<string, unknown>[] = []
  let buffer = ''
  conn.on('data', chunk => {
    buffer += String(chunk)
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) replies.push(JSON.parse(line) as Record<string, unknown>)
    }
  })
  return { send: frame => void conn.write(`${JSON.stringify(frame)}\n`), replies }
}

const waitFor = async (
  replies: Record<string, unknown>[],
  kind: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | undefined> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = replies.find(reply => reply['t'] === kind)
    if (found) return found
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return undefined
}

const spawnFrame = (name: string) => ({
  t: 'spawn',
  name,
  profile: 'explorer',
  brief: 'live attach probe',
  cwd: workspace,
  isolation: 'none',
  surface: 'headless',
})

describe('what the requester reads off the socket', () => {
  it('reports success only after the agent has registered', async () => {
    await startBroker(stubClaude(REGISTERS))
    const { send, replies } = await connect()

    send(spawnFrame('live-attach-ok'))
    const result = await waitFor(replies, 'spawn_result', 40_000)

    expect(result?.['reason']).toBeUndefined()
    expect(result?.['ok']).toBe(true)
    expect(result?.['name']).toBe('live-attach-ok')
  }, 60_000)

  /**
   * The defect, end to end. Before this change the same frame came back
   * `ok: true` with an agent id, and the identity sat in `starting` forever.
   */
  it('reports failure, naming the exit code, when claude dies before registering', async () => {
    await startBroker(stubClaude(DIES))
    const { send, replies } = await connect()

    send(spawnFrame('live-attach-dead'))
    const result = await waitFor(replies, 'spawn_result', 40_000)

    expect(result?.['ok']).toBe(false)
    expect(String(result?.['reason'])).toContain('never registered')
    expect(String(result?.['reason'])).toContain('exit code 3')
  }, 60_000)

  /**
   * THE HAZARD OF THIS TASK. The broker is one event loop for the whole machine,
   * and this change puts a wait inside the spawn path. A second session's frame
   * has to be answered while that wait is outstanding, or every sibling agent on
   * the machine stalls behind one slow launch — the August failure, rebuilt.
   */
  it('keeps answering other sessions while a spawn is waiting to attach', async () => {
    await startBroker(stubClaude('setTimeout(() => process.exit(0), 20000)'))
    const spawner = await connect()
    const bystander = await connect()

    spawner.send(spawnFrame('live-attach-slow'))
    // Long enough that the launch is definitely underway and the supervisor is
    // sitting in its attach window rather than still writing launch files.
    await new Promise(resolve => setTimeout(resolve, 2000))
    bystander.send({ t: 'list' })

    expect(await waitFor(bystander.replies, 'list_result', 5000)).toBeDefined()
    expect(spawner.replies.find(reply => reply['t'] === 'spawn_result')).toBeUndefined()
  }, 60_000)
})
