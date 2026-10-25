import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { CALLER_AGENT_MAX, SocketServer, sanitizeCallerAgent } from '../broker/socket.js'
import type { PeerPorts } from '../broker/peer-locality.js'
import { ProfileBaseline, type ProfileDriftMode } from '../agents/profile-baseline.js'
import { PortSpawnFrame } from '../cli/verbs/port-agent.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/** CC-1206 c: an agent's CLI spawn with no `spawnedAs` is not the human's for profile drift. */

type SpawnResult = Extract<ServerMessage, { t: 'spawn_result' }>

const tmpDirs: string[] = []
let home: string
let core: BrokerCore
let server: SocketServer | undefined
let stopAutoAttach: () => void

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

const profileFile = (name: string): string => path.join(home, 'profiles', `${name}.json`)

function writeProfile(name: string, description = name): void {
  const profile = {
    description,
    model: 'sonnet',
    allowedTools: ['Read'],
    isolation: 'none',
    surface: 'headless',
  }
  fs.writeFileSync(profileFile(name), JSON.stringify(profile))
}

type Terminals = Record<number, { session: number; ttyNr: number }>

/** A peer pid and its ancestry, as `peer-locality.test.ts` builds them. */
const tree = (
  procs: Record<number, [number, string]>,
  peer: number | undefined,
  terminals?: Terminals,
): PeerPorts => ({
  peerPid: vi.fn(() => peer),
  argv: pid => (procs[pid] === undefined ? undefined : `/usr/bin/${procs[pid]![1]} --flag`),
  process: pid => (procs[pid] === undefined ? undefined : { ppid: procs[pid]![0], comm: procs[pid]![1] }),
  terminal: pid => (terminals ?? ON_PTS)[pid],
})
const UNDER_CLAUDE = { 700: [650, 'bash'], 650: [500, 'claude'], 500: [1, 'zsh'] } as Record<
  number,
  [number, string]
>
/** CC-1246: the CLI under an interactive zsh that leads its session on a pty, in a tmux pane. */
const PLAIN_TERMINAL = { 700: [650, 'node'], 650: [600, 'zsh'], 600: [1, 'tmux'] } as Record<
  number,
  [number, string]
>
const ON_PTS: Terminals = { 700: { session: 650, ttyNr: 34816 }, 650: { session: 650, ttyNr: 34816 } }

function start(mode: ProfileDriftMode, ports: PeerPorts): (msg: ClientMessage) => Promise<SpawnResult> {
  server?.close()
  server = new SocketServer(
    core,
    {
      cwdLister: async () => [],
      profileBaseline: new ProfileBaseline(path.join(home, 'profiles')),
      profileDriftMode: mode,
      surface: {
        platform: 'darwin',
        spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
      },
    },
    undefined,
    ports,
  )
  const emitter = new EventEmitter()
  const frames: ServerMessage[] = []
  const conn = Object.assign(emitter, {
    write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
  }) as unknown as Conn
  server.onConnection(conn)
  return async msg => {
    const before = frames.length
    emitter.emit('data', JSON.stringify(msg) + '\n')
    const reply = await vi.waitFor(() => {
      const found = frames
        .slice(before)
        .find(frame => frame.t === 'spawn_result' || frame.t === 'register_result')
      if (found === undefined) throw new Error('no reply yet')
      return found
    })
    return reply as SpawnResult
  }
}

const spawnFrame = (
  name: string,
  over: Partial<Extract<ClientMessage, { t: 'spawn' }>> = {},
): ClientMessage => ({
  t: 'spawn',
  name,
  profile: 'bd-implementer',
  brief: 'do the task',
  cwd: tmp('agent-cli-cwd-'),
  surface: 'headless',
  spawnerConfigDir: tmp('agent-cli-account-'),
  ...over,
})

const register = (name: string): ClientMessage => ({
  t: 'register',
  name,
  workingOn: 'x',
  cwd: home,
  pid: 1,
  sessionId: `session-${name}`,
})

const driftWarnings = (result: SpawnResult): string[] =>
  (result.warnings ?? []).filter(warning => warning.includes('after the broker started'))

const spawnedRow = (name: string) =>
  core.events.since(0, 1000).find(row => row.kind === 'agent_spawned' && row.target === name)

beforeEach(() => {
  home = tmp('agent-cli-home-')
  process.env.AGENT_CHAT_HOME = home
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  writeProfile('bd-implementer')
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  stopAutoAttach = autoAttach(core)
})

