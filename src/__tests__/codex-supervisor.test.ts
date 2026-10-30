import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpOverrides, parseName, recordDelivered, reportWakeCapped } from '../cli/verbs/codex-run.js'
import type { AppendInput } from '../broker/event-store.js'
import { startCodexAppServer, type CodexAppServer } from '../codex/app-server-client.js'
import {
  DeliveryLoop,
  PEER_HEADER,
  spoolFinder,
  spoolHostPid,
  superviseCodex,
  type ThreadDelivery,
} from '../codex/supervisor.js'
import { codexHostDir, codexPendingDir } from '../paths.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'
import { codexInboxSpoolDir, spoolRecord } from '../server/inbox-spool.js'

/**
 * CC-1523 (codex-listen S4b): the delivery state machine of `agent-chat codex run`,
 * driven against the S4a fake app-server over real stdio JSON-RPC. No model, no
 * Codex login. Each test names the mutation it catches. Every id is synthetic.
 */

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-codex-app-server.mjs',
)
const THREAD = '01a15a00-0000-7000-8000-000000000001'

let scratch: string
let spool: string
let logFile: string
const servers: CodexAppServer[] = []

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-supervisor-'))
  spool = path.join(scratch, 'inbox')
  logFile = path.join(scratch, 'rpc.log')
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close('SIGKILL')))
  fs.rmSync(scratch, { recursive: true, force: true })
})

async function fake(...flags: string[]): Promise<CodexAppServer> {
  const server = await startCodexAppServer({
    cwd: scratch,
    env: process.env,
    executablePath: process.execPath,
    args: [FIXTURE, '--log', logFile, ...flags],
  })
  servers.push(server)
  return server
}

function spoolMessage(msgId: string, text: string, at?: number): void {
  spoolRecord(spool, {
    kind: 'message',
    msgId,
    ...(at === undefined ? {} : { at }),
    meta: { from: 'scout', msg_id: msgId },
    text,
  })
}

interface Sent {
  method: string
  params: { expectedTurnId?: string; approvalPolicy?: string; input?: { type: string; text: string }[] }
}

const sent = (): Sent[] =>
  fs
    .readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Sent)
    .filter(message => message.method.startsWith('turn/') || message.method.startsWith('thread/'))

const methods = (): string[] => sent().map(message => message.method)
const waiting = (): string[] => fs.readdirSync(spool).filter(name => name.endsWith('.json'))
const claimedLeft = (): string[] => {
  const dir = path.join(spool, '.claimed')
  return fs.existsSync(dir) ? fs.readdirSync(dir) : []
}

function loopFor(server: CodexAppServer, extra: Partial<ConstructorParameters<typeof DeliveryLoop>[0]> = {}) {
  const loop = new DeliveryLoop({
    server,
    threadId: THREAD,
    spoolDirs: () => [spool],
    log: () => undefined,
    ...extra,
  })
  server.onEvent(event => {
    if (event.kind === 'turn_started') loop.turnStarted(event.turnId)
    if (event.kind === 'turn_completed') loop.turnCompleted(event.turnId)
  })
  return loop
}

