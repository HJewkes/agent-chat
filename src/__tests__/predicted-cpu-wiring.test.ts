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
      const frames: ServerMessage[] = []
      const conn = {
        write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
      } as unknown as Conn

      services.socketServer.handleMessage(conn, {
        t: 'spawn',
        name: 'probe',
        profile: 'implementer',
        brief: 'x',
      } as never)
      await expect.poll(() => frames.length).toBe(1)

      expect(frames[0]).toMatchObject({ t: 'spawn_result', ok: false, code: 'machine_predicted_cpu' })
    } finally {
      services.socketServer.close()
      services.core.close()
    }
  })
})
