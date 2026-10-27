import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildHookSettings,
  hookSettingsPath,
  writeLaunchFiles,
  type LaunchIntegrity,
} from '../agents/launch-files.js'
import { buildLaunchPlan } from '../agents/launch-plan.js'
import { relaunchRefusal } from '../agents/relaunch-integrity.js'
import type { AgentProfile } from '../agents/types.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import {
  integrityDenial,
  INTEGRITY_DEADLINE_MS,
  UNREACHABLE,
  type CollectRecords,
} from '../cli/verbs/leak-integrity.js'
import { currentRecords } from '../leak-guard/integrity/env-records.js'
import { MAX_HASH_BYTES, recordOf, type Records } from '../leak-guard/integrity/record.js'

/** TP-4256 A3: the hook settings, the launcher's registration, and the hook's broker check. Paths are synthetic. */

const NONCE = 'd'.repeat(64)
/** The worker's collection, run in-process: a worker needs the built file, which source-level tests do not have. */
const inline: CollectRecords = async (session, env) => currentRecords(session, env)
const MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit'
const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
const dirs: string[] = []
const servers: SocketServer[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tmpdir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-integrity-hook-')))
  dirs.push(dir)
  return dir
}

type Hooks = Record<string, { matcher?: string; hooks: { command: string; timeout: number }[] }[]>

const hooksOf = (settings: Record<string, unknown>): Hooks =>
  JSON.parse(JSON.stringify(settings).replaceAll(process.execPath, 'NODE')).hooks as Hooks

const profile: AgentProfile = {
  name: 'test',
  description: 'a profile',
  model: 'sonnet',
  allowedTools: ['Read'],
  isolation: 'none',
  surface: 'headless',
  promptPrelude: 'Be brief.',
}

const plan = () =>
  buildLaunchPlan({
    agentId: 'ag000001',
    sessionId: '00000000-0000-4000-8000-000000000001',
    name: 'scout',
    profile,
    brief: 'find every caller of foo()',
    cwd: '/repo',
    cwdHoldsUserSettings: false,
    adopted: false,
    mcpConfigPath: '/state/agents/ag000001/mcp.json',
  })

describe('the hook settings of a launch with an integrity nonce', () => {
  it('put --integrity on the guard and add a posttool twin with the same matcher', () => {
    for (const timeout of [undefined, 1800]) {
      const hooks = hooksOf(buildHookSettings('/e/cli.js', timeout, undefined, 'a1', undefined, NONCE))

      expect(hooks.PreToolUse?.[0]).toEqual({
        matcher: MATCHER,
        hooks: [
          {
            type: 'command',
            command: `'NODE' '/e/cli.js' leak-guard pretool --integrity '${NONCE}'`,
            timeout: 15,
          },
        ],
      })
      expect(hooks.PostToolUse?.at(-1)).toEqual({
        matcher: MATCHER,
        hooks: [
          {
            type: 'command',
            command: `'NODE' '/e/cli.js' leak-guard posttool --integrity '${NONCE}'`,
            timeout: 15,
          },
        ],
      })
    }
  })

  it('stay as before without a nonce, so an owner session and an old settings file skip the check', () => {
    const hooks = hooksOf(buildHookSettings('/e/cli.js', undefined, undefined, 'a1'))

    expect(hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe(`'NODE' '/e/cli.js' leak-guard pretool`)
    expect(JSON.stringify(hooks)).not.toContain('--integrity')
    expect(JSON.stringify(hooks)).not.toContain('posttool')
  })
})

describe('writeLaunchFiles with the broker integrity port', () => {
  const recorder = () => {
    const calls: { nonce: string; agentId: string; startup: Records; files: readonly string[] }[] = []
    const port: LaunchIntegrity = {
      retire: () => undefined,
      register: (nonce, agentId, startup, files) => calls.push({ nonce, agentId, startup, files }),
      quarantineOf: () => undefined,
    }
    return { calls, port }
  }

  it('mints a 32-byte nonce per call and registers it with every file it wrote', () => {
    const home = tmpdir()
    fs.writeFileSync(path.join(home, '.zshrc'), 'alias ll=ls\n')
    vi.stubEnv('AGENT_CHAT_HOME', path.join(home, '.agent-chat'))
    vi.stubEnv('HOME', home)
    const { calls, port } = recorder()

    writeLaunchFiles(plan(), {}, undefined, { port, lineage: { from: [] } })
    writeLaunchFiles(plan(), {}, undefined, { port, lineage: { from: [] } })

    const [first, second] = calls
    expect(calls).toHaveLength(2)
    expect(first?.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(second?.nonce).not.toBe(first?.nonce)
    expect(first?.agentId).toBe('ag000001')
    expect(first?.files.map(file => path.basename(file))).toEqual([
      'settings.json',
      'mcp.json',
      'plan.json',
      'relaunch',
    ])
    for (const file of first?.files ?? []) expect(fs.existsSync(file)).toBe(true)
    expect(first?.startup[path.join(home, '.zshrc')]).toMatchObject({ kind: 'startup', state: 'present' })
    expect(fs.readFileSync(hookSettingsPath('ag000001'), 'utf8')).toContain(`--integrity '${second?.nonce}'`)
  })

  it('writes no --integrity when no port is passed, as a launch written off the broker', () => {
    vi.stubEnv('AGENT_CHAT_HOME', tmpdir())

    writeLaunchFiles(plan(), {})

    expect(fs.readFileSync(hookSettingsPath('ag000001'), 'utf8')).not.toContain('--integrity')
  })
})

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

  it('lets a call through only on an ok answer', async () => {
    const ok = async () => ({ t: 'integrity_result', ok: true }) as const

    expect(await integrityDenial(NONCE, raw, env(), ok, INTEGRITY_DEADLINE_MS, inline)).toBeUndefined()
  })

  // Mutation caught: the records collected on the hook's own thread, ahead of the deadline timer.
  it('denies at the deadline when collecting the records never ends', async () => {
    const ok = async () => ({ t: 'integrity_result', ok: true }) as const
    const stuck: CollectRecords = () => new Promise<never>(() => undefined)

    expect(await integrityDenial(NONCE, raw, env(), ok, 20, stuck)).toBe(UNREACHABLE)
  })
})

