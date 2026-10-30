import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { HUMAN_ROOT } from '../broker/integrity-ledger.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type * as LeakIntegrity from '../cli/verbs/leak-integrity.js'
import type * as LeakPretool from '../cli/verbs/leak-pretool.js'
import {
  integrityDenial,
  INTEGRITY_DEADLINE_MS,
  UNREACHABLE,
  type CollectRecords,
} from '../cli/verbs/leak-integrity.js'
import { leakPosttool } from '../cli/verbs/leak-pretool.js'
import { currentRecords, startupRecords } from '../leak-guard/integrity/env-records.js'
import { MAX_HASH_BYTES, recordOf } from '../leak-guard/integrity/record.js'

/** TP-4256 A3b: the hook verbs `pretool|posttool --integrity`. Paths are synthetic temp dirs. */

const NONCE = 'd'.repeat(64)
/** The worker's collection, run in-process: a worker needs the built file, which source-level tests do not have. */
const inline: CollectRecords = async (session, env) => currentRecords(session, env)
const ok = async () => ({ t: 'integrity_result', ok: true }) as const
const DIST = path.resolve(import.meta.dirname, '../../dist')
const CLI = path.join(DIST, 'cli.js')
const dirs: string[] = []
const servers: SocketServer[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tmpdir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-integrity-')))
  dirs.push(dir)
  return dir
}

describe('the hook check never allows on failure', () => {
  const raw = JSON.stringify({ session_id: 's1' })
  const env = (): NodeJS.ProcessEnv => ({ HOME: tmpdir() })

  // Mutation caught: an integrity error routed through onFailOpen, which allows the call.
  it('denies when the broker is down', async () => {
    const down = () => Promise.reject(new Error('could not reach or start the agent-chat broker'))

    expect(await integrityDenial(NONCE, raw, env(), down, INTEGRITY_DEADLINE_MS, inline)).toBe(UNREACHABLE)
  })

  it('denies when the broker does not answer by the deadline', async () => {
    const silent = () => new Promise<never>(() => undefined)

    expect(await integrityDenial(NONCE, raw, env(), silent, 20, inline)).toBe(UNREACHABLE)
  })

  it('denies when collecting the records crashes', async () => {
    const crash: CollectRecords = () => Promise.reject(new Error('records worker exited 1'))

    expect(await integrityDenial(NONCE, raw, env(), ok, INTEGRITY_DEADLINE_MS, crash)).toBe(UNREACHABLE)
  })

  // Mutation caught: the records collected on the hook's own thread, ahead of the deadline timer.
  it('denies at the deadline while the real worker walks a 50k-entry snapshot dir', async () => {
    const home = tmpdir()
    const snapshots = path.join(home, '.claude', 'shell-snapshots')
    fs.mkdirSync(snapshots, { recursive: true })
    for (let i = 0; i < 50_000; i++) fs.writeFileSync(path.join(snapshots, `snapshot-${i}.sh`), '')
    const built = (await import(path.join(DIST, 'cli/verbs/leak-integrity.js'))) as typeof LeakIntegrity

    const out = await built.integrityDenial(NONCE, raw, { HOME: home }, ok, 200)

    expect(out).toBe(built.UNREACHABLE)
  }, 60_000)
})

function hookIo(raw: string) {
  const written: string[] = []
  const io = {
    readInput: async () => raw,
    write: (text: string, done: () => void) => void (written.push(text), done()),
    exit: () => undefined,
  }
  return { written, io }
}

describe('the hook verbs', () => {
  // Mutation caught: posttool exiting 0 without telling the model.
  it('posttool prints decision block with the reason on a mismatch', async () => {
    const { written, io } = hookIo(JSON.stringify({ session_id: 's1' }))

    await leakPosttool(NONCE, io, async () => 'leak-guard: /x/.zshrc changed')

    expect(written.map(line => JSON.parse(line))).toEqual([
      { decision: 'block', reason: 'leak-guard: /x/.zshrc changed' },
    ])
  })

  it('pretool without --integrity writes exactly what the guard alone writes', async () => {
    const built = (await import(path.join(DIST, 'cli/verbs/leak-pretool.js'))) as typeof LeakPretool
    const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --no-verify' } })
    const { written, io } = hookIo(raw)
    const check = vi.fn(async () => 'never')

    await built.leakPretool(io, undefined, check)

    expect(check).not.toHaveBeenCalled()
    expect(written).toEqual([`${await built.decidePretool(raw, path.join(tmpdir(), 'guard.log'))}\n`])
  })
})

