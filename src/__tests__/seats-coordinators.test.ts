import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { coordinatorSeats } from '../agents/seats/coordinators.js'
import { seatsCoordinatorsVerb } from '../cli/verbs/seats-coordinators.js'

const charterWith = (seatsLine: string): string => `---\nname: charter\n${seatsLine}\n---\n\n# Charter\n`

describe('coordinatorSeats', () => {
  it('appends tp-operator to a flow-list seats line carrying a trailing comment', () => {
    const charter = charterWith('seats: [titan-coord, voltras-coord, design-coord]  # one per initiative')

    expect(coordinatorSeats(charter)).toEqual(['titan-coord', 'voltras-coord', 'design-coord', 'tp-operator'])
  })

  it('lists tp-operator once when the charter already names it', () => {
    const charter = charterWith('seats: [tp-operator, titan-coord]')

    expect(coordinatorSeats(charter)).toEqual(['tp-operator', 'titan-coord'])
  })

  it('yields nothing when the charter has no seats, so the operator alone never counts as a list', () => {
    expect(coordinatorSeats(charterWith('owner_seat: titan-coord'))).toEqual([])
  })
})

describe('agent-chat seats coordinators', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'seats-coordinators-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('prints the coordinator seats on one space-separated line', async () => {
    fs.writeFileSync(path.join(root, 'charter.md'), charterWith('seats: [titan-coord, audio-coord]'))

    const report = await seatsCoordinatorsVerb.run({ root }, {} as never)

    expect(report).toEqual({ ok: true, lines: ['titan-coord audio-coord tp-operator'] })
  })

  it('fails with no line when the root has no charter', async () => {
    const report = await seatsCoordinatorsVerb.run({ root }, {} as never)

    expect(report.ok).toBe(false)
    expect(report.lines).toEqual([])
    expect(report.errors?.[0]).toContain('charter.md')
  })

  it('fails with no line when the charter lists no seats', async () => {
    fs.writeFileSync(path.join(root, 'charter.md'), charterWith('owner_seat: titan-coord'))

    const report = await seatsCoordinatorsVerb.run({ root }, {} as never)

    expect(report.ok).toBe(false)
    expect(report.lines).toEqual([])
  })
})
