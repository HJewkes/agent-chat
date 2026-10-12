import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { advance, applyActions, claimKey } from '../agents/burndown/advance.js'
import { approveBrief, approvePortsOn, briefAnswered } from '../agents/burndown/brief-approve.js'
import { EMPTY_LEDGER, readLedger, writeLedger, type Claim } from '../agents/burndown/ledger.js'
import { parseReport } from '../agents/burndown/report.js'

/** CC-1076: approving a brief and the tick reading the finished briefer must agree in either order. */

const NOW = new Date('2026-10-11T12:00:00.000Z')
const PROPOSED_TAGS = ['kind:x', 'brief:wanted', 'brief:proposed=2026-10-10']

const briefer: Claim = {
  taskId: 'CC-1',
  initiative: 'init',
  agentId: 'a1',
  agentName: 'bd-cc-1',
  spawned: ['bd-cc-1'],
  spawnedAt: '2026-10-11T11:00:00.000Z',
  phase: 'planning',
  phaseAt: '2026-10-11T11:00:00.000Z',
  briefer: true,
}

describe('burndown brief approval against the tick', () => {
  let root: string
  let ledgerPath: string
  let tags: string[]

  const taskYaml = () => `id: CC-1\ntitle: "t"\ntags:\n${tags.map(t => `  - ${t}`).join('\n')}\n`

  /** One tick over the persisted ledger, reading the task's tags as they stand now. */
  const tick = () => {
    const ledger = readLedger(ledgerPath)
    const obs = { agent: { id: 'a1', state: 'exited' as const }, proposed: briefAnswered(tags) }
    const report = parseReport('Status: DONE')
    const observations = new Map(ledger.claims.map(c => [claimKey(c), { ...obs, report }]))
    const live = ledger.claims.filter(c => c.phase !== 'done')
    writeLedger(ledgerPath, applyActions(ledger, advance(live, observations, NOW), NOW))
  }

  const approve = (between: () => void = () => {}) =>
    approveBrief(
      'CC-1',
      {
        ...approvePortsOn(root),
        edit: (_slug, _id, args) => {
          const [flag, tag] = args
          tags = flag === '--add-tag' ? [...tags, tag!] : tags.filter(t => t !== tag)
          between()
        },
      },
      '2026-10-11',
    )

  const claimAfter = () => readLedger(ledgerPath).claims[0]

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-race-'))
    ledgerPath = path.join(root, 'ledger.json')
    fs.mkdirSync(path.join(root, 'init', 'tasks'), { recursive: true })
    fs.mkdirSync(path.join(root, 'init', 'sources'), { recursive: true })
    fs.writeFileSync(path.join(root, 'init', 'sources', 'CC-1-plan.md'), 'plan')
    tags = [...PROPOSED_TAGS]
    fs.writeFileSync(path.join(root, 'init', 'tasks', 'CC-1.yml'), taskYaml())
    writeLedger(ledgerPath, { ...EMPTY_LEDGER, claims: [briefer] })
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('approve then tick: the briefer claim finishes instead of stalling planner-refused', () => {
    expect(approve().ok).toBe(true)
    expect(tags).not.toContain('brief:proposed=2026-10-10')

    tick()

    expect(claimAfter()).toMatchObject({ phase: 'done' })
    expect(claimAfter()?.stalledReason).toBeUndefined()
  })

  it('tick then approve: the claim finishes and approval still promotes the brief', () => {
    tick()

    expect(approve().ok).toBe(true)
    expect(claimAfter()).toMatchObject({ phase: 'done' })
    expect(tags).toEqual(['kind:x', 'brief:wanted', 'brief:ready=2026-10-11', 'brief:src=briefer'])
  })

  it('a tick that reads and writes the ledger between any two approval edits still finishes the claim', () => {
    const edits = ['--add-tag ready', '--add-tag src', '--remove-tag proposed']
    for (let at = 0; at < edits.length; at++) {
      ledgerPath = path.join(root, `ledger-${at}.json`)
      writeLedger(ledgerPath, { ...EMPTY_LEDGER, claims: [briefer] })
      tags = [...PROPOSED_TAGS]
      let n = 0

      const report = approve(() => {
        if (n++ === at) tick()
      })
      tick()

      expect(report.ok).toBe(true)
      expect(claimAfter(), `tick after edit ${edits[at]}`).toMatchObject({ phase: 'done' })
      expect(claimAfter()?.stalledReason).toBeUndefined()
    }
  })

  it('a briefer that left neither a proposal nor an approved brief still stalls', () => {
    tags = ['kind:x', 'brief:wanted', 'brief:ready=2026-10-01', 'brief:src=seat']

    tick()

    expect(claimAfter()).toMatchObject({ phase: 'planning', stalledReason: expect.any(String) })
  })
})
