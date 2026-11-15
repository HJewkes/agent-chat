import { describe, expect, it, vi } from 'vitest'
import { watchdogLines } from '../agents/seats/sub-pass.js'

const seatsPass = async (): Promise<string[]> => ['seat-a: idle, no wake']

describe('the watchdog sub-passes', () => {
  it('prints the seats lines and a failed line when the detached pass throws', async () => {
    const detached = {
      label: 'detached',
      run: async (): Promise<string[]> => {
        throw new Error('broker did not answer agents')
      },
    }

    const lines = await watchdogLines(seatsPass, [detached], false)

    expect(lines).toEqual(['seat-a: idle, no wake', 'detached: failed: broker did not answer agents'])
  })

  it('skips every sub-pass on a run that names its seats', async () => {
    const run = vi.fn(async () => ['detached: 0 candidates, 0 due, 0 noticed'])

    const lines = await watchdogLines(seatsPass, [{ label: 'detached', run }], true)

    expect(lines).toEqual(['seat-a: idle, no wake'])
    expect(run).not.toHaveBeenCalled()
  })
})
