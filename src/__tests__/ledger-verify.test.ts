import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExecutionTransition } from '@titan-design/agent-protocol'
import { EventLog } from '../broker/event-log.js'
import { openShadowLedger } from '../agents/ledger/shadow-ledger.js'
import { classify, type FoldEntry, type VerifyInput } from '../agents/ledger/verify.js'
import { gather } from '../agents/ledger/verifier.js'

/**
 * CC-118 slice 4: the divergence classifier. One case per class, each built from
 * a consistent input with one fact changed, so a class that widens to swallow
 * a neighbour's case fails here by name.
 */

const SHADOW_SINCE = 1_000
const BOOT = 5_000

const agent = (agentId: string, extra: Partial<FoldEntry> = {}): FoldEntry => ({
  agentId,
  name: `name-${agentId}`,
  state: 'live',
  spawnedAt: BOOT + 100,
  handedOff: false,
  ...extra,
})

const row = (agentId: string, extra: { requestKey?: string; preparedAt?: number } = {}) => ({
  executionId: `exec-${agentId}`,
  agentId,
  requestKey: extra.requestKey ?? `spawn:${agentId}`,
  preparedAt: extra.preparedAt ?? BOOT + 100,
})

/** One live agent with its row and slot, one allocation git agrees with: nothing to report. */
function consistent(): VerifyInput {
  return {
    broker: { liveIds: ['a'], slotIds: ['a'], bootAt: BOOT, shadowSince: SHADOW_SINCE },
    fold: [agent('a')],
    ledgerActive: [row('a')],
    ledgerTerminalByAgent: new Map(),
    runtimeRefs: [{ agentId: 'a', branch: 'agent-chat/name-a', gitRoot: '/repo' }],
    gitListings: [{ gitRoot: '/repo', branches: ['main', 'agent-chat/name-a'] }],
  }
}

const classes = (input: VerifyInput) => classify(input).map(d => [d.class, d.unclassified])

describe('classify', () => {
  it('a fully consistent input yields zero divergences', () => {
    expect(classify(consistent())).toEqual([])
  })

  it('reports a live agent spawned before the shadow began as live_only_pre_shadow', () => {
    const input = { ...consistent(), fold: [agent('a', { spawnedAt: SHADOW_SINCE - 1 })], ledgerActive: [] }

    expect(classes(input)).toEqual([
      ['live_only_pre_shadow', false],
      ['slot_pre_shadow', false],
    ])
  })

  it('reports a live agent spawned since the shadow began with no row as unclassified live_only', () => {
    const input = { ...consistent(), ledgerActive: [] }

    expect(classes(input)).toEqual([
      ['live_only', true],
      ['slot_without_row', true],
    ])
  })

  it('a live id whose row is terminal is unclassified', () => {
    const input = {
      ...consistent(),
      fold: [agent('a', { spawnedAt: SHADOW_SINCE - 1 })],
      ledgerActive: [],
      ledgerTerminalByAgent: new Map([['a', 'cancelled']]),
    }

    const found = classify(input)

    expect(found.map(d => d.class).sort()).toEqual(['slot_without_row', 'terminal_disagreement'])
    expect(found.every(d => d.unclassified)).toBe(true)
  })

  it('reports a pre-restart row whose agent reattached since as ledger_only_since_restart', () => {
    const input = {
      ...consistent(),
      broker: { ...consistent().broker!, liveIds: [], slotIds: ['a'] },
      fold: [agent('a', { lastAttachedAt: BOOT + 10 })],
      ledgerActive: [row('a', { preparedAt: BOOT - 10 })],
    }

    expect(classes(input)).toEqual([['ledger_only_since_restart', false]])
  })

  it('reports a pre-restart row with no presence since boot as ledger_only_detached', () => {
    const input = {
      ...consistent(),
      broker: { ...consistent().broker!, liveIds: [], slotIds: [] },
      fold: [agent('a', { state: 'detached', lastAttachedAt: BOOT - 100 })],
      ledgerActive: [row('a', { preparedAt: BOOT - 10 })],
    }

    expect(classes(input)).toEqual([['ledger_only_detached', false]])
  })

  it('reports a backfilled row as ledger_only_backfilled', () => {
    const input = {
      ...consistent(),
      broker: { ...consistent().broker!, liveIds: [], slotIds: [] },
      fold: [agent('a', { state: 'detached' })],
      ledgerActive: [row('a', { requestKey: 'backfill:a', preparedAt: BOOT - 10 })],
    }

    expect(classes(input)).toEqual([['ledger_only_backfilled', false]])
  })

  it('reports a row opened since boot for an agent the supervisor does not hold as unclassified', () => {
    const input = {
      ...consistent(),
      broker: { ...consistent().broker!, liveIds: [], slotIds: [] },
      fold: [agent('a', { state: 'detached' })],
    }

    expect(classes(input)).toEqual([['unclassified', true]])
  })

  it('reports a successor with no row after a finished, handed-off predecessor as teleport_half_written', () => {
    const input = {
      ...consistent(),
      broker: { ...consistent().broker!, liveIds: ['b'], slotIds: ['b'] },
      fold: [agent('a', { state: 'retired', handedOff: true }), agent('b', { teleportFrom: 'a' })],
      ledgerActive: [],
      ledgerTerminalByAgent: new Map([['a', 'cancelled']]),
    }

    expect(classes(input)).toEqual([
      ['teleport_half_written', false],
      ['slot_without_row', true],
    ])
  })

  it('reports a slot adopted on reattach with no row as slot_reattached_no_row', () => {
    const input = {
      ...consistent(),
      broker: { ...consistent().broker!, slotIds: ['a', 'r'] },
      fold: [agent('a'), agent('r', { spawnedAt: SHADOW_SINCE - 1 })],
    }

    expect(classes(input)).toEqual([['slot_reattached_no_row', false]])
  })

  it('reports a live agent with a row but no slot as row_without_slot', () => {
    const input = { ...consistent(), broker: { ...consistent().broker!, slotIds: [] } }

    expect(classes(input)).toEqual([['row_without_slot', false]])
  })

  it('reports runtime.json naming a branch git no longer has as allocation_absent_from_git', () => {
    const input = { ...consistent(), gitListings: [{ gitRoot: '/repo', branches: ['main'] }] }

    expect(classes(input)).toEqual([['allocation_absent_from_git', false]])
  })

  it('reports an agent-chat branch no runtime.json owns as git_branch_unowned, and ignores other branches', () => {
    const input = {
      ...consistent(),
      gitListings: [
        { gitRoot: '/repo', branches: ['main', 'feat/x', 'agent-chat/name-a', 'agent-chat/orphan'] },
      ],
    }

    expect(classify(input).map(d => [d.class, d.id])).toEqual([['git_branch_unowned', 'agent-chat/orphan']])
  })

  it('leaves allocations unchecked in a repository git could not list', () => {
    const input = { ...consistent(), gitListings: [{ gitRoot: '/repo', branches: null }] }

    expect(classify(input)).toEqual([])
  })

  it('reports an active row for a retired agent as retired_row_active', () => {
    const input = {
      ...consistent(),
      broker: { ...consistent().broker!, liveIds: [], slotIds: [] },
      fold: [agent('a', { state: 'retired' })],
    }

    expect(classes(input)).toEqual([['retired_row_active', false]])
  })

  it('reports an active row for an exited agent as exited_row_active', () => {
    const input = {
      ...consistent(),
      broker: { ...consistent().broker!, liveIds: [], slotIds: [] },
      fold: [agent('a', { state: 'exited' })],
    }

    expect(classes(input)).toEqual([['exited_row_active', false]])
  })

  it('reports a detached agent whose only row is terminal as unclassified terminal_disagreement', () => {
    const input = {
      ...consistent(),
      broker: { ...consistent().broker!, liveIds: [], slotIds: [] },
      fold: [agent('a', { state: 'detached' })],
      ledgerActive: [],
      ledgerTerminalByAgent: new Map([['a', 'succeeded']]),
    }

    expect(classes(input)).toEqual([['terminal_disagreement', true]])
  })

  it('skips the held and slot checks offline, where there is no broker memory to compare', () => {
    const { broker: _broker, ...offline } = consistent()

    expect(classify({ ...offline, ledgerActive: [] })).toEqual([])
  })
})