describe('codex run delivery', () => {
  it('starts a turn when idle, carrying two drained records as one user input in arrival order', async () => {
    // Catches: one RPC per record, a reordered drain, or claims kept after a successful start.
    const server = await fake()
    spoolMessage('m-1', 'first note')
    spoolMessage('m-2', 'second note')

    await loopFor(server).kick()

    const turns = sent().filter(message => message.method.startsWith('turn/'))
    expect(turns.map(message => message.method)).toEqual(['turn/start'])
    const input = turns[0]?.params.input ?? []
    expect(input).toHaveLength(1)
    expect(input[0]?.type).toBe('text')
    const text = input[0]?.text ?? ''
    expect(text.startsWith(PEER_HEADER)).toBe(true)
    expect(text.indexOf('first note')).toBeLessThan(text.indexOf('second note'))
    expect(text.indexOf('first note')).toBeGreaterThan(-1)
    expect(waiting()).toEqual([])
    expect(claimedLeft()).toEqual([])
  })

  it('reports each message handed to the thread with its latency and mode', async () => {
    // Catches: no receipt, a latency read off the wrong clock, or a steer reported as a start (CC-1680).
    const server = await fake('--steers-to-complete', '5')
    const delivered: ThreadDelivery[] = []
    const loop = loopFor(server, { now: () => 10_000, onDelivered: d => delivered.push(d) })
    spoolMessage('m-1', 'wake up', 7_500)
    await loop.kick()
    spoolMessage('m-2', 'mid-turn note', 9_000)
    await loop.kick()

    expect(delivered).toEqual([
      { msgId: 'm-1', threadId: THREAD, latencyMs: 2_500, mode: 'start' },
      { msgId: 'm-2', threadId: THREAD, latencyMs: 1_000, mode: 'steer' },
    ])
  })

  it('writes the delivery receipt as a delivered_to_thread row', () => {
    const appended: AppendInput[] = []

    recordDelivered({ append: input => appended.push(input) }, 'scout', {
      msgId: 'm-1',
      threadId: THREAD,
      latencyMs: 2_500,
      mode: 'steer',
    })

    expect(appended).toEqual([
      {
        kind: 'delivered_to_thread',
        actor: 'scout',
        ref: THREAD,
        meta: { msgId: 'm-1', mode: 'steer', latencyMs: '2500' },
      },
    ])
  })

  it('steers the active turn while busy', async () => {
    // Catches: starting a second turn while one runs, or steering with the wrong expectedTurnId.
    const server = await fake('--steers-to-complete', '5')
    const loop = loopFor(server)
    spoolMessage('m-1', 'wake up')
    await loop.kick()

    spoolMessage('m-2', 'mid-turn note')
    await loop.kick()

    const turns = sent().filter(message => message.method.startsWith('turn/'))
    expect(turns.map(message => message.method)).toEqual(['turn/start', 'turn/steer'])
    expect(turns[1]?.params.expectedTurnId).toBe('turn-1')
    expect(turns[1]?.params.input?.[0]?.text).toContain('mid-turn note')
    expect(waiting()).toEqual([])
  })

  it('falls back to turn/start when the turn ended before the steer arrived', async () => {
    // Catches: treating a steer precondition failure as a plain RPC error (records parked, no wake).
    const server = await fake()
    const loop = loopFor(server)
    loop.turnStarted('turn-gone')
    spoolMessage('m-1', 'raced note')

    await loop.kick()

    expect(methods().filter(method => method.startsWith('turn/'))).toEqual(['turn/steer', 'turn/start'])
    expect(waiting()).toEqual([])
    expect(claimedLeft()).toEqual([])
  })

  it('puts the records back in the spool under their own names when the RPC fails', async () => {
    // Catches: releasing claims before the RPC succeeds, or leaving them stranded in .claimed.
    const server = await fake('--fail-on', 'turn/start')
    spoolMessage('m-1', 'keep me')
    const before = waiting()

    await loopFor(server).kick()

    expect(methods()).toContain('turn/start')
    expect(waiting()).toEqual(before)
    expect(claimedLeft()).toEqual([])
  })

  it('wakes on every idle record when no cap is set', async () => {
    // Catches: a default cap on supervised sessions (decision 511 makes idle wake uncapped).
    const server = await fake()
    const loop = loopFor(server)
    for (const id of ['m-1', 'm-2', 'm-3']) {
      spoolMessage(id, `note ${id}`)
      await loop.kick()
    }

    expect(methods().filter(method => method === 'turn/start')).toHaveLength(3)
  })

  it('holds records in the spool once the wake cap is reached, and the next allowed wake carries them', async () => {
    // Catches: a cap that drops records, or one that never reopens after the hour.
    const server = await fake()
    let now = 1_000_000
    const loop = loopFor(server, { wakeCap: 1, now: () => now })
    spoolMessage('m-1', 'first')
    await loop.kick()
    spoolMessage('m-2', 'second')
    spoolMessage('m-3', 'third')

    await loop.kick()
    expect(methods().filter(method => method === 'turn/start')).toHaveLength(1)
    expect(waiting()).toHaveLength(2)

    now += 3_600_001
    await loop.kick()
    const starts = sent().filter(message => message.method === 'turn/start')
    expect(starts).toHaveLength(2)
    expect(starts[1]?.params.input?.[0]?.text).toMatch(/second[\s\S]*third/)
    expect(waiting()).toEqual([])
  })

  it('reports the cap once per trip, and again after it reopens and trips anew', async () => {
    // Catches: a report on every held drain, or none at all (CC-1545).
    const server = await fake()
    let now = 1_000_000
    const onWakeCapped = vi.fn()
    const loop = loopFor(server, { wakeCap: 1, now: () => now, onWakeCapped })
    for (const id of ['m-1', 'm-2', 'm-3']) {
      spoolMessage(id, `note ${id}`)
      await loop.kick()
    }
    expect(onWakeCapped.mock.calls).toEqual([[1]])

    now += 3_600_001
    await loop.kick()
    spoolMessage('m-4', 'after the hour')
    await loop.kick()
    expect(onWakeCapped.mock.calls).toEqual([[1], [1]])
  })

  it('does not report a cap that was never set', async () => {
    const server = await fake()
    const onWakeCapped = vi.fn()
    const loop = loopFor(server, { onWakeCapped })
    for (const id of ['m-1', 'm-2']) {
      spoolMessage(id, `note ${id}`)
      await loop.kick()
    }

    expect(onWakeCapped).not.toHaveBeenCalled()
  })
})

