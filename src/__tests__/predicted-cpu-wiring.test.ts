import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Conn } from '../broker/core.js'
import { resolveMachineLimits } from '../config.js'
import type { ServerMessage } from '../protocol.js'

const readings = vi.hoisted(() => ({ cpu: null as { someAvg60: number } | null }))

vi.mock('../agents/machine-guard.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../agents/machine-guard.js')>()),
  readMemoryFree: () => ({ freePercent: 90 }),
  readCpuPressure: () => readings.cpu,
}))

const { openServices } = await import('../broker/daemon.js')

const homes: string[] = []

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  readings.cpu = null
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the broker wiring of predicted-cost admission', () => {
  it('refuses a spawn on predicted CPU when pressure alone is still under the limit', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'predicted-cpu-'))
    homes.push(home)
    process.env.AGENT_CHAT_HOME = home
    const limit = resolveMachineLimits().cpuPressurePercent
    if (limit === null) throw new Error('the default CPU pressure limit is on')
    readings.cpu = { someAvg60: limit - 0.01 }
    const services = openServices(true)
    try {
      // CC-1743: awaits the reply itself. expect.poll gave up after its 1 s default under load,
      // and closed the log under the spawn still running.
      let answer: (frame: ServerMessage) => void = () => undefined
      const reply = new Promise<ServerMessage>(resolve => (answer = resolve))
      const conn = { write: (line: string) => answer(JSON.parse(line) as ServerMessage) } as unknown as Conn

      services.socketServer.handleMessage(conn, {
        t: 'spawn',
        name: 'probe',
        profile: 'implementer',
        brief: 'x',
      } as never)

      expect(await reply).toMatchObject({ t: 'spawn_result', ok: false, code: 'machine_predicted_cpu' })
    } finally {
      services.socketServer.close()
      services.core.close()
    }
  })
})
