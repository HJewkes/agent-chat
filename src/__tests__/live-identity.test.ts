import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AgentLog } from '../agents/identity.js'
import { EventLog } from '../broker/event-log.js'
import type { AgentIdentity } from '../protocol.js'
import { reapBroker } from './broker-harness.js'

/**
 * CC-30 against a REAL Claude Code, because two of its premises are facts about
 * someone else's process and cannot be asserted anywhere else.
 *
 * WHY `session-adoption.test.ts` IS NOT ENOUGH. That test starts the MCP
 * subprocess itself, so it SETS `CLAUDE_CODE_SESSION_ID` and its parent is
 * vitest. Both inputs to `hostIdentity()` are therefore supplied by the test,
 * and it would pass unchanged on a machine where Claude Code sets no such
 * variable and inserts a shell between itself and its MCP servers. Only launching
 * `claude` for real can tell the difference.
 *
 * WHAT RESTS ON IT. `hostPid` is `process.ppid`, and teleport's shutdown decision
 * (D2) assumes that pid is Claude Code — that signalling it ends the session, and
 * that signalling the registry's own `pid` instead severs the bus and leaves a
 * live session behind. Both halves are ASSERTED HERE rather than reasoned about,
 * and the second one is the failure mode D2 exists to avoid, so a test that only
 * proved the good case would be proving the easy half.
 *
 * POSITIVE CONTROLS. Every negative assertion here has one, because they all fail
 * open: "no second identity was minted" passes if adoption never ran at all, and
 * "the MCP subprocess's parent is claude" passes vacuously if no MCP subprocess
 * was ever found. So the re-attach test first proves a DIFFERENT session id does
 * mint a second identity, and the process-tree test asserts it located a
 * subprocess before saying anything about its parent.
 *
 * SIGNALS ARE ONLY EVER SENT TO PROCESSES THIS FILE STARTED, or to a child of one
 * — never to a pid found by name. Other Claude Code sessions belong to the human.
 *
 * Opt-in: needs a real `claude` on PATH, a built `dist/`, and spawns real
 * sessions that cost tokens.
 *   AGENT_CHAT_LIVE=1 npx vitest run live-identity
 */

const LIVE = process.env.AGENT_CHAT_LIVE === '1'

const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')

/** Held open so a session stays up long enough to be inspected and signalled. */
interface LiveSession {
  child: ChildProcess
  sessionId: string
  name: string
}

const homes: string[] = []
const started: ChildProcess[] = []

function newHome(): string {
  // Short by necessity: the broker's unix socket lives in here and macOS caps
  // socket paths near 104 bytes.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-live-'))
  fs.writeFileSync(
    path.join(home, 'mcp.json'),
    JSON.stringify({
      mcpServers: { 'plugin:agent-chat:agent-chat': { command: process.execPath, args: [CLI, 'mcp'] } },
    }),
  )
  homes.push(home)
  return home
}

/** The session's own AGENT_CHAT_* must not leak in, or a probe joins the real bus. */
function envFor(home: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith('AGENT_CHAT_')) env[key] = value
  env.AGENT_CHAT_HOME = home
  // The broker this bus starts binds a port; the machine's real broker holds the
  // default one and a clash would have the probe talk to it instead.
  env.AGENT_CHAT_PORT = '7692'
  return env
}

const argvFor = (home: string, sessionId: string, resume: boolean): string[] => [
  '--model',
  'sonnet',
  resume ? '--resume' : '--session-id',
  sessionId,
  '--mcp-config',
  path.join(home, 'mcp.json'),
  '--allowed-tools',
  'mcp__plugin_agent-chat_agent-chat__*',
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-mode',
  'default',
]

const registerPrompt = (name: string): string =>
  `Call chat_register with name ${name} and working_on live identity probe. Then reply DONE.`

/**
 * A session that stays up. `--input-format stream-json` makes Claude Code wait on
 * stdin between turns, so holding the pipe open holds the process open — which a
 * `-p` run does not, and which every process-tree assertion below needs.
 */
function startHeldSession(home: string, name: string): LiveSession {
  const sessionId = crypto.randomUUID()
  const args = argvFor(home, sessionId, false)
  args.splice(args.indexOf('-p'), 1, '-p', '--input-format', 'stream-json')
  const child = spawn('claude', args, { cwd: home, env: envFor(home), stdio: ['pipe', 'ignore', 'ignore'] })
  started.push(child)
  child.stdin?.write(
    `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: registerPrompt(name) }] },
    })}\n`,
  )
  return { child, sessionId, name }
}

/** A one-shot run, for the cases that only need the log it leaves behind. */
function runOnce(home: string, sessionId: string, name: string, resume: boolean): Promise<void> {
  const child = spawn('claude', argvFor(home, sessionId, resume), {
    cwd: home,
    env: envFor(home),
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  started.push(child)
  child.stdin?.end(registerPrompt(name))
  return new Promise(resolve => {
    child.on('close', () => resolve())
    child.on('error', () => resolve())
  })
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function identityFor(home: string, sessionId: string): AgentIdentity | undefined {
  const file = path.join(home, 'events.db')
  if (!fs.existsSync(file)) return undefined
  const log = new EventLog(file)
  try {
    return new AgentLog(log).bySession(sessionId)
  } finally {
    log.close()
  }
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = probe()
    if (found !== undefined) return found
    if (Date.now() > deadline) return undefined
    await sleep(500)
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Rows of `pid ppid command`, so a claim about a parent is read off the real tree. */
function processTable(): { pid: number; ppid: number; command: string }[] {
  return execFileSync('ps', ['-eo', 'pid,ppid,command'])
    .toString()
    .split('\n')
    .slice(1)
    .flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? '' }] : []
    })
}

