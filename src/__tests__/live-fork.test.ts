import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AgentLog } from '../agents/identity.js'
import { findTranscript } from '../agents/transcript.js'
import { EventLog } from '../broker/event-log.js'
import { reapBroker } from './broker-harness.js'

/**
 * CC-44 against a REAL Claude Code: does a forked agent actually INHERIT the
 * conversation?
 *
 * WHY THIS CANNOT BE A UNIT TEST, and it is the same trap `live-toolset.test.ts`
 * documents: asserting `--fork-session` appears in the argv proves the flag was
 * passed, not that Claude Code did anything with it. The flag is three lines of
 * code; the behaviour is the whole feature. So the proof is a SECRET the child
 * could only know by inheriting — a nonce spoken to the parent conversation and
 * never written into the child's brief, its environment, or its cwd.
 *
 * THE BRIEF IS CHECKED, not trusted. The parent composes the spawn call itself,
 * and a parent that pasted the nonce into the brief would make the child's answer
 * meaningless. The recorded `agent_spawned` body is asserted NOT to contain it,
 * so a leaky brief fails the test instead of passing it.
 *
 * THE NEGATIVE CONTROL IS NOT OPTIONAL. The same probe runs with `inherit`
 * omitted, and the child must NOT produce the nonce. Without that arm, a test
 * that somehow leaked the secret through another path would look like success.
 *
 * Everything runs under an isolated AGENT_CHAT_HOME with its own broker and its
 * own port: no session on this machine is read, resumed or disturbed.
 *
 * Opt-in: needs a real `claude` on PATH, a built `dist/`, and spawns real
 * sessions that cost tokens.
 *   AGENT_CHAT_LIVE=1 npx vitest run live-fork
 */

const LIVE = process.env.AGENT_CHAT_LIVE === '1'

const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')

const homes: string[] = []
const started: ChildProcess[] = []

function newHome(): string {
  // Short by necessity: the broker's unix socket lives in here and macOS caps
  // socket paths near 104 bytes.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-fork-'))
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
  // Not the default port, and a different one per probe. The default belongs to
  // the machine's real broker, and a clash would have this spawn agents onto
  // somebody's live bus; reusing ONE port across probes clashes with this file's
  // own earlier broker, which is still up until afterAll reaps it.
  env.AGENT_CHAT_PORT = String(7694 + homes.indexOf(home))
  return env
}

/**
 * The whole parent session in ONE turn: it is told the secret, registers, and
 * spawns the fork, then exits.
 *
 * A two-turn parent held open with `--input-format stream-json` was tried first
 * and does not work here — the second message lands in the transcript as a
 * queue-operation and no assistant turn ever runs, so the spawn never happens.
 * One turn is also enough for the proof: the secret is in the parent's USER row,
 * which Claude Code writes before the turn completes, so it is in the transcript
 * the fork inherits.
 */
function runParent(home: string, sessionId: string, prompt: string): Promise<number | null> {
  const child = spawn(
    'claude',
    [
      '--model',
      'sonnet',
      '--session-id',
      sessionId,
      '--mcp-config',
      path.join(home, 'mcp.json'),
      // Only the server under test, so this probe does not start whatever else
      // the developer running it happens to have configured.
      '--strict-mcp-config',
      '--allowed-tools',
      'mcp__plugin_agent-chat_agent-chat__*',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'default',
      '--',
      prompt,
    ],
    { cwd: home, env: envFor(home), stdio: ['ignore', 'pipe', 'pipe'] },
  )
  started.push(child)
  // Kept, because the interesting failure is "the parent ran and did not spawn",
  // and without its own stream-json there is nothing to say why.
  child.stdout.pipe(fs.createWriteStream(path.join(home, 'parent.log')))
  child.stderr.pipe(fs.createWriteStream(path.join(home, 'parent.err')))
  return new Promise(resolve => {
    child.on('close', code => resolve(code))
    child.on('error', () => resolve(null))
  })
}

/** The tail of what the parent said, for a failure message that can be acted on. */
const parentTail = (home: string): string => {
  const read = (file: string): string => {
    try {
      return fs.readFileSync(path.join(home, file), 'utf8')
    } catch {
      return ''
    }
  }
  return `${read('parent.log')}\n${read('parent.err')}`.slice(-800)
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = probe()
    if (found !== undefined) return found
    if (Date.now() > deadline) return undefined
    await sleep(1000)
  }
}

/** One read of the probe's own event log; closed again each time, since the broker owns it. */
function readEvents<T>(home: string, read: (log: EventLog) => T): T | undefined {
  const file = path.join(home, 'events.db')
  if (!fs.existsSync(file)) return undefined
  const log = new EventLog(file)
  try {
    return read(log)
  } finally {
    log.close()
  }
}

const registered = (home: string, sessionId: string): boolean =>
  readEvents(home, log => new AgentLog(log).bySession(sessionId)) !== undefined

interface SpawnedChild {
  agentId: string
  sessionId: string
  cwd: string
  /** The brief as recorded, so a parent that leaked the secret into it is caught. */
  brief: string
  inherit: string
}

function spawnedRow(home: string, name: string): SpawnedChild | undefined {
  const row = readEvents(home, log =>
    log.agentEvents().find(r => r.kind === 'agent_spawned' && r.target === name),
  )
  if (row === undefined || row.msgId === undefined || row.msgId === null) return undefined
  return {
    agentId: row.msgId,
    sessionId: row.meta.session_id ?? '',
    cwd: row.meta.cwd ?? '',
    brief: row.body ?? '',
    inherit: row.meta.inherit ?? '',
  }
}

