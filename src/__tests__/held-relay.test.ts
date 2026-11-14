import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_HELD_RELAY,
  noticeText,
  parseHeldRelay,
  pickHeld,
  type HeldItem,
  type HeldRelayConfig,
  type Notified,
} from '../agents/seats/held-relay.js'
import { runHeldRelay, type RelayPorts } from '../cli/verbs/seats-held-relay.js'

const MIN = 60_000
const NOW = Date.parse('2030-01-01T01:00:00Z')

const item = (over: Partial<HeldItem> = {}): HeldItem => ({
  recipient: 'seat-park',
  msgId: 'm1',
  from: 'peer-one',
  ts: NOW - 20 * MIN,
  body: 'Status: invented sheet ready',
  hold: 'parked',
  ...over,
})

const rules = (over: Partial<HeldRelayConfig> = {}): HeldRelayConfig => ({ ...DEFAULT_HELD_RELAY, ...over })

describe('pickHeld', () => {
  it('notices a parked recipient’s owner-facing message once, then not on the next pass', () => {
    const first = pickHeld({ items: [item()], rules: rules(), notified: {}, nowMs: NOW })
    const second = pickHeld({
      items: [item()],
      rules: rules(),
      notified: first.notified,
      nowMs: NOW + 10 * MIN,
    })

    expect(first.notify).toEqual([item()])
    expect(second.notify).toEqual([])
  })

  it('notices a still-stuck message again after renotifyMinutes', () => {
    const first = pickHeld({ items: [item()], rules: rules(), notified: {}, nowMs: NOW })

    const later = pickHeld({
      items: [item()],
      rules: rules(),
      notified: first.notified,
      nowMs: NOW + 120 * MIN,
    })

    expect(later.notify).toHaveLength(1)
  })

  it('drops an answered message from the saved state', () => {
    const notified: Notified = { 'seat-park:m1': NOW - MIN }

    expect(pickHeld({ items: [], rules: rules(), notified, nowMs: NOW }).notified).toEqual({})
  })

  it('ignores a message younger than the threshold', () => {
    const young = item({ ts: NOW - 10 * MIN })

    expect(pickHeld({ items: [young], rules: rules(), notified: {}, nowMs: NOW }).notify).toEqual([])
  })

  it('ignores a body no pattern matches, and an empty pattern list matches every body', () => {
    const chatter = item({ body: 'lunch?' })

    expect(pickHeld({ items: [chatter], rules: rules(), notified: {}, nowMs: NOW }).notify).toEqual([])
    expect(
      pickHeld({ items: [chatter], rules: rules({ patterns: [] }), notified: {}, nowMs: NOW }).notify,
    ).toEqual([chatter])
  })

  it('with heldOnly skips a recipient that is not held, and without it flags one', () => {
    const live = item({ hold: undefined })

    expect(pickHeld({ items: [live], rules: rules(), notified: {}, nowMs: NOW }).notify).toEqual([])
    expect(
      pickHeld({ items: [live], rules: rules({ heldOnly: false }), notified: {}, nowMs: NOW }).notify,
    ).toEqual([live])
  })

  it('names each parked recipient to wake once, only when wakeParked is on', () => {
    const items = [item(), item({ msgId: 'm2' }), item({ recipient: 'seat-gone', hold: 'retired' })]

    expect(pickHeld({ items, rules: rules(), notified: {}, nowMs: NOW }).wake).toEqual([])
    expect(pickHeld({ items, rules: rules({ wakeParked: true }), notified: {}, nowMs: NOW }).wake).toEqual([
      'seat-park',
    ])
  })
})

describe('noticeText', () => {
  it('names the sender, the recipient, the age and the hold', () => {
    const text = noticeText(item(), NOW)

    expect(text).toContain('Held 20 min for seat-park (parked)')
    expect(text).toContain('peer-one wrote "Status: invented sheet ready"')
  })
})

describe('parseHeldRelay', () => {
  it('defaults to disabled, with no wake of a parked coordinator', () => {
    expect(parseHeldRelay({})).toEqual(DEFAULT_HELD_RELAY)
    expect(DEFAULT_HELD_RELAY.enabled).toBe(false)
    expect(DEFAULT_HELD_RELAY.wakeParked).toBe(false)
  })

  it('rejects an invalid pattern and an unknown key', () => {
    expect(parseHeldRelay({ patterns: ['('] })).toContain('patterns.0')
    expect(typeof parseHeldRelay({ wakeAll: true })).toBe('string')
  })
})

function ports(over: Partial<HeldRelayConfig> = {}) {
  const saved: Notified[] = []
  const fake = {
    rules: rules({ enabled: true, ...over }),
    read: vi.fn(() => [item()]),
    loadState: () => ({}),
    saveState: (n: Notified) => void saved.push(n),
    notify: vi.fn(async () => ({ ok: true, detail: 'notice n1' })),
    wake: vi.fn(async () => ({ ok: true, detail: 'message w1' })),
    log: vi.fn(),
  } satisfies RelayPorts
  return { fake, saved }
}

describe('runHeldRelay', () => {
  it('files one notice and wakes nobody with the default wakeParked', async () => {
    const { fake, saved } = ports()

    const report = await runHeldRelay(fake, { dryRun: false, nowMs: NOW })

    expect(fake.notify).toHaveBeenCalledTimes(1)
    expect(fake.wake).not.toHaveBeenCalled()
    expect(saved).toEqual([{ 'seat-park:m1': NOW }])
    expect(report.lines).toEqual(['1 noticed, 0 failed, woke none'])
  })

  it('wakes the parked recipient when wakeParked is on', async () => {
    const { fake } = ports({ wakeParked: true })

    await runHeldRelay(fake, { dryRun: false, nowMs: NOW })

    expect(fake.wake).toHaveBeenCalledWith('seat-park', expect.any(String))
  })

  it('does nothing while disabled', async () => {
    const { fake, saved } = ports({ enabled: false })

    await runHeldRelay(fake, { dryRun: false, nowMs: NOW })

    expect(fake.read).not.toHaveBeenCalled()
    expect(saved).toEqual([])
  })

  it('keeps a failed notice out of the saved state so the next pass retries it', async () => {
    const { fake, saved } = ports()
    fake.notify.mockResolvedValueOnce({ ok: false, detail: 'no broker' })

    const report = await runHeldRelay(fake, { dryRun: false, nowMs: NOW })

    expect(report.ok).toBe(false)
    expect(saved).toEqual([{}])
  })

  it('on a dry run lists the item and sends, wakes and saves nothing', async () => {
    const { fake, saved } = ports({ wakeParked: true })

    const report = await runHeldRelay(fake, { dryRun: true, nowMs: NOW })

    expect(report.lines[0]).toContain('seat-park')
    expect(fake.notify).not.toHaveBeenCalled()
    expect(fake.wake).not.toHaveBeenCalled()
    expect(saved).toEqual([])
  })
})
