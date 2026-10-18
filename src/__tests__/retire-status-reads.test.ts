import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { retireFinished, type FinishedRetirePort } from '../agents/isolation/retire-finished.js'
import { readActiveRuns } from '../agents/isolation/shepherd-skip.js'
import type { AgentIdentity } from '../protocol.js'

/**
 * CC-1491: each Shepherd read spawns `titan-factory shepherd status --json`. One read per
 * retire candidate overloaded the Shepherd server on a large stale drain, so a pass reads once.
 */

let dir: string
let calls: string
let bin: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-status-'))
  calls = path.join(dir, 'calls')
  bin = path.join(dir, 'fake-shepherd')
  fs.writeFileSync(bin, `#!/bin/sh\necho x >> '${calls}'\necho '[]'\n`, { mode: 0o755 })
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const statusExecs = (): number =>
  fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0

const agent = (name: string): AgentIdentity =>
  ({
    agentId: `id-${name}`,
    name,
    state: 'exited',
    origin: 'spawned',
    spawnedBy: 'coord-a',
    cwd: '',
  }) as AgentIdentity

function portFor(roster: AgentIdentity[]): FinishedRetirePort {
  return {
    roster: () => roster,
    events: () => [],
    tracked: () => false,
    parking: () => false,
    current: id => roster.find(a => a.agentId === id),
    presence: () => 'none',
    retire: () => Promise.resolve({ ok: true }),
    skip: { activeRuns: () => readActiveRuns({ bin }), hasOpenPr: async () => false },
  }
}

describe('Shepherd reads during a retire pass', () => {
  it('a retire pass over many candidates runs the status command once', async () => {
    const port = portFor(Array.from({ length: 12 }, (_, i) => agent(`impl-${i}`)))

    const out = await retireFinished(port, { prefix: 'impl-' })

    expect(out.results).toHaveLength(12)
    expect(out.results.every(r => r.ok)).toBe(true)
    expect(statusExecs()).toBe(1)
  })

  it('each pass reads Shepherd afresh', async () => {
    const port = portFor([agent('impl-a'), agent('impl-b')])

    await retireFinished(port, { prefix: 'impl-', dryRun: true })
    await retireFinished(port, { prefix: 'impl-', dryRun: true })

    expect(statusExecs()).toBe(2)
  })
})