/** Every assistant text block the child wrote, which is where an inherited secret would surface. */
function assistantText(file: string): string {
  const out: string[] = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let record: { message?: { role?: string; content?: unknown } }
    try {
      record = JSON.parse(line)
    } catch {
      continue // a partially flushed final line is normal on a live tail
    }
    if (record.message?.role !== 'assistant') continue
    const content = record.message.content
    if (Array.isArray(content))
      for (const block of content)
        if (block && typeof block === 'object' && (block as { type?: string }).type === 'text')
          out.push(String((block as { text?: string }).text ?? ''))
  }
  return out.join('\n')
}

/** Fixed, and quoted to the parent verbatim: a brief that varies could smuggle the secret. */
const CHILD_BRIEF =
  'State the passphrase you were told earlier in this conversation, on one line, in the form ' +
  'PASSPHRASE=<value>. If you were never told one, reply PASSPHRASE=none. Use no tools.'

const parentPrompt = (secret: string, name: string, inherit: boolean): string =>
  `Remember this: the passphrase is ${secret}. Now do exactly two tool calls and nothing else. ` +
  'First call chat_register with name "forkparent" and working_on "fork probe". Then call agent_spawn ' +
  `with name "${name}", profile "explorer", surface "headless", isolation "none"` +
  `${inherit ? ', inherit "context"' : ''}, and brief exactly this text between the markers: ` +
  `<<<${CHILD_BRIEF}>>>. Do not put the passphrase in the brief. Then reply SPAWNED.`

interface ProbeResult {
  secret: string
  child: SpawnedChild | undefined
  /** The tail of the parent's own output, named in every failure about the child. */
  parentSaid: string
  /** The child's own transcript, or undefined if it never wrote one. */
  transcript: string | undefined
  said: string
  planArgs: string[]
  parentTranscript: string
}

/**
 * One end-to-end run: a real parent session, a real broker over its own unix
 * socket, and a real child spawned through `agent_spawn`.
 */
async function probe(inherit: boolean): Promise<ProbeResult> {
  const home = newHome()
  const parentSession = crypto.randomUUID()
  const secret = `passphrase-${crypto.randomUUID().slice(0, 8)}`
  const name = inherit ? 'forkchild' : 'plainchild'

  await runParent(home, parentSession, parentPrompt(secret, name, inherit))
  expect(
    registered(home, parentSession),
    'the parent session never registered, so nothing could be forked',
  ).toBe(true)

  const child = await waitFor(() => spawnedRow(home, name), 60_000)

  const transcript =
    child === undefined
      ? undefined
      : await waitFor(() => {
          const found = findTranscript(child.cwd, child.sessionId)
          return found.exists ? found.path : undefined
        }, 180_000)
  // The child answers in one short turn; give it time to write that turn out.
  if (transcript !== undefined) await sleep(30_000)

  const plan = child === undefined ? undefined : path.join(home, 'agents', child.agentId, 'plan.json')
  const planArgs =
    plan !== undefined && fs.existsSync(plan)
      ? ((JSON.parse(fs.readFileSync(plan, 'utf8')) as { args?: string[] }).args ?? [])
      : []

  return {
    secret,
    child,
    parentSaid: parentTail(home),
    transcript,
    said: transcript === undefined ? '' : assistantText(transcript),
    planArgs,
    parentTranscript: findTranscript(home, parentSession).path,
  }
}

afterAll(async () => {
  for (const child of started.splice(0)) {
    // Only ever processes this file started.
    if (child.pid !== undefined) {
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {
        // already exited, which is the expected case for a finished probe
      }
    }
  }
  for (const home of homes.splice(0)) {
    await reapBroker(home)
    fs.rmSync(home, { recursive: true, force: true })
  }
})

describe.skipIf(!LIVE)('a fork, against a real claude', () => {
  it('starts holding the parent conversation, not just the brief it was handed', async () => {
    const result = await probe(true)

    expect(
      result.child,
      `no agent_spawned row; the parent never spawned the fork. It said: ${result.parentSaid}`,
    ).toBeDefined()
    expect(result.child?.inherit).toBe('context')

    // The BEHAVIOUR first, deliberately ahead of the argv below: this is the
    // assertion that fails when the flags are removed, and a test whose first
    // failure is "--fork-session missing" would only ever have proved the argv.
    //
    // INCONCLUSIVE, NOT PASSING, if the parent wrote the secret into the brief.
    expect(
      result.child?.brief.includes(result.secret),
      'the parent leaked the passphrase into the brief, so the child knowing it proves nothing',
    ).toBe(false)
    expect(result.transcript, 'the child never wrote a transcript').toBeDefined()
    expect(
      result.said,
      `the fork could not produce a passphrase it was never told; transcript ${result.transcript}`,
    ).toContain(result.secret)

    // And the argv that produced it, stated once so a reader knows exactly what
    // shape was run.
    expect(result.planArgs).toContain('--fork-session')
    expect(result.planArgs[result.planArgs.indexOf('--resume') + 1]).toBe(result.parentTranscript)
    expect(result.planArgs[result.planArgs.indexOf('--session-id') + 1]).toBe(result.child?.sessionId)
  }, 600_000)

  it('knows nothing of the parent without inherit — the control that proves the arm above', async () => {
    const result = await probe(false)

    expect(
      result.child,
      `no agent_spawned row; the parent never spawned the control child. It said: ${result.parentSaid}`,
    ).toBeDefined()
    expect(result.child?.inherit).toBe('')
    expect(result.planArgs).not.toContain('--fork-session')
    // It ANSWERED, and answered without the secret. "Did not say the secret" on
    // its own also passes for a child that never spoke at all.
    expect(result.said, `the control child never answered; transcript ${result.transcript}`).toContain(
      'PASSPHRASE=',
    )
    expect(
      result.said,
      `a child that inherited nothing produced the passphrase; transcript ${result.transcript}`,
    ).not.toContain(result.secret)
  }, 600_000)
})
