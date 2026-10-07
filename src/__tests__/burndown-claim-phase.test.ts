import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyActions, advance, claimKey } from '../agents/burndown/advance.js'
import { PHASE_EDGES, IllegalPhaseEdgeError } from '../agents/burndown/claim-phase.js'
import {
  PHASES,
  readLedger,
  writeLedger,
  type Claim,
  type Ledger,
  type Phase,
} from '../agents/burndown/ledger.js'

const logged = vi.hoisted(() => vi.fn())
vi.mock('../broker/log.js', () => ({ logEvent: logged }))

const NOW = new Date('2026-10-05T12:00:00.000Z')
const AT = '2026-10-05T06:00:00.000Z'

const claim = (phase: Phase, patch: Partial<Claim> = {}): Claim => ({
  taskId: 'CC-1',
  initiative: 'demo',
  spawnedAt: AT,
  phase,
  phaseAt: AT,
  ...patch,
})
const ledger = (...claims: Claim[]): Ledger => ({ version: 1, claims })

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-phase-'))
  file = path.join(dir, 'ledger.json')
  logged.mockClear()
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const EDGES = PHASES.flatMap(from => PHASE_EDGES[from].map(to => [from, to] as const))

describe('claim phase edges at the ledger write', () => {
  it.each(EDGES)('allows %s to %s', (from, to) => {
    writeLedger(file, ledger(claim(from)))

    writeLedger(file, ledger(claim(to)))

    expect(readLedger(file).claims[0]?.phase).toBe(to)
  })

  it('refuses queued to shepherding, names the claim and logs it before the throw', () => {
    writeLedger(file, ledger(claim('queued', { slice: 'a' })))

    const act = (): void => writeLedger(file, ledger(claim('shepherding', { slice: 'a' })))

    expect(act).toThrow(IllegalPhaseEdgeError)
    expect(act).toThrow('claim CC-1#a may not move from queued to shepherding')
    expect(logged).toHaveBeenCalledWith('burndown_illegal_phase_edge', {
      claim: 'CC-1#a',
      from: 'queued',
      to: 'shepherding',
    })
    expect(readLedger(file).claims[0]?.phase).toBe('queued')
  })

  it('refuses every pair outside the table', () => {
    const illegal = PHASES.flatMap(from =>
      PHASES.filter(to => to !== from && !PHASE_EDGES[from].includes(to)).map(to => [from, to] as const),
    )
    for (const [from, to] of illegal) {
      fs.rmSync(file, { force: true })
      writeLedger(file, ledger(claim(from)))
      expect(() => writeLedger(file, ledger(claim(to))), `${from} to ${to}`).toThrow(IllegalPhaseEdgeError)
    }
  })

  it('passes a write that keeps the phase', () => {
    writeLedger(file, ledger(claim('shepherding')))

    writeLedger(file, ledger(claim('shepherding', { lastReport: 'refreshed' })))

    expect(readLedger(file).claims[0]?.lastReport).toBe('refreshed')
  })

  it('loads a ledger on disk with claims in every phase', () => {
    fs.writeFileSync(file, JSON.stringify(ledger(...PHASES.map((p, i) => claim(p, { taskId: `CC-${i}` })))))

    expect(readLedger(file).claims.map(c => c.phase)).toEqual([...PHASES])
  })

  it('does not hold a claim added in any phase to an edge', () => {
    writeLedger(file, ledger(claim('done')))

    writeLedger(file, ledger(claim('done'), claim('shepherding', { taskId: 'CC-2' })))

    expect(readLedger(file).claims).toHaveLength(2)
  })

  it('writes over a ledger it cannot read', () => {
    fs.writeFileSync(file, '{ not json')

    writeLedger(file, ledger(claim('shepherding')))

    expect(readLedger(file).claims[0]?.phase).toBe('shepherding')
  })

  it('accepts the edges advance emits for a finished worker with a PR', () => {
    const worker = claim('implementing', { agentId: 'a1', agentName: 'bd-cc-1' })
    writeLedger(file, ledger(worker))
    const obs = new Map([
      [
        claimKey(worker),
        {
          agent: { id: 'a1', state: 'exited' as const },
          report: { status: 'DONE', pr: 'https://github.com/o/r/pull/1' },
        },
      ],
    ])

    const next = applyActions(ledger(worker), advance([worker], obs as never, NOW), NOW)
    writeLedger(file, next)

    expect(readLedger(file).claims[0]?.phase).toBe('shepherding')
  })
})
