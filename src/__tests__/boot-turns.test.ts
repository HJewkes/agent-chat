import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { bootTurns, fallPct, summarise, type GenerationBoot } from '../agents/seats/boot-turns.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'boot-turns-2026-10-11')

const read = (name: string): GenerationBoot =>
  bootTurns(fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n'))

const gen = (over: Partial<GenerationBoot>): GenerationBoot => ({
  seat: 'alpha-seat',
  startedAt: '2026-10-09T08:00:00.000Z',
  turns: 10,
  bootTurns: 0,
  usd: 0.1,
  usedSeatsBoot: false,
  inboxShown: [],
  inboxUnmentioned: [],
  ...over,
})

describe('bootTurns', () => {
  it('names the seat from a relaunch prompt and from a charter prompt', () => {
    expect(read('before.jsonl').seat).toBe('alpha-seat')
    expect(read('after.jsonl').seat).toBe('alpha-seat')
  })

  it('leaves a session with no seat prompt unnamed, so summarise skips it', () => {
    const worker = read('worker.jsonl')

    expect(worker.seat).toBeUndefined()
    expect(summarise([worker]).total.generations).toBe(0)
  })

  it('counts records sharing a message id as one turn and reads only the first 10 of 14', () => {
    const before = read('before.jsonl')

    expect(before.turns).toBe(10)
    expect(before.usd).toBe(0.24)
  })

  it('counts six boot turns in a seat that reads its state file by file, skipping the sidechain read', () => {
    expect(read('before.jsonl')).toMatchObject({ bootTurns: 6, usedSeatsBoot: false })
  })

  it('counts one boot turn in a seat that runs seats boot', () => {
    expect(read('after.jsonl')).toMatchObject({ bootTurns: 1, usedSeatsBoot: true, turns: 10 })
  })

  it('lists inbox ids the boot showed and the generation never mentioned again', () => {
    const after = read('after.jsonl')

    expect(after.inboxShown).toEqual(['ab12cd34', 'ef56ab78'])
    expect(after.inboxUnmentioned).toEqual(['ef56ab78'])
  })
})

describe('summarise', () => {
  it('averages boot turns per generation and leaves short generations out of the means', () => {
    const summary = summarise([
      gen({ bootTurns: 6, usd: 0.3 }),
      gen({ bootTurns: 2, usd: 0.1, usedSeatsBoot: true, inboxUnmentioned: ['ef56ab78'] }),
      gen({ bootTurns: 1, turns: 3 }),
    ])

    expect(summary.total).toEqual({
      generations: 3,
      short: 1,
      meanBootTurns: 4,
      meanUsd: 0.2,
      seatsBootShare: 0.333,
      unmentioned: ['ef56ab78'],
    })
  })

  it('gives each seat its own row', () => {
    const summary = summarise([gen({ seat: 'a', bootTurns: 4 }), gen({ seat: 'b', bootTurns: 2 })])

    expect(Object.keys(summary.seats)).toEqual(['a', 'b'])
    expect(summary.seats.b?.meanBootTurns).toBe(2)
  })

  it('reports the fall from before to after as a share of before', () => {
    expect(fallPct(6, 2)).toBe(66.7)
  })
})
