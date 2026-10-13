import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Phase } from '../agents/burndown/ledger.js'
import { burndownTreeHold } from '../agents/burndown/tree-hold.js'

let dir: string
let ledgerFile: string
let tree: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-hold-'))
  ledgerFile = path.join(dir, 'ledger.json')
  tree = path.join(dir, 'trees', 'worker-a')
  fs.mkdirSync(tree, { recursive: true })
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function writeClaim(phase: Phase, worktree: string): void {
  const claim = {
    taskId: 'CC-1',
    initiative: 'claude-channels',
    slice: 'a',
    spawnedAt: '2026-10-11T00:00:00.000Z',
    phase,
    phaseAt: '2026-10-11T00:00:00.000Z',
    worktree,
  }
  fs.writeFileSync(ledgerFile, JSON.stringify({ version: 1, claims: [claim] }))
}

describe('whether a burndown claim still reads a worktree (CC-1039)', () => {
  it('finds no hold when the ledger file does not exist', () => {
    expect(burndownTreeHold(ledgerFile, tree)).toBeUndefined()
  })

  it('holds a tree an implementing claim names through a symlinked path', () => {
    const link = path.join(dir, 'link')
    fs.symlinkSync(path.join(dir, 'trees'), link)
    writeClaim('implementing', path.join(link, 'worker-a'))

    expect(burndownTreeHold(ledgerFile, tree)).toMatch(/CC-1 slice a .*implementing/)
  })

  it.each<Phase>(['awaiting-merge', 'shepherding'])('releases the tree once the claim is %s', phase => {
    writeClaim(phase, tree)

    expect(burndownTreeHold(ledgerFile, tree)).toBeUndefined()
  })

  it.each<Phase>(['queued', 'planning', 'reviewing', 'parked'])(
    'holds the tree while the claim is %s',
    phase => {
      writeClaim(phase, tree)

      expect(burndownTreeHold(ledgerFile, tree)).toMatch(new RegExp(`phase ${phase}`))
    },
  )

  it('ignores a done claim on the tree', () => {
    writeClaim('done', tree)

    expect(burndownTreeHold(ledgerFile, tree)).toBeUndefined()
  })

  it('ignores a held claim on a different tree', () => {
    writeClaim('implementing', path.join(dir, 'trees', 'worker-b'))

    expect(burndownTreeHold(ledgerFile, tree)).toBeUndefined()
  })

  it('holds every tree when the ledger is malformed', () => {
    fs.writeFileSync(ledgerFile, '{ not json')

    expect(burndownTreeHold(ledgerFile, tree)).toMatch(/unreadable/)
  })
})