describe('gather', () => {
  let dir: string | undefined

  afterEach(() => {
    delete process.env.AGENT_CHAT_HOME
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reads active and terminal rows through the event log connection and reports the shadow on', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-verify-'))
    process.env.AGENT_CHAT_HOME = dir
    const events = new EventLog(path.join(dir, 'events.db'))
    events.append({
      kind: 'agent_spawned',
      actor: 'human',
      target: 'alpha',
      msgId: 'a',
      meta: { name: 'alpha' },
    })
    const shadow = openShadowLedger(events.ledgerHandle(), { supervisorId: 'test' })
    await shadow.apply(prepareFor(shadow, 'a'))

    const { input, shadow: state } = await gather({
      db: events.ledgerHandle(),
      events,
      list: async () => null,
    })
    events.close()

    expect(state).toBe('on')
    expect(input.ledgerActive).toMatchObject([{ agentId: 'a', requestKey: 'spawn:a' }])
    expect(input.fold).toMatchObject([{ agentId: 'a', name: 'alpha', state: 'spawning' }])
  })

  it('reports the shadow off, with no rows, on a home whose ledger tables were never created', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-verify-'))
    process.env.AGENT_CHAT_HOME = dir
    const events = new EventLog(path.join(dir, 'events.db'))

    const { input, shadow } = await gather({ db: events.ledgerHandle(), events })
    events.close()

    expect(shadow).toBe('off')
    expect(input.ledgerActive).toEqual([])
  })
})

function prepareFor(shadow: ReturnType<typeof openShadowLedger>, agentId: string): ExecutionTransition {
  return {
    kind: 'prepare',
    executionId: `exec-${agentId}`,
    eventId: `exec-${agentId}:prepare`,
    expectedRevision: 0,
    occurredAt: new Date().toISOString(),
    execution: { executionId: `exec-${agentId}` },
    agent: { agentId },
    harness: 'claude-code',
    requestKey: `spawn:${agentId}`,
    target: { kind: 'fresh', namespace: 'test' },
    owner: shadow.newLease(),
  }
}
