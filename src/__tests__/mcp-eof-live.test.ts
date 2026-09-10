import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'

/**
 * The server must exit when its client closes the pipe (CC-75).
 *
 * `StdioServerTransport` wires only `data` and `error` on stdin, so EOF reaches
 * nothing and `transport.onclose` never fires for the case its own comment
 * describes. Two servers were found six days old because of it, each having
 * stranded a detached broker in turn. Production hides this: Claude Code kills
 * the subprocess outright, so the missing exit only bites when the parent goes
 * away WITHOUT killing the child.
 *
 * `stdio-lifetime.test.ts` already covers the helper against a fake stream. This
 * covers something that one structurally cannot: that the helper is still WIRED.
 * Deleting the `exitWhenStdinEnds` call from `server/index.ts` leaves every unit
 * test green, and that deletion is the whole bug.
 *
 * So it drives the built binary over a real pipe, and only after a completed
 * `initialize` — a server that exits because it never started proves nothing.
 *
 * A short socket directory, deliberately — see the note in `reregister-live.test.ts`.
 */
const shortTmp = (): string => (fs.existsSync('/tmp') ? '/tmp' : os.tmpdir())

let dir: string
let server: net.Server | undefined
let conns: net.Socket[] = []
let child: ChildProcessWithoutNullStreams | undefined

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(shortTmp(), 'ac-eof-'))
})

afterEach(async () => {
  child?.kill()
  child = undefined
  // `close()` waits for every accepted connection to end, and this broker never
  // answers, so a client that reconnected while waiting would hang the teardown
  // rather than the test.
  for (const conn of conns.splice(0)) conn.destroy()
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
  fs.rmSync(dir, { recursive: true, force: true })
})

/** A broker that accepts the connection and answers nothing, so the test turns only on stdin. */
function silentBroker(): Promise<void> {
  conns = []
  server = net.createServer(conn => conns.push(conn))
  return new Promise(resolve => server?.listen(path.join(dir, 'chat.sock'), resolve))
}

it('exits when its client closes stdin, after answering initialize', async () => {
  await silentBroker()

  const entry = path.join(import.meta.dirname, '..', '..', 'dist', 'cli.js')
  child = spawn(process.execPath, [entry, 'mcp'], {
    cwd: dir,
    env: { ...process.env, AGENT_CHAT_HOME: dir, CLAUDE_CODE_SESSION_ID: 'eof-probe' },
  })
  const proc = child

  const answered = await new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), 20_000)
    proc.stdout.on('data', chunk => {
      if (!String(chunk).includes('"protocolVersion"')) return
      clearTimeout(timer)
      resolve(true)
    })
    proc.on('exit', () => {
      clearTimeout(timer)
      resolve(false)
    })
    proc.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'eof-probe', version: '0' },
        },
      })}\n`,
    )
  })

  // The control half: without this, "it exited" is satisfied by a server that
  // died on startup, which is the opposite of what CC-75 is about.
  expect(answered, 'server never answered initialize').toBe(true)

  proc.stdin.end()

  const exitCode = await new Promise<number | 'timeout'>(resolve => {
    const timer = setTimeout(() => resolve('timeout'), 15_000)
    proc.on('exit', code => {
      clearTimeout(timer)
      resolve(code ?? -1)
    })
  })

  expect(exitCode, 'still running after EOF on stdin').toBe(0)
}, 45_000)
