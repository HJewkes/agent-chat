import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { HealthPayload } from '../api-contract.js'
import type { Conn } from '../broker/core.js'
import { BrokerCore } from '../broker/core.js'
import { bindHttp } from '../broker/daemon.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { HUMAN } from '../protocol.js'

/**
 * The port bind, against a real socket.
 *
 * The behaviour worth a real listener rather than a mock is the tolerance: in
 * the reference implementation the daemon IS the port, so a failed bind is
 * fatal. Here the unix socket is the service and the port hosts a dashboard, so
 * `EADDRINUSE` must be logged and swallowed — messaging can never fail because
 * something else got to 7600 first.
 *
 * `bindHttp` logs through `logEvent`, which writes to `AGENT_CHAT_HOME`'s
 * `broker.log` — the real user's, unless we point it elsewhere. Every other
 * test file that exercises broker code does this; skipping it here was how a
 * `vitest` run ended up writing fake `http_started`/`EADDRINUSE` noise into a
 * live user's dashboard log (CC-70).
 */

const tmpDirs: string[] = []
const closers: Array<() => Promise<void> | void> = []
const previousHome = process.env.AGENT_CHAT_HOME

function makeCore(): BrokerCore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-daemon-'))
  tmpDirs.push(dir)
  process.env.AGENT_CHAT_HOME = dir
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
  closers.push(() => core.close())
  return core
}

/** A listener on an OS-assigned port, so the test never fights a real service. */
async function occupyPort(): Promise<number> {
  const squatter = net.createServer()
  await new Promise<void>(resolve => squatter.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise<void>(resolve => squatter.close(() => resolve())))
  return (squatter.address() as AddressInfo).port
}

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.AGENT_CHAT_HOME
  else process.env.AGENT_CHAT_HOME = previousHome
})

describe('bindHttp', () => {
  it('binds loopback and serves /health on the port it actually got', async () => {
    const core = makeCore()
    core.append({ kind: 'question', actor: 'alpha', target: HUMAN, body: 'blocked' })

    const bound = await bindHttp(core, 0)
    expect(bound).not.toBeNull()
    closers.push(() => new Promise<void>(resolve => bound!.server.close(() => resolve())))

    const res = await fetch(`http://127.0.0.1:${bound!.port}/health`)
    const health = (await res.json()) as HealthPayload

    expect(health.ok).toBe(true)
    // The port the app reports is read through a getter, so it must be the one
    // the listener got rather than the one we asked for.
    expect(health.port).toBe(bound!.port)
    expect(health.queue_open).toBe(1)
  })

  it('returns null on EADDRINUSE instead of throwing, so the socket keeps serving', async () => {
    const taken = await occupyPort()
    expect(await bindHttp(makeCore(), taken)).toBeNull()
  })

  it('leaves the broker usable after a refused bind', async () => {
    const taken = await occupyPort()
    const core = makeCore()

    expect(await bindHttp(core, taken)).toBeNull()

    // The log is what messaging runs on, and nothing about a busy port touches it.
    const written = core.append({ kind: 'notice', actor: 'alpha', target: HUMAN, body: 'still working' })
    expect(core.events.isOpen(written.msgId)).toBe(true)
  })
})
