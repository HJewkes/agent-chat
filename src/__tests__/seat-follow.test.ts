import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { watchSeatFollow, type SeatFollowCore } from '../agents/seat-follow.js'
import { accountInCharterPool, rewriteSeatAccount } from '../agents/seats/seat-account-write.js'
import { parsePools } from '../agents/seats/charter.js'

let root: string
let personal: string
let agents: string
let seatFile: string

const charter = (): string =>
  `---\nseats: [seat-a]\npools:\n` +
  `  personal: {config_dir: ${personal}, reserve_seven_day: 35, ceiling_five_hour: 70}\n` +
  `  agents:   {config_dir: ${agents}, reserve_seven_day: 35, ceiling_five_hour: 70}\n---\n`

const SEAT = (dir: string): string =>
  `---\nprefix: tc\npool: personal  # the main login\nconfig_dir: ${dir}  # pinned\noverflow_pool: agents\n---\nbody\n`

interface Attach {
  kind: string
  ref?: string
  meta?: Record<string, string>
}

const harness = (agentName: string, configDir: string) => {
  const watchers: ((row: Attach) => void)[] = []
  const core: SeatFollowCore = {
    onAppend: watch => {
      watchers.push(watch)
      return () => undefined
    },
    agents: { get: () => ({ name: agentName, configDir }) },
  }
  watchSeatFollow(core, { root, home: os.tmpdir(), now: () => new Date(2026, 9, 14) })
  return (row: Attach) => watchers.forEach(watch => watch(row))
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-follow-'))
  personal = path.join(root, 'cfg-personal')
  agents = path.join(root, 'cfg-agents')
  fs.mkdirSync(path.join(root, 'seats'))
  fs.writeFileSync(path.join(root, 'charter.md'), charter())
  seatFile = path.join(root, 'seats', 'seat-a.md')
  fs.writeFileSync(seatFile, SEAT(personal))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('seat follows the account', () => {
  it('moves pool, config_dir and the overflow pool, keeping comments and writing a .bak', () => {
    harness('seat-a', agents)({ kind: 'agent_attached', ref: 'a1', meta: { account_from: personal } })

    const text = fs.readFileSync(seatFile, 'utf8')
    expect(text).toContain(`pool: agents  # the main login # CC-892 moved from personal 2026-10-14`)
    expect(text).toContain(`config_dir: ${agents}  # pinned # CC-892 moved from ${personal} 2026-10-14`)
    expect(text).toContain('overflow_pool: personal # CC-892 moved from agents 2026-10-14')
    expect(text.endsWith('---\nbody\n')).toBe(true)
    expect(fs.readFileSync(`${seatFile}.bak`, 'utf8')).toBe(SEAT(personal))
  })

  it('leaves the file untouched for an agent the charter does not list as a seat', () => {
    const other = path.join(root, 'seats', 'plain.md')
    fs.writeFileSync(other, SEAT(personal))

    harness('plain', agents)({ kind: 'agent_attached', ref: 'a1', meta: { account_from: personal } })

    expect(fs.readFileSync(other, 'utf8')).toBe(SEAT(personal))
    expect(fs.existsSync(`${other}.bak`)).toBe(false)
  })

  it('ignores an attach with no account_from', () => {
    harness('seat-a', agents)({ kind: 'agent_attached', ref: 'a1' })

    expect(fs.readFileSync(seatFile, 'utf8')).toBe(SEAT(personal))
  })

  it('does not rewrite twice when the seat already holds the new account', () => {
    const attach = harness('seat-a', agents)
    attach({ kind: 'agent_attached', ref: 'a1', meta: { account_from: personal } })
    const once = fs.readFileSync(seatFile, 'utf8')
    attach({ kind: 'agent_attached', ref: 'a1', meta: { account_from: personal } })

    expect(fs.readFileSync(seatFile, 'utf8')).toBe(once)
  })
})

describe('rewriteSeatAccount', () => {
  it('leaves overflow_pool alone when it is a third pool', () => {
    const text = SEAT(personal).replace('overflow_pool: agents', 'overflow_pool: other')

    const out = rewriteSeatAccount(text, {
      newDir: agents,
      newPool: 'agents',
      oldDir: personal,
      date: '2026-10-14',
    })

    expect(out).toContain('overflow_pool: other\n')
  })
})

describe('accountInCharterPool', () => {
  it('is true only for a dir some charter pool names', () => {
    const pools = parsePools(charter())

    expect(accountInCharterPool(pools, agents)).toBe(true)
    expect(accountInCharterPool(pools, path.join(root, 'cfg-elsewhere'))).toBe(false)
  })
})