describe('a file recorded for the hook', () => {
  it('is hashed up to the cap and only stat-recorded past it, so a sparse giant costs no read', () => {
    const dir = tmpdir()
    const small = path.join(dir, 'snapshot-small.sh')
    const giant = path.join(dir, 'snapshot-giant.sh')
    fs.writeFileSync(small, 'export A=1\n')
    fs.writeFileSync(giant, '')
    fs.truncateSync(giant, MAX_HASH_BYTES + 1)

    const started = Date.now()
    const [hashed, unhashed] = [recordOf(small, 'session'), recordOf(giant, 'session')]

    expect(hashed).toMatchObject({ state: 'present', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(unhashed).toMatchObject({ state: 'present', lstat: { size: String(MAX_HASH_BYTES + 1) } })
    expect(unhashed).not.toHaveProperty('sha256')
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('the relaunch check', () => {
  it('starts the launch, with a line on stderr, when the broker cannot be reached', async () => {
    const lines: string[] = []

    const refusal = await relaunchRefusal(
      'ag000001',
      () => Promise.reject(new Error('down')),
      line => lines.push(line),
    )

    expect(refusal).toBeUndefined()
    expect(lines.join('')).toContain('integrity relaunch check skipped: down')
  })
})

/** The built CLI as Claude Code runs it, against a broker listening on a synthetic AGENT_CHAT_HOME. */
function runHook(args: string[], acHome: string, home: string): Promise<string> {
  const child = spawn(process.execPath, [CLI, 'leak-guard', ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: home, AGENT_CHAT_HOME: acHome },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  child.stdin.end(
    JSON.stringify({
      session_id: 's1',
      tool_name: 'Read',
      tool_input: { file_path: '/repo/a' },
      cwd: '/repo',
    }),
  )
  let out = ''
  child.stdout.on('data', chunk => (out += String(chunk)))
  return new Promise(resolve => child.on('close', () => resolve(out)))
}

async function listeningBroker(home: string) {
  const acHome = path.join(home, '.agent-chat')
  fs.mkdirSync(acHome, { recursive: true })
  vi.stubEnv('AGENT_CHAT_HOME', acHome)
  vi.stubEnv('HOME', home)
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
  it('pretool allows a clean call, and posttool blocks once a startup file changed', async () => {
    const home = tmpdir()
    fs.writeFileSync(path.join(home, '.zshrc'), 'alias ll=ls\n')
    const broker = await listeningBroker(home)
    writeLaunchFiles(plan(), {}, undefined, { port: broker.server.launchIntegrity, lineage: { from: [] } })
    const nonce =
      /--integrity '([0-9a-f]{64})'/.exec(fs.readFileSync(hookSettingsPath('ag000001'), 'utf8'))?.[1] ?? ''

    try {
      const clean = await runHook(['pretool', '--integrity', nonce], broker.acHome, home)
      fs.appendFileSync(path.join(home, '.zshrc'), 'alias ls=rm\n')
      const after = await runHook(['posttool', '--integrity', nonce], broker.acHome, home)
      const denied = await runHook(['pretool', '--integrity', nonce], broker.acHome, home)

      expect(clean).toBe('')
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