/** The agent-chat MCP subprocess Claude Code started, found by parentage only. */
const mcpChildOf = (hostPid: number): number | undefined =>
  processTable().find(p => p.ppid === hostPid && p.command.includes('cli.js mcp'))?.pid

async function registeredSession(home: string, name: string): Promise<LiveSession> {
  const session = startHeldSession(home, name)
  const identity = await waitFor(() => identityFor(home, session.sessionId), 120_000)
  expect(identity, `${name} never registered; no adopted identity for ${session.sessionId}`).toBeDefined()
  return session
}

afterAll(async () => {
  for (const child of started.splice(0)) {
    // Only ever our own children, and only ever ones we still hold a handle to.
    if (child.pid !== undefined && alive(child.pid)) {
      const mcp = mcpChildOf(child.pid)
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {
        // exited between the check and the signal
      }
      if (mcp !== undefined && alive(mcp)) {
        try {
          process.kill(mcp, 'SIGKILL')
        } catch {
          // its parent took it with it, which is the expected case
        }
      }
    }
  }
  for (const home of homes.splice(0)) {
    await reapBroker(home)
    fs.rmSync(home, { recursive: true, force: true })
  }
})

describe.skipIf(!LIVE)('an ordinary session, adopted by a real broker', () => {
  it('gets a durable identity whose session id is the one Claude Code is really using', async () => {
    const home = newHome()
    const session = await registeredSession(home, 'liveprobe')
    const identity = identityFor(home, session.sessionId)

    // The session id was never given to the model — it reached the broker only if
    // the subprocess read it out of its own environment.
    expect(identity).toMatchObject({ name: 'liveprobe', origin: 'adopted', sessionId: session.sessionId })
    expect(identity?.agentId).toBeTruthy()
  }, 180_000)

  it('keeps its identity when the socket goes, and re-attaches rather than minting a second', async () => {
    const home = newHome()
    const sessionId = crypto.randomUUID()
    await runOnce(home, sessionId, 'reattach', false)

    const first = await waitFor(() => identityFor(home, sessionId), 60_000)
    expect(first, 'no identity to re-attach to').toBeDefined()
    // The process is gone and the socket with it, yet the identity is still here:
    // this is the durable/ephemeral split the whole design rests on.
    expect(first?.state).toBe('detached')

    await runOnce(home, sessionId, 'reattach', true)
    const second = await waitFor(() => identityFor(home, sessionId), 60_000)
    expect(second?.agentId).toBe(first?.agentId)

    // THE CONTROL. Without it, "no second identity" would also pass if the second
    // run never registered at all. A different session id must mint a new one.
    const otherId = crypto.randomUUID()
    await runOnce(home, otherId, 'reattach2', false)
    const other = await waitFor(() => identityFor(home, otherId), 60_000)
    expect(other?.agentId, 'a distinct session id did not mint a distinct identity').not.toBe(first?.agentId)
  }, 300_000)
})

describe.skipIf(!LIVE)('hostPid, which teleport shutdown acts on', () => {
  it('is Claude Code itself, not a shell or a wrapper between it and the MCP server', async () => {
    const home = newHome()
    const session = await registeredSession(home, 'treeprobe')
    const hostPid = session.child.pid as number

    const mcp = mcpChildOf(hostPid)
    // Asserted before anything is said about the parent: "the parent is claude"
    // is vacuously true of a subprocess that was never found.
    expect(mcp, 'no agent-chat MCP subprocess under the session we started').toBeDefined()

    const command = processTable().find(p => p.pid === hostPid)?.command ?? ''
    expect(command, 'the pid the MCP server would report is not a claude process').toContain('claude')
    expect(command).toContain(session.sessionId)
  }, 180_000)

  it('ends the whole session when signalled: Claude Code exits and takes the bus with it', async () => {
    const home = newHome()
    const session = await registeredSession(home, 'killprobe')
    const hostPid = session.child.pid as number
    const mcp = mcpChildOf(hostPid)
    expect(mcp, 'nothing to observe the teardown of').toBeDefined()

    process.kill(hostPid, 'SIGTERM')

    expect(await waitFor(() => (alive(hostPid) ? undefined : true), 20_000)).toBe(true)
    expect(await waitFor(() => (alive(mcp as number) ? undefined : true), 20_000)).toBe(true)
    // Presence ended; identity did not.
    const identity = await waitFor(
      () => (identityFor(home, session.sessionId)?.state === 'detached' ? true : undefined),
      20_000,
    )
    expect(identity, 'the identity never recorded the detach').toBe(true)
    expect(identityFor(home, session.sessionId)).toBeDefined()
  }, 180_000)

  it('is not interchangeable with the registry pid: killing that leaves a live, unregistered session', async () => {
    const home = newHome()
    const session = await registeredSession(home, 'severprobe')
    const hostPid = session.child.pid as number
    const mcp = mcpChildOf(hostPid)
    expect(mcp, 'no MCP subprocess to sever').toBeDefined()

    // The registry's own `pid` field is this process — the mistake D2 exists to
    // avoid is treating it as the handle for shutting a session down.
    process.kill(mcp as number, 'SIGTERM')
    expect(await waitFor(() => (alive(mcp as number) ? undefined : true), 20_000)).toBe(true)

    const detached = await waitFor(
      () => (identityFor(home, session.sessionId)?.state === 'detached' ? true : undefined),
      20_000,
    )
    expect(detached, 'the broker did not notice the bus go away').toBe(true)
    // And the session is still running, with nothing on the roster to say so.
    expect(alive(hostPid), 'killing the MCP subprocess also killed Claude Code').toBe(true)
  }, 180_000)
})
