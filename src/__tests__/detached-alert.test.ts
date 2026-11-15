import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DETACHED_ALERT,
  burstFilter,
  candidateKey,
  detachedCandidates,
  noticeText,
  parseDetachedAlert,
  pickDetached,
} from '../agents/seats/detached-alert.js'
import { MAC_HOST, agentRows, at, liveRow } from './helpers/detached-rows.js'

const rules = DEFAULT_DETACHED_ALERT
const MINUTE = 60_000

const macDrop = (names: string[], detached = at('11:20:00')) =>
  names.map(name => agentRows({ name, host: MAC_HOST, detachedAt: detached, exit: 'remote-inferred' }))

const candidatesAt = (roster: ReturnType<typeof agentRows>[], now: number) =>
  detachedCandidates(roster, rules, now).map(c => c.name)

describe('detached-alert candidates', () => {
  it('pages one notice naming every Mac agent the reaper marked exited during a tunnel drop', () => {
    const roster = macDrop(['agent-a', 'agent-b', 'agent-c', 'agent-d'])

    const due = burstFilter(detachedCandidates(roster, rules, at('11:40:00')), rules)
    const text = noticeText(pickDetached(due, rules, {}, at('11:40:00')).notify, rules)

    expect(text).toBe(
      'Detached over 15 min, MCP connection to the broker gone: agent-a 20m, agent-b 20m, agent-c 20m, ' +
        `agent-d 20m (host ${MAC_HOST}, unverified). Run /mcp in each pane.`,
    )
  })

  it('counts a local detached row from 15 minutes, not before', () => {
    const roster = [agentRows({ name: 'agent-a', detachedAt: at('11:00:00') })]

    expect(candidatesAt(roster, at('11:14:59'))).toEqual([])
    expect(candidatesAt(roster, at('11:15:00'))).toEqual(['agent-a'])
  })

  it('never counts a real exit', () => {
    const roster = [agentRows({ name: 'agent-a', host: MAC_HOST, detachedAt: at('11:00:00'), exit: 'real' })]

    expect(candidatesAt(roster, at('11:40:00'))).toEqual([])
  })

  it('never counts an inferred exit the broker proved by probing its own host', () => {
    const roster = [agentRows({ name: 'agent-a', detachedAt: at('11:00:00'), exit: 'local-inferred' })]

    expect(candidatesAt(roster, at('11:40:00'))).toEqual([])
  })

  it('skips a detached row whose name a live successor now holds', () => {
    const roster = [
      agentRows({ name: 'agent-a', detachedAt: at('11:00:00') }),
      liveRow('agent-a', at('11:01:00')),
    ]

    expect(candidatesAt(roster, at('11:40:00'))).toEqual([])
  })

  it('lists a lone remote row without paging it, and pages two on one host 90 s apart', () => {
    const lone = macDrop(['agent-a'])
    const pair = [...macDrop(['agent-b']), ...macDrop(['agent-c'], at('11:21:30'))]

    const loneCandidates = detachedCandidates(lone, rules, at('11:40:00'))
    const pairCandidates = detachedCandidates(pair, rules, at('11:40:00'))

    expect(loneCandidates.map(c => c.name)).toEqual(['agent-a'])
    expect(burstFilter(loneCandidates, rules)).toEqual([])
    expect(burstFilter(pairCandidates, rules).map(c => c.name)).toEqual(['agent-b', 'agent-c'])
  })

  it('counts one Mac under two host spellings as one burst', () => {
    const roster = [
      ...macDrop(['agent-a']),
      agentRows({
        name: 'agent-b',
        host: 'host-mac.localdomain',
        detachedAt: at('11:20:00'),
        exit: 'remote-inferred',
      }),
    ]

    const due = burstFilter(detachedCandidates(roster, rules, at('11:40:00')), rules)

    expect(due.map(c => c.name)).toEqual(['agent-a', 'agent-b'])
  })

  it('ignores a detach older than maxAgeHours', () => {
    const roster = [agentRows({ name: 'agent-a', detachedAt: at('11:00:00') })]

    expect(candidatesAt(roster, at('11:00:00') + 24 * 60 * MINUTE)).toEqual(['agent-a'])
    expect(candidatesAt(roster, at('11:00:00') + 24 * 60 * MINUTE + 1)).toEqual([])
  })
})

describe('detached-alert dedupe', () => {
  const due = detachedCandidates(
    [agentRows({ name: 'agent-a', detachedAt: at('10:00:00') })],
    rules,
    at('11:00:00'),
  )
  const key = candidateKey(due[0] ?? { agentId: '', detachedAt: 0 })
  const noticedAt = at('11:00:00')

  it('re-sends a notice after renotifyMinutes since the last notice, not before', () => {
    const notified = { [key]: noticedAt }

    expect(pickDetached(due, rules, notified, noticedAt + 119 * MINUTE).notify).toEqual([])
    expect(pickDetached(due, rules, notified, noticedAt + 120 * MINUTE).notify).toHaveLength(1)
  })

  it('measures renotify from the last notice, not from first sight', () => {
    const resent = pickDetached(due, rules, { [key]: noticedAt }, noticedAt + 120 * MINUTE).notified

    expect(pickDetached(due, rules, resent, noticedAt + 180 * MINUTE).notify).toEqual([])
  })

  it('drops the key of a row that reattached', () => {
    const picked = pickDetached([], rules, { [key]: noticedAt }, noticedAt + MINUTE)

    expect(picked.notified).toEqual({})
  })
})

describe('detachedAlert config', () => {
  it('is on by default with a 15 min threshold and a 2 h renotify', () => {
    expect(parseDetachedAlert({})).toMatchObject({
      enabled: true,
      thresholdMinutes: 15,
      renotifyMinutes: 120,
      maxAgeHours: 24,
      remoteBurst: 2,
    })
  })

  it('rejects an unknown key', () => {
    expect(parseDetachedAlert({ thresholdMinute: 5 })).toEqual(expect.stringContaining('thresholdMinute'))
  })
})
