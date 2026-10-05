import { describe, expect, it } from 'vitest'
import { wakeSource } from '../protocol.js'

describe('wakeSource', () => {
  it('accepts watchdog and shepherd', () => {
    expect([wakeSource('watchdog'), wakeSource('shepherd')]).toEqual(['watchdog', 'shepherd'])
  })

  it('rejects an unknown source instead of passing it through or defaulting to watchdog', () => {
    expect([wakeSource('owner-approved'), wakeSource(undefined), wakeSource(42)]).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })
})