describe('reporting a wake cap', () => {
  const ok: ServerMessage = { t: 'send_result', ok: true, recipients: ['coord'] }

  it('sends one codex_wake_capped frame per held Codex pid, naming this machine', async () => {
    const frames: ClientMessage[] = []

    await reportWakeCapped([71_002], 4, fn => fn(async frame => (frames.push(frame), ok)))

    expect(frames).toEqual([{ t: 'codex_wake_capped', hostPid: 71_002, host: os.hostname(), cap: 4 }])
  })

  it('falls back to stderr when the broker cannot place it', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const refused: ServerMessage = { t: 'send_result', ok: false, recipients: [], reason: 'no session' }

    await reportWakeCapped([71_002], 4, fn => fn(async () => refused))

    expect(write).toHaveBeenCalledWith(expect.stringContaining('wake cap of 4/hour reached'))
    write.mockRestore()
  })

  it('keys the report on the pid in the spool path', () => {
    expect(spoolHostPid(codexInboxSpoolDir(71_002))).toBe(71_002)
  })
})

describe('superviseCodex', () => {
  it('starts the thread with approval policy never and exits with the app-server exit code', async () => {
    // Catches: omitting approvalPolicy (the client declines approval requests), or exiting 0 on a crash.
    const server = await fake('--exit-on', 'turn/start', '--exit-code', '7')
    spoolMessage('m-1', 'wake')

    const code = await superviseCodex({
      server,
      cwd: scratch,
      spoolDirs: () => [spool],
      rescanMs: 20,
      log: () => {},
    })

    expect(code).toBe(7)
    const start = sent().find(message => message.method === 'thread/start')
    expect(start?.params.approvalPolicy).toBe('never')
  })

  it('resumes the named thread with approval policy never, and a signal exit maps to 128 + signo', async () => {
    // Catches: starting a new thread on --resume, or dropping the policy on the resume path.
    const server = await fake()
    const running = superviseCodex({
      server,
      cwd: scratch,
      resume: THREAD,
      spoolDirs: () => [],
      rescanMs: 20,
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    void server.close('SIGTERM')

    expect(await running).toBe(128 + os.constants.signals.SIGTERM)
    const resume = sent().find(message => message.method === 'thread/resume')
    expect(resume?.params.approvalPolicy).toBe('never')
    expect(methods()).not.toContain('thread/start')
  })
})

describe('a named run across an app-server death (CC-1683)', () => {
  const NAME = 'cc1683-scout'
  const HOST_PID = 73_001
  const hostSpool = codexInboxSpoolDir(HOST_PID)
  const pending = codexPendingDir(NAME)
  const pendingRecords = (): string[] =>
    fs.existsSync(pending) ? fs.readdirSync(pending).filter(name => name.endsWith('.json')) : []

  const spoolToHost = (msgId: string): void => {
    spoolRecord(hostSpool, { kind: 'message', msgId, meta: { from: 'scout', msg_id: msgId }, text: msgId })
  }

  afterEach(() => {
    fs.rmSync(pending, { recursive: true, force: true })
    fs.rmSync(codexHostDir(HOST_PID), { recursive: true, force: true })
  })

  async function superviseOnce(server: CodexAppServer, spoolDirs: () => string[]): Promise<number> {
    return superviseCodex({
      server,
      cwd: scratch,
      keepAs: NAME,
      spoolDirs,
      rescanMs: 20,
      log: () => undefined,
    })
  }

  it('keeps the record an in-flight turn/start claimed when the app-server is killed', async () => {
    // Catches: parking before the failed RPC settled, or a run that keeps nothing.
    const server = await fake('--exit-on', 'turn/start', '--exit-code', '137')
    spoolToHost('m-kill')

    const code = await superviseOnce(server, () => [hostSpool])

    expect(code).toBe(137)
    expect(pendingRecords()).toHaveLength(1)
    expect(pendingRecords()[0]).toMatch(/-m-kill\.json$/)
    expect(fs.existsSync(codexHostDir(HOST_PID))).toBe(false)
  })

  it('delivers a kept record to the next run under the name exactly once', async () => {
    // Catches: a next run that never drains the pending dir, or one that leaves the record to go again.
    const dead = await fake('--exit-on', 'turn/start')
    spoolToHost('m-again')
    await superviseOnce(dead, () => [hostSpool])
    fs.rmSync(logFile, { force: true })

    const next = await fake()
    const running = superviseOnce(next, () => [])
    await vi.waitFor(() => expect(pendingRecords()).toEqual([]))
    await new Promise(resolve => setTimeout(resolve, 100))
    await next.close('SIGTERM')
    await running

    const carrying = sent().filter(m => JSON.stringify(m.params.input ?? '').includes('m-again'))
    expect(carrying.map(m => m.method)).toEqual(['turn/start'])
    expect(pendingRecords()).toEqual([])
  })

  it('does not hand a kept record to a run under another name', async () => {
    // Catches: a pending dir shared across names.
    const dead = await fake('--exit-on', 'turn/start')
    spoolToHost('m-mine')
    await superviseOnce(dead, () => [hostSpool])
    fs.rmSync(logFile, { force: true })

    const stranger = await fake()
    const running = superviseCodex({
      server: stranger,
      cwd: scratch,
      keepAs: 'cc1683-stranger',
      spoolDirs: () => [],
      rescanMs: 20,
      log: () => undefined,
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    await stranger.close('SIGTERM')
    await running

    expect(JSON.stringify(sent())).not.toContain('m-mine')
    expect(pendingRecords()).toHaveLength(1)
  })
})

describe('spoolFinder', () => {
  it("finds the native Codex under the app-server wrapper and ignores another Codex's spool", () => {
    // Catches: keying the spool on the wrapper pid, or draining an unrelated Codex.
    const parents: Record<number, number> = { 71_002: 71_001, 72_002: 72_001, 72_001: 1 }
    const find = spoolFinder(71_001, {
      parentOf: pid => parents[pid],
      fs: { readdirSync: (() => ['71002', '72002', 'stray']) as unknown as typeof fs.readdirSync },
      liveHost: () => true,
    })

    expect(find()).toEqual([codexInboxSpoolDir(71_002)])
  })

  it('skips a dir its dead owner left behind on a reused pid, until the new server stamps it', () => {
    // Catches: a reused pid under this supervisor draining the previous owner's records.
    const live = new Set<number>()
    const find = spoolFinder(71_001, {
      parentOf: pid => (pid === 71_002 ? 71_001 : undefined),
      fs: { readdirSync: (() => ['71002']) as unknown as typeof fs.readdirSync },
      liveHost: pid => live.has(pid),
    })

    expect(find()).toEqual([])
    live.add(71_002)
    expect(find()).toEqual([codexInboxSpoolDir(71_002)])
  })
})

describe('mcpOverrides', () => {
  it('marks the MCP server as a Codex host so it spools', () => {
    // Catches: an MCP server that detects claude-code and never spools for the supervisor.
    const args = mcpOverrides('/opt/node', '/opt/agent-chat/dist/cli.js')

    expect(args).toContain('mcp_servers.agent-chat.env={AGENT_CHAT_HOST="codex"}')
    expect(args).toContain('mcp_servers.agent-chat.args=["/opt/agent-chat/dist/cli.js","mcp"]')
    expect(args.filter(arg => arg === '-c')).toHaveLength(3)
  })

  it('puts --name in the MCP env as AGENT_CHAT_NAME', () => {
    // Catches: a --name that never reaches the MCP server, which then registers a derived name.
    const args = mcpOverrides('/opt/node', '/opt/agent-chat/dist/cli.js', 'scout')

    expect(args).toContain(
      'mcp_servers.agent-chat.env={AGENT_CHAT_HOST="codex",AGENT_CHAT_NAME="scout",AGENT_CHAT_CODEX_KEEP_AS="scout"}',
    )
  })

  it('carries AGENT_CHAT_HOME into the MCP env, which Codex would drop', () => {
    // Catches: a supervisor on a scratch home whose MCP server joins the default broker instead.
    const args = mcpOverrides('/opt/node', '/opt/agent-chat/dist/cli.js', 'scout', '/scratch/home')

    expect(args).toContain(
      'mcp_servers.agent-chat.env={AGENT_CHAT_HOST="codex",AGENT_CHAT_NAME="scout",AGENT_CHAT_CODEX_KEEP_AS="scout",AGENT_CHAT_HOME="/scratch/home"}',
    )
  })

  it('refuses a name no agent may hold, before Codex starts', () => {
    expect(parseName('scout-2')).toBe('scout-2')
    expect(parseName(undefined)).toBeUndefined()
    expect(() => parseName('../Scout')).toThrow(/--name/)
  })
})
