import { describe, expect, it, vi } from 'vitest'
import { HUMAN_ROOT, LINEAGE } from '../broker/integrity-ledger.js'
import type { AgentEventRow } from '../broker/event-store.js'
import { LINEAGE_BOUND, spawnRowIndex, survivorRoot, type LineageReads } from '../agents/survivor-root.js'
import type { Mismatch } from '../leak-guard/integrity/record.js'

/**
 * TP-4345 S3: a survivor's ledger root is its nearest running ancestor, otherwise the human. Each
 * row names the defect it covers: D1 the depth cap, D2 an unskipped spawn-parent edge, D3 "not
 * exited" read as running. Ids are synthetic.
 */

type Meta = Record<string, string>

interface Tree {
  readonly rows: Map<string, Meta>
  readonly running: Set<string>
  readonly known: Set<string>
  readonly records: Map<string, Mismatch>
}

const tree = (): Tree => ({ rows: new Map(), running: new Set(), known: new Set(), records: new Map() })

const readsOf = (t: Tree): LineageReads => ({
  spawnMeta: id => t.rows.get(id),
  knows: id => t.known.has(id),
  running: id => t.running.has(id),
  onRecord: id => t.records.get(id),
})

const gen = (n: number) => `agtp${String(n).padStart(4, '0')}`

/** A teleport chain gen 1 .. `last`; gen 1 was spawned by `parent`. */
function teleportChain(t: Tree, last: number, parent = ''): void {
  t.rows.set(gen(1), { parent })
  for (let n = 2; n <= last; n++) t.rows.set(gen(n), { teleport_from: gen(n - 1), parent: '' })
}

const rootOf = (t: Tree, agentId: string) => survivorRoot(agentId, t.rows.get(agentId), readsOf(t))

describe('TP-4345 S3: survivorRoot', () => {
  it('D1: roots a 30-generation teleport chain of ended predecessors at the human', () => {
    const t = tree()
    teleportChain(t, 30)

    expect(rootOf(t, gen(30))).toEqual({ parent: HUMAN_ROOT })
  })

  it('D1: walks past 8 ended generations to a running ancestor', () => {
    const t = tree()
    teleportChain(t, 30, 'agdesk01')
    t.rows.set('agdesk01', { parent: '' })
    t.running.add('agdesk01')

    expect(rootOf(t, gen(30))).toEqual({ parent: 'agdesk01' })
  })

  it('D2: skips a dead coordinator-to-coordinator spawn-parent edge to the next running ancestor', () => {
    const t = tree()
    t.rows.set('agcodew1', { parent: 'agoldtp1' })
    t.rows.set('agcodew2', { teleport_from: 'agcodew1', parent: '' })
    t.rows.set('agoldtp1', { parent: 'agoldtp0' })
    t.rows.set('agoldtp0', { parent: 'agfresh1' })
    t.rows.set('agfresh1', { parent: '' })
    t.running.add('agfresh1')

    expect(rootOf(t, 'agcodew2')).toEqual({ parent: 'agfresh1' })
  })

  it('D2: roots at the human when no ancestor on either edge is running', () => {
    const t = tree()
    t.rows.set('agcodew1', { parent: 'agoldtp1' })
    t.rows.set('agcodew2', { teleport_from: 'agcodew1', parent: '' })
    t.rows.set('agoldtp1', { parent: '' })

    expect(rootOf(t, 'agcodew2')).toEqual({ parent: HUMAN_ROOT })
  })

  it('stops at an ancestor the ledger knows, even an ended one, since its own latch speaks for it', () => {
    const t = tree()
    teleportChain(t, 3)
    t.known.add(gen(2))

    expect(rootOf(t, gen(3))).toEqual({ parent: gen(2) })
  })

  it('stays unresolved at an ancestor with no spawn row', () => {
    const t = tree()
    t.rows.set('agchild1', { parent: 'agnorow1' })

    expect(rootOf(t, 'agchild1')).toEqual({ parent: 'agnorow1' })
  })

  it('ends a cycle unresolved under the recorded parent, never at the human', () => {
    const t = tree()
    t.rows.set('agloopa1', { teleport_from: 'agloopb1' })
    t.rows.set('agloopb1', { parent: 'agloopc1' })
    t.rows.set('agloopc1', { parent: 'agloopb1' })

    expect(rootOf(t, 'agloopa1')).toEqual({
      parent: 'agloopb1',
      unresolved: 'lineage unresolved: loops at agloopb1',
    })
  })

  it(`stops unresolved past ${LINEAGE_BOUND} ancestors`, () => {
    const t = tree()
    teleportChain(t, LINEAGE_BOUND + 2)

    expect(rootOf(t, gen(LINEAGE_BOUND + 2))).toEqual({
      parent: gen(LINEAGE_BOUND + 1),
      unresolved: `lineage unresolved: over ${LINEAGE_BOUND} ancestors`,
    })
  })

  it('carries a file quarantine recorded on a skipped ancestor, naming that ancestor', () => {
    const t = tree()
    teleportChain(t, 5)
    const tamper = { file: '/synthetic/settings.json', field: 'sha256' }
    t.records.set(gen(2), tamper)

    expect(rootOf(t, gen(5))).toEqual({ parent: HUMAN_ROOT, inherited: { via: gen(2), mismatch: tamper } })
  })

  it('carries a lineage record verbatim, so its kind is never inferred from a rewritten file string', () => {
    const t = tree()
    teleportChain(t, 3)
    const lineage = { file: LINEAGE, field: 'quarantined parent' }
    t.records.set(gen(1), lineage)

    expect(rootOf(t, gen(3)).inherited).toEqual({ via: gen(1), mismatch: lineage })
  })

  it('reads no record on the running ancestor it roots at, which its own re-admit checks', () => {
    const t = tree()
    teleportChain(t, 3)
    t.running.add(gen(2))
    const onRecord = vi.fn(() => undefined)

    survivorRoot(gen(3), t.rows.get(gen(3)), { ...readsOf(t), onRecord })

    expect(onRecord).not.toHaveBeenCalled()
  })
})

describe('TP-4345 S3: spawnRowIndex', () => {
  const spawnRow = (msgId: string, meta: Meta): AgentEventRow => ({
    kind: 'agent_spawned',
    ts: 0,
    actor: 'human',
    target: msgId,
    msgId,
    ref: null,
    body: null,
    meta,
  })

  it('copies the log once for a whole walk of hits, and again only on a miss', () => {
    const log = [spawnRow('agrow0001', { parent: '' }), spawnRow('agrow0002', { parent: 'agrow0001' })]
    const rows = vi.fn(() => log)
    const lookup = spawnRowIndex(rows)

    lookup('agrow0002')
    lookup('agrow0001')
    log.push(spawnRow('agrow0003', { parent: 'agrow0002' }))
    const late = lookup('agrow0003')

    expect(late?.meta).toEqual({ parent: 'agrow0002' })
    expect(rows).toHaveBeenCalledTimes(2)
  })

  it('keeps the first spawn row of an id', () => {
    const lookup = spawnRowIndex(() => [
      spawnRow('agrow0001', { parent: 'agfirst1' }),
      spawnRow('agrow0001', { parent: 'agsecnd1' }),
    ])

    expect(lookup('agrow0001')?.meta).toEqual({ parent: 'agfirst1' })
  })
})