describe('a file recorded for the hook', () => {
  it('is hashed up to the cap and only stat-recorded past it', () => {
    const dir = tmpdir()
    const small = path.join(dir, 'snapshot-small.sh')
    const giant = path.join(dir, 'snapshot-giant.sh')
    fs.writeFileSync(small, 'export A=1\n')
    fs.writeFileSync(giant, '')
    fs.truncateSync(giant, MAX_HASH_BYTES + 1)

    const [hashed, unhashed] = [recordOf(small, 'session'), recordOf(giant, 'session')]

    expect(hashed).toMatchObject({ state: 'present', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(unhashed).toMatchObject({ state: 'present', lstat: { size: String(MAX_HASH_BYTES + 1) } })
    expect(unhashed).not.toHaveProperty('sha256')
  })

  // Mutation caught: an unbounded read. A procfs file stats at size 0 and then reads non-empty, as a file grown after its fstat does.
  it.skipIf(!fs.existsSync('/proc/version'))('is left unhashed when it reads longer than its fstat', () => {
    expect(recordOf('/proc/version', 'startup')).not.toHaveProperty('sha256')
  })
})

/** The built CLI as Claude Code runs it, against a broker listening on a synthetic AGENT_CHAT_HOME. */
function runHook(args: string[], acHome: string, home: string): Promise<string> {
  const child = spawn(process.execPath, [CLI, 'leak-guard', ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: home, AGENT_CHAT_HOME: acHome },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  child.stdin.end(
    JSON.stringify({ session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/repo/a' } }),
  )
  let out = ''
  child.stdout.on('data', chunk => (out += String(chunk)))
  return new Promise(resolve => child.on('close', () => resolve(out)))
}

async function listeningBroker(home: string) {
  const acHome = path.join(home, '.agent-chat')
  fs.mkdirSync(acHome, { recursive: true })
  vi.stubEnv('AGENT_CHAT_HOME', acHome)
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  const server = new SocketServer(core)
  servers.push(server)
  const listener = net.createServer(socket => server.onConnection(socket as unknown as Conn))
  await new Promise<void>(resolve => listener.listen(path.join(acHome, 'chat.sock'), resolve))
  return { acHome, server, close: () => listener.close() }
}

describe('the built hook verbs over a live socket', () => {
  it('pretool allows a clean call, posttool blocks once .zshrc changed, then pretool denies; an unminted nonce denies', async () => {
    const home = tmpdir()
    fs.writeFileSync(path.join(home, '.zshrc'), 'alias ll=ls\n')
    const broker = await listeningBroker(home)
    const settings = path.join(home, 'settings.json')
    fs.writeFileSync(settings, '{}')
    const startup = startupRecords({ HOME: home })
    const { nonce } = broker.server.integrity.admit({ agentId: 'a1', parent: HUMAN_ROOT }, () => ({
      startup,
      files: [settings],
    }))

    try {
      const clean = await runHook(['pretool', '--integrity', nonce], broker.acHome, home)
      fs.appendFileSync(path.join(home, '.zshrc'), 'alias ls=rm\n')
      const after = await runHook(['posttool', '--integrity', nonce], broker.acHome, home)
      const denied = await runHook(['pretool', '--integrity', nonce], broker.acHome, home)
      const unminted = await runHook(['pretool', '--integrity', NONCE], broker.acHome, home)

      expect(clean).toBe('')
      expect(JSON.parse(unminted).hookSpecificOutput.permissionDecisionReason).toContain('no baseline')
      expect(JSON.parse(after)).toMatchObject({
        decision: 'block',
        reason: expect.stringContaining('.zshrc changed'),
      })
      expect(JSON.parse(denied).hookSpecificOutput).toMatchObject({
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('quarantined'),
      })
    } finally {
      broker.close()
    }
  })

  it('pretool denies with no broker listening', { timeout: 30_000 }, async () => {
    const home = tmpdir()

    const out = await runHook(['pretool', '--integrity', NONCE], path.join(home, '.agent-chat'), home)

    expect(JSON.parse(out).hookSpecificOutput.permissionDecisionReason).toBe(UNREACHABLE)
  })
})
