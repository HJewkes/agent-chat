import { afterEach, describe, expect, it } from 'vitest'
import { EventLog } from '../broker/event-log.js'
import { startSupervisor, type RestartHarness } from './helpers/restart-harness.js'

/**
 * CC-486 a: `agent ls --json` is one `agents` request, and the broker answers it with
 * `core.agents.roster()`, a fold over the event log. Under ~3,500 rows it took 17-33 s
 * on the live broker, so the roster read has a timed regression test.
 *
 * The bound is the task's 2 s, unscaled: the read is CPU-bound on a local SQLite file, and
 * the figure on a laptop is about 25 ms, so a CI runner several times slower
 * still clears it. If a slow runner ever flakes, fix the read, not the bound.
 */

const ROWS = 3500
const BOUND_MS = 2000

let h: RestartHarness

afterEach(() => h?.close())

function seedRoster(): void {
  const events = h.core.events
  if (!(events instanceof EventLog)) throw new Error('agent-ls-roster-latency expects an EventLog store')
  const db = events.ledgerHandle()
  db.exec('BEGIN')
  try {
    for (let i = 0; i < ROWS; i += 1) {
      const name = `synthetic-${i}`
      const agentId = h.core.append({
        kind: 'agent_spawned',
        actor: 'human',
        target: name,
        meta: { origin: 'adopted', name, cwd: '/tmp/synthetic', session_id: `session-${name}`, depth: '0' },
      }).msgId
      h.core.append({ kind: 'agent_attached', actor: name, ref: agentId })
      if (i % 2 === 0) h.core.append({ kind: 'agent_exited', actor: name, ref: agentId, meta: { code: '0' } })
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

describe('agent ls --json roster read', () => {
  it('answers within 2 s over about 3,500 agent rows', () => {
    h = startSupervisor({ slots: 5, settleMs: 50 })
    seedRoster()

    const start = performance.now()
    const roster = h.core.agents.roster()
    const elapsed = performance.now() - start

    expect(roster.length).toBeGreaterThanOrEqual(ROWS / 2)
    expect(elapsed).toBeLessThanOrEqual(BOUND_MS)
  })
})
