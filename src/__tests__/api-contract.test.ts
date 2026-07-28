import { describe, expect, it } from 'vitest'
import {
  HEARTBEAT_MS,
  MAX_REPLAY_ROWS,
  SSE_EVENT_NAMES,
  TOKEN_HEADER,
  type SseEventName,
} from '../api-contract.js'
import { EVENT_KINDS } from '../protocol.js'
import type { ClientMessage, EventKind, ServerMessage } from '../protocol.js'
import fs from 'node:fs'
import { agentDir, agentsDir, cliEntry, profilesDir, tokenPath } from '../paths.js'

/**
 * Step 2a freezes the API contract so steps 3, 4 and 5 can be built in parallel
 * against a shape nobody has to renegotiate. "Frozen" is only worth anything if
 * a change is noisy, so these tests exist to make the enumerations fail loudly
 * rather than drift — the SSE `event:` name IS the EventKind union, and adding a
 * kind without extending the contract is exactly the silent break 2a prevents.
 */

/** Compile-time assertion helper: fails to typecheck if the sets disagree. */
const expectAssignable = <T>(_value: T): void => undefined

/**
 * The kinds this contract was frozen against. A type-level guard would be inert:
 * tsconfig excludes `src/**\/__tests__/**` and vitest strips types without
 * checking them, so NO test file in this repo is typechecked. Anything that must
 * actually fail has to fail at runtime, which is why EVENT_KINDS is an array.
 */
const KINDS_AT_FREEZE = [
  'message',
  'broadcast',
  'question',
  'notice',
  'answer',
  'resolution',
  'approval_request',
  'registered',
  'deregistered',
  'route_failed',
  'agent_spawned',
  'agent_attached',
  'agent_detached',
  'agent_resumed',
  'agent_exited',
  'agent_retired',
  'isolation_allocated',
  'isolation_released',
  'agent_spawn_refused',
  'verdict_refused',
]

describe('SSE event names cover every EventKind', () => {
  it('carries every event kind as a legal SSE event name', () => {
    for (const kind of EVENT_KINDS) {
      expect(SSE_EVENT_NAMES).toContain(kind)
    }
  })

  /**
   * The guard that matters. Adding a kind to protocol.ts without deciding what it
   * means for the SSE contract fails here — loudly, at runtime, naming the kind.
   * If this fails because you added a kind deliberately: check the Log and Queue
   * views handle it, then add it below.
   */
  it('has exactly the kinds this contract was frozen against', () => {
    expect([...EVENT_KINDS].sort()).toEqual([...KINDS_AT_FREEZE].sort())
  })

  it('reserves the two SSE names that are not event kinds', () => {
    expect(SSE_EVENT_NAMES).toContain('session_status')
    expect(SSE_EVENT_NAMES).toContain('reset')
    expect(SSE_EVENT_NAMES).toHaveLength(EVENT_KINDS.length + 2)
  })

  it('has no duplicate event names', () => {
    expect(new Set(SSE_EVENT_NAMES).size).toBe(SSE_EVENT_NAMES.length)
  })

  it('still types an event name as assignable', () => {
    const kind: EventKind = 'agent_spawned'
    expectAssignable<SseEventName>(kind)
  })
})

describe('agent protocol variants are on the wire type', () => {
  it('accepts the three new client messages', () => {
    expectAssignable<ClientMessage>({ t: 'spawn', name: 'scout', profile: 'reviewer', brief: 'look' })
    expectAssignable<ClientMessage>({ t: 'agents', includeRetired: true })
    expectAssignable<ClientMessage>({ t: 'retire', name: 'scout' })
  })

  it('accepts the two new server messages', () => {
    expectAssignable<ServerMessage>({ t: 'spawn_result', ok: true, agentId: 'a1b2c3d4', name: 'scout' })
    expectAssignable<ServerMessage>({ t: 'agents_result', agents: [] })
  })

  /**
   * agentId is the field that makes resume a re-attach rather than a fresh
   * registration, which is the hinge the whole agent-teams design turns on.
   */
  it('accepts register with and without the agent identity fields', () => {
    expectAssignable<ClientMessage>({ t: 'register', name: 'a', workingOn: 'w', cwd: '/', pid: 1 })
    expectAssignable<ClientMessage>({
      t: 'register',
      name: 'a',
      workingOn: 'w',
      cwd: '/',
      pid: 1,
      agentId: 'a1b2c3d4',
      termSessionId: 'w0t1p2',
    })
  })
})

describe('contract constants', () => {
  it('bounds SSE replay so an overnight tab cannot replay the whole log', () => {
    expect(MAX_REPLAY_ROWS).toBe(500)
  })

  it('heartbeats often enough to keep proxies and dead-peer detection healthy', () => {
    expect(HEARTBEAT_MS).toBe(25_000)
  })

  it('names the token header the dashboard and API both use', () => {
    expect(TOKEN_HEADER).toBe('X-Agent-Chat-Token')
  })
})

describe('agent-teams paths', () => {
  it('places agent state under the broker home, keyed by agent id', () => {
    expect(agentDir('a1b2c3d4')).toBe(`${agentsDir()}/a1b2c3d4`)
    expect(agentsDir().endsWith('/agents')).toBe(true)
    expect(profilesDir().endsWith('/profiles')).toBe(true)
  })

  /** §6.5 names this file ui.token; the dashboard route reads it by that name. */
  it('names the loopback token file ui.token', () => {
    expect(tokenPath().endsWith('/ui.token')).toBe(true)
  })

  /**
   * Regression: three call sites each resolved this differently and all three
   * produced `src/cli.js` — a file that has never existed — whenever the code ran
   * from the source tree. The failure surfaced as MODULE_NOT_FOUND inside a freshly
   * opened terminal window, about as far from the cause as it could land.
   *
   * Asserting the file EXISTS is the part that matters: `dist/` is the only
   * runnable entry, because our internal imports use the TS-ESM `.js` specifier
   * convention and Node's type stripping will not rewrite those to `.ts`.
   */
  it('resolves the CLI entry to a file that exists, from either tree', () => {
    expect(cliEntry().endsWith('/dist/cli.js')).toBe(true)
    expect(fs.existsSync(cliEntry())).toBe(true)
  })
})