afterEach(() => {
  stopAutoAttach()
  server?.close()
  server = undefined
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('an unregistered spawn with an agent behind it (CC-1206 c)', () => {
  it('refuses a claimed agent caller under refuse, and a plain-terminal spawn still re-baselines', async () => {
    const send = start('refuse', tree(PLAIN_TERMINAL, 700))
    writeProfile('bd-implementer', 'rewritten')

    const agent = await send(spawnFrame('impl-a', { callerAgent: 'coord-a' }))
    const human = await send(spawnFrame('impl-b'))
    const after = await send(spawnFrame('impl-c', { callerAgent: 'coord-a' }))

    expect(agent.ok).toBe(false)
    expect(agent.reason).toContain(profileFile('bd-implementer'))
    expect(agent.reason).toContain('from a shell outside Claude Code')
    expect(human.ok).toBe(true)
    expect(after.ok).toBe(true)
    expect(driftWarnings(after)).toEqual([])
  })

  it('refuses a caller under a Claude Code ancestor that sent no claim', async () => {
    const send = start('refuse', tree(UNDER_CLAUDE, 700))
    writeProfile('bd-implementer', 'rewritten')

    const result = await send(spawnFrame('impl-a'))

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('from a shell outside Claude Code')
  })

  it('warns an agent caller under flag and never takes its profile as the baseline', async () => {
    const send = start('flag', tree(PLAIN_TERMINAL, 700))
    writeProfile('bd-implementer', 'rewritten')

    const first = await send(spawnFrame('impl-a', { callerAgent: 'coord-a' }))
    const second = await send(spawnFrame('impl-b', { callerAgent: 'coord-a' }))

    expect(first.ok).toBe(true)
    expect(driftWarnings(first)).toHaveLength(1)
    expect(driftWarnings(second)).toEqual([expect.stringContaining('review it before trusting its denies')])
  })

  it('records the caller on the agent_spawned row, by claim or by ancestor pid', async () => {
    const send = start('flag', tree(UNDER_CLAUDE, 700))

    await send(spawnFrame('impl-a', { callerAgent: 'coord-a' }))
    await send(spawnFrame('impl-b'))

    expect(spawnedRow('impl-a')?.meta).toMatchObject({ caller_agent: 'coord-a' })
    expect(spawnedRow('impl-b')?.meta).toMatchObject({ caller_agent: 'claude-code:650' })
    expect(spawnedRow('impl-b')?.actor).toBe('human')
  })

  it('never reads the peer for a spawnedAs spawn, and ignores its claim', async () => {
    const ports = tree(UNDER_CLAUDE, 700)
    const send = start('flag', ports)

    const result = await send(
      spawnFrame('impl-a', {
        spawnedAs: 'burndown',
        task: 'claude-channels/CC-1206',
        callerAgent: 'coord-a',
      }),
    )

    expect(result.ok).toBe(true)
    expect(ports.peerPid).not.toHaveBeenCalled()
    expect(spawnedRow('impl-a')?.meta).not.toHaveProperty('caller_agent')
  })

  it('ignores a registered connection’s claim: requestedBy stays its own name, no caller_agent', async () => {
    const ports = tree(UNDER_CLAUDE, 700)
    const send = start('flag', ports)
    expect(await send(register('coord-a'))).toMatchObject({ ok: true })

    const result = await send(spawnFrame('impl-a', { callerAgent: 'agent-x' }))

    expect(result.ok).toBe(true)
    expect(spawnedRow('impl-a')?.actor).toBe('coord-a')
    expect(spawnedRow('impl-a')?.meta).not.toHaveProperty('caller_agent')
    expect(ports.peerPid).not.toHaveBeenCalled()
  })
})

describe('an unregistered spawn with no positive proof of the human (CC-1246)', () => {
  const DETACHED = { 700: [1, 'node'] } as Record<number, [number, string]>

  it.each([
    [
      'no peer pid, as off Linux or through a forwarded socket',
      tree(PLAIN_TERMINAL, undefined),
      'no peer pid',
    ],
    [
      'no controlling tty (setsid, systemd-run --user)',
      tree(DETACHED, 700, { 700: { session: 700, ttyNr: 0 } }),
      'no controlling tty',
    ],
    [
      'the caller leading its own session (tmux new -d <cmd>)',
      tree(DETACHED, 700, { 700: { session: 700, ttyNr: 34817 } }),
      'not under its session leader',
    ],
    [
      'an orphan reparented off its session (nohup … &)',
      tree({ ...PLAIN_TERMINAL, 700: [1, 'node'] }, 700),
      'not under its session leader',
    ],
  ])('refuses %s under refuse, naming the gap', async (_case, ports, gap) => {
    const send = start('refuse', ports)
    writeProfile('bd-implementer', 'rewritten')

    const result = await send(spawnFrame('impl-a'))

    expect(result.ok).toBe(false)
    expect(result.reason).toContain(`not proven human: ${gap}`)
  })

  it('warns under flag, records the gap on the row and never takes the profile as the baseline', async () => {
    const send = start('flag', tree(PLAIN_TERMINAL, undefined))
    writeProfile('bd-implementer', 'rewritten')

    const first = await send(spawnFrame('impl-a'))
    const second = await send(spawnFrame('impl-b'))

    expect(first.ok).toBe(true)
    expect(driftWarnings(second)).toEqual([expect.stringContaining('review it before trusting its denies')])
    expect(spawnedRow('impl-a')?.meta).toMatchObject({ human_unproven: 'no peer pid' })
    expect(spawnedRow('impl-a')?.meta).not.toHaveProperty('caller_agent')
  })
})

describe('the claimed caller is sanitized before use (CC-1206 c)', () => {
  it('reads a blank or control-only claim as no claim', () => {
    expect(sanitizeCallerAgent('  ')).toBeUndefined()
    expect(sanitizeCallerAgent('\u0007\n\t‎')).toBeUndefined()
    expect(sanitizeCallerAgent(42)).toBeUndefined()
  })

  it('strips control and format characters from a claim', () => {
    expect(sanitizeCallerAgent(' coord\u001b[31m-a‮\n')).toBe('coord[31m-a')
  })

  it(`caps a claim at ${CALLER_AGENT_MAX} characters`, () => {
    expect(sanitizeCallerAgent('a'.repeat(500))).toBe('a'.repeat(CALLER_AGENT_MAX))
  })

  it('writes the sanitized claim to the row, and a blank one leaves a plain spawn human', async () => {
    const send = start('flag', tree(PLAIN_TERMINAL, 700))

    await send(spawnFrame('impl-a', { callerAgent: `coord-a\n${'x'.repeat(200)}` }))
    const blank = await send(spawnFrame('impl-b', { callerAgent: ' \u0000 ' }))

    expect(spawnedRow('impl-a')?.meta?.['caller_agent']).toBe(`coord-a${'x'.repeat(CALLER_AGENT_MAX - 7)}`)
    expect(blank.ok).toBe(true)
    expect(spawnedRow('impl-b')?.meta).not.toHaveProperty('caller_agent')
  })
})

describe('the other spawn-frame senders (CC-1206 c)', () => {
  /** The frame shape of `seat-respawn.ts`: no `spawnedAs`, no claim; `seat-respawn.test.ts` pins it exactly. */
  const watchdogFrame = (name: string): ClientMessage =>
    spawnFrame(name, { returnContract: 'none', launchedBy: 'seat-watchdog', launchReason: 'relaunch' })

  it('keeps a watchdog relaunch from a plain process human, re-baselining as before', async () => {
    const send = start('refuse', tree(PLAIN_TERMINAL, 700))
    writeProfile('bd-implementer', 'rewritten')

    const result = await send(watchdogFrame('seat-a'))

    expect(result.ok).toBe(true)
    expect(driftWarnings(result)).toEqual([expect.stringContaining('taken as the new baseline')])
    expect(spawnedRow('seat-a')?.meta).toMatchObject({ launched_by: 'seat-watchdog' })
  })

  it('treats a watchdog relaunch run under Claude Code as an agent spawn', async () => {
    const send = start('refuse', tree(UNDER_CLAUDE, 700))
    writeProfile('bd-implementer', 'rewritten')

    const result = await send(watchdogFrame('seat-a'))

    expect(result.ok).toBe(false)
  })

  it('port spawn takes no claim: its strict frame refuses callerAgent', () => {
    const frame = {
      t: 'spawn',
      name: 'impl-a',
      profile: 'bd-implementer',
      brief: 'do the task',
      cwd: '/Users/example/repo',
      configDir: '/Users/example/.claude',
      surface: 'headless',
      briefing: '',
      tags: [],
      task: 'claude-channels/CC-1206',
      spawnedAs: 'burndown',
    }

    expect(PortSpawnFrame.safeParse(frame).success).toBe(true)
    expect(PortSpawnFrame.safeParse({ ...frame, callerAgent: 'coord-a' }).success).toBe(false)
  })
})
