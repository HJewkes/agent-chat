import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { reapBroker } from './broker-harness.js'
import { EventLog } from '../broker/event-log.js'
import { encode, lineReader, type ClientMessage, type ServerMessage } from '../protocol.js'

/**
 * CC-524 over the real wire: the recovery is hooked into the SOCKET layer's register
 * path, and `handoff last` reads the log from a separate process, so a test of the
 * core alone would pass with either one unplugged.
 *
 * Runs against built output, so `npm run build` must have happened first.
 */

const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-hwire-'))
const SOCKET = path.join(TEST_HOME, 'chat.sock')
const HANDOFF = 'mid-way through the migration\nstep 3 failed twice'

const open: net.Socket[] = []

/** A log holding one handoff whose predecessor stood down and whose successor never attached. */
function seedOrphanedHandoff(): void {
  const log = new EventLog(path.join(TEST_HOME, 'events.db'))
  log.append({
    kind: 'agent_handoff',
    actor: 'lead',
    ref: 'pred-1',
    body: HANDOFF,
    meta: { successor: 'succ-1' },
  })
  log.append({ kind: 'agent_stood_down', actor: 'lead', ref: 'pred-1' })
  log.close()
}

/** Registers `name` on a fresh connection and collects every frame the broker sends it. */
async function registerAndListen(name: string): Promise<ServerMessage[]> {
  const socket = net.connect(SOCKET)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  open.push(socket)
  const frames: ServerMessage[] = []
  socket.on(
    'data',
    lineReader<ServerMessage>(
      msg => void frames.push(msg),
      () => undefined,
    ),
  )
  const register: ClientMessage = { t: 'register', name, workingOn: 'w', cwd: TEST_HOME, pid: process.pid }
  socket.write(encode(register))
  return frames
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1)
    await new Promise(resolve => setTimeout(resolve, 50))
}

/** Long enough for the broker to drop a closed socket, or to push a frame it was going to push. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 300))

const deliveries = (frames: ServerMessage[]): string[] =>
  frames.flatMap(f => (f.t === 'deliver' ? [f.message.text] : []))

beforeAll(async () => {
  seedOrphanedHandoff()
  const broker = spawn(process.execPath, [CLI, 'broker'], {
    env: { ...process.env, AGENT_CHAT_HOME: TEST_HOME },
    detached: true,
    stdio: 'ignore',
  })
  broker.unref()
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (fs.existsSync(SOCKET)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('broker never bound its socket')
}, 20_000)

afterAll(async () => {
  for (const socket of open) socket.destroy()
  await reapBroker(TEST_HOME)
  fs.rmSync(TEST_HOME, { recursive: true, force: true })
})

describe('an undelivered handoff, over the wire', () => {
  it('is printed by `handoff last` from a separate process', () => {
    const run = spawnSync(process.execPath, [CLI, 'handoff', 'last', 'lead'], {
      env: { ...process.env, AGENT_CHAT_HOME: TEST_HOME },
      encoding: 'utf8',
    })

    expect(run.status).toBe(0)
    expect(run.stdout).toContain('its successor succ-1 never registered')
    expect(run.stdout).toContain(HANDOFF)
  })

  it('is pushed to the session that registers the name, and not to the next one that does', async () => {
    const first = await registerAndListen('lead')
    await until(() => deliveries(first).length > 0)

    expect(first.find(f => f.t === 'register_result')).toMatchObject({ ok: true })
    expect(deliveries(first)).toHaveLength(1)
    expect(deliveries(first)[0]).toContain(HANDOFF)
    expect(deliveries(first)[0]).toContain('you registered the name lead')

    open.pop()?.destroy()
    await settle()
    const second = await registerAndListen('lead')
    await until(() => second.some(f => f.t === 'register_result'))
    await settle()

    expect(second.find(f => f.t === 'register_result')).toMatchObject({ ok: true })
    expect(deliveries(second)).toEqual([])
  })
})
