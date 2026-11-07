import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

/**
 * BS-48, against the built binary: an MCP server with `AGENT_CHAT_NO_AUTOSTART=1` whose broker
 * socket is missing (a forward to a remote broker that is down) answers `initialize`, starts no
 * broker of its own, logs that it is waiting, and registers once the socket appears.
 */

let dir: string
let server: net.Server | undefined
let child: ChildProcessWithoutNullStreams | undefined

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-bs48-live-'))
})

afterEach(async () => {
  child?.kill()
  child = undefined
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
  fs.rmSync(dir, { recursive: true, force: true })
})

const sock = (): string => path.join(dir, 'chat.sock')

function startServer(): Promise<boolean> {
  const entry = path.join(import.meta.dirname, '..', '..', 'dist', 'cli.js')
  child = spawn(process.execPath, [entry, 'mcp'], {
    cwd: dir,
    env: {
      ...process.env,
      AGENT_CHAT_HOME: dir,
      AGENT_CHAT_NO_AUTOSTART: '1',
      AGENT_CHAT_AGENT_ID: 'probe1234',
      AGENT_CHAT_NAME: 'probe-agent',
      AGENT_CHAT_LAUNCHER_PID: String(process.ppid),
      CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    },
  })
  const proc = child
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 20_000)
    proc.stdout.on('data', chunk => {
      if (!String(chunk).includes('"protocolVersion"')) return
      clearTimeout(timer)
      resolve(true)
    })
    proc.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      })}\n`,
    )
  })
}

function brokerAppears(registered: string[]): Promise<void> {
  server = net.createServer(conn => {
    conn.on('data', chunk => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const frame = JSON.parse(line) as Record<string, unknown>
        if (frame['t'] !== 'register') continue
        registered.push(String(frame['name']))
        conn.write(`${JSON.stringify({ t: 'register_result', ok: true, name: frame['name'] })}\n`)
      }
    })
  })
  return new Promise(resolve => server?.listen(sock(), resolve))
}

it('waits for a missing broker without starting one, then registers when it appears', async () => {
  const answered = await startServer()

  expect(answered).toBe(true)
  expect(fs.existsSync(sock())).toBe(false)
  expect(fs.readFileSync(path.join(dir, 'broker.log'), 'utf8')).toContain('"event":"broker_wait"')

  const registered: string[] = []
  await brokerAppears(registered)

  await vi.waitFor(() => expect(registered).toEqual(['probe-agent']), { timeout: 10_000, interval: 100 })
}, 40_000)
