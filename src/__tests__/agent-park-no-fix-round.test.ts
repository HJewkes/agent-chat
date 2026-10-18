import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conn } from '../broker/core.js'
import { openServices } from '../broker/daemon.js'
import { Supervisor } from '../agents/supervisor.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/** CC-1470: `agent park --no-fix-round-check` carries the skip onto the frame, and the broker onto the park. */

const broker = vi.hoisted(() => ({ sent: [] as ClientMessage[] }))

vi.mock('../cli/client.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  withBroker: async (fn: (b: unknown) => Promise<unknown>) =>
    fn({
      request: async (frame: ClientMessage) => {
        broker.sent.push(frame)
        return { t: 'spawn_result', ok: true, reason: 'Parked.' }
      },
    }),
}))

const { buildProgram } = await import('../cli/index.js')

async function run(...argv: string[]): Promise<void> {
  const program = buildProgram()
  program.exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
  await program.parseAsync(['agent', ...argv], { from: 'user' }).catch(() => undefined)
}

const parkFrame = () => broker.sent.find(f => f.t === 'park')

describe('agent park --no-fix-round-check', () => {
  beforeEach(() => {
    broker.sent.length = 0
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterEach(() => vi.restoreAllMocks())

  it('asks the broker to skip the fix-round check', async () => {
    await run('park', 'agent-x', '--no-fix-round-check')

    expect(parkFrame()).toEqual({ t: 'park', name: 'agent-x', noFixRoundCheck: true })
  })

  it('leaves the field off the frame when the flag is omitted', async () => {
    await run('park', 'agent-x')

    expect(parkFrame()).toEqual({ t: 'park', name: 'agent-x' })
  })
})

describe('the park frame', () => {
  const tmpDirs: string[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.AGENT_CHAT_HOME
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  async function parkRequestFor(frame: ClientMessage): Promise<unknown> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'park-frame-'))
    tmpDirs.push(home)
    process.env.AGENT_CHAT_HOME = home
    const park = vi.spyOn(Supervisor.prototype, 'park').mockResolvedValue({ ok: false, reason: 'stub' })
    const services = openServices(true)
    try {
      const frames: ServerMessage[] = []
      const conn = {
        write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
      } as unknown as Conn
      services.socketServer.handleMessage(conn, frame)
      await expect.poll(() => frames.length).toBe(1)
      return park.mock.calls[0]?.[1]
    } finally {
      services.socketServer.close()
      services.core.close()
    }
  }

  it('passes noFixRoundCheck through to the park', async () => {
    const req = await parkRequestFor({ t: 'park', name: 'agent-x', noFixRoundCheck: true })

    expect(req).toMatchObject({ noFixRoundCheck: true })
  })

  it('leaves the fix-round check on when the frame omits the field', async () => {
    const req = await parkRequestFor({ t: 'park', name: 'agent-x' })

    expect(req).not.toHaveProperty('noFixRoundCheck')
  })
})
