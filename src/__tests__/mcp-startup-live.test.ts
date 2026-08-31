import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * A spawned agent must come up with its tools even when the broker does not answer.
 *
 * The incident, 2026-08-31: a burst of spawns blocked the broker's event loop for
 * fourteen seconds. Four agents' MCP servers timed out registering, and because
 * that registration was an unguarded `await`, the throw escaped `startMcpServer`
 * before `mcp.connect` ever ran. Claude Code logged
 * `Connection failed after 13809ms (CONNECTION_CLOSED)`, cached the failure for
 * fifteen minutes, and each agent worked its whole life with no chat tools —
 * one of them finished its research and could only report that it had no way to
 * deliver it. The broker, meanwhile, accepted the registration 0.67s after the
 * client gave up.
 *
 * So this drives the real binary over a real socket: nothing below the process
 * boundary can prove the server ANSWERED `initialize`, which is the only thing
 * Claude Code judges it on.
 *
 * A short socket directory, deliberately — see the note in `reregister-live.test.ts`.
 */
const shortTmp = (): string => (fs.existsSync('/tmp') ? '/tmp' : os.tmpdir())

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

let dir: string
let server: net.Server | undefined
let child: ChildProcessWithoutNullStreams | undefined

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(shortTmp(), 'ac-startup-'))
})

afterEach(async () => {
  child?.kill()
  child = undefined
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
  fs.rmSync(dir, { recursive: true, force: true })
})

/** A broker that accepts the connection and then does whatever `onFrame` says. */
function stubBroker(onFrame: (conn: net.Socket, frame: Record<string, unknown>) => void): Promise<void> {
  server = net.createServer(conn => {
    conn.on('data', chunk => {
      for (const line of chunk.toString().split('\n').filter(Boolean))
        onFrame(conn, JSON.parse(line) as Record<string, unknown>)
    })
  })
  return new Promise(resolve => server?.listen(path.join(dir, 'chat.sock'), resolve))
}

/** Start the built server as a spawned agent, and resolve with its `initialize` reply. */
function initialize(): Promise<{ answered: boolean; alive: boolean; stderr: string }> {
  const entry = path.join(import.meta.dirname, '..', '..', 'dist', 'cli.js')
  child = spawn(process.execPath, [entry, 'mcp'], {
    cwd: dir,
    env: {
      ...process.env,
      AGENT_CHAT_HOME: dir,
      AGENT_CHAT_AGENT_ID: 'probe1234',
      AGENT_CHAT_NAME: 'probe-agent',
      CLAUDE_CODE_SESSION_ID: SESSION_ID,
    },
  })
  const proc = child
  let stderr = ''
  proc.stderr.on('data', chunk => (stderr += String(chunk)))

  return new Promise(resolve => {
    const settle = (answered: boolean): void =>
      resolve({ answered, alive: proc.exitCode === null && !proc.killed, stderr })
    // Comfortably past the client's 5s request timeout plus its reconnect ladder,
    // so a server that only fails slowly still fails this test.
    const timer = setTimeout(() => settle(false), 20_000)
    proc.stdout.on('data', chunk => {
      if (!String(chunk).includes('"protocolVersion"')) return
      clearTimeout(timer)
      settle(true)
    })
    proc.on('exit', () => {
      clearTimeout(timer)
      settle(false)
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

describe('the MCP server against a broker that will not answer', () => {
  it('still answers initialize, rather than dying with the registration', async () => {
    const seen: string[] = []
    await stubBroker((_conn, frame) => void seen.push(String(frame['t'])))

    const result = await initialize()

    expect(result.answered).toBe(true)
    expect(result.alive).toBe(true)
    // The exact stderr line Claude Code recorded before giving up on the server.
    expect(result.stderr).not.toContain('broker did not answer register_result')
    expect(seen).toContain('register')
  }, 30_000)

  /**
   * The positive control. Without it, a test that only ever sees silence cannot
   * tell "survives a stall" from "never talks to the broker at all".
   */
  it('registers under its assigned name when the broker does answer', async () => {
    const registered: string[] = []
    await stubBroker((conn, frame) => {
      if (frame['t'] !== 'register') return
      registered.push(String(frame['name']))
      conn.write(`${JSON.stringify({ t: 'register_result', ok: true, name: frame['name'] })}\n`)
    })

    const result = await initialize()

    expect(result.answered).toBe(true)
    expect(registered).toEqual(['probe-agent'])
  }, 30_000)
})
