import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderShareMix, shareWhatIf, shareWhatIfFromDisk } from '../agents/burndown/tick.js'
import { withBroker } from '../cli/client.js'
import { burndownPlanVerb, parseShares, planFlagError } from '../cli/verbs/burndown.js'

/** CC-1107 d: `burndown plan --seat <s> --shares <slug>=<v>,... --picks N`, the project-share what-if. */

const ctx = { warnings: [], format: 'human' as const, withBroker }

/** Two projects of 20 rows each, alternating in the base order. */
const twoProjects = Array.from({ length: 40 }, (_, i) => ({
  id: `T-${i}`,
  initiative: i % 2 === 0 ? 'titan-platform' : 'claude-channels',
  tier: 3,
}))
const raised = { initiatives: { 'titan-platform': 0.8, 'claude-channels': 0.2 } }

describe('the share what-if over a two-project order', () => {
  it('prints the next 20 picks by project shifting toward the raised project', () => {
    const mix = shareWhatIf(twoProjects, twoProjects, { shares: raised, picks: 20 })

    expect(renderShareMix(mix)).toBe(
      'next 20 picks by project: titan-platform 10 -> 16, claude-channels 10 -> 4',
    )
  })

  it("counts the run's prior picks toward each project's share", () => {
    const even = { initiatives: { 'titan-platform': 0.5, 'claude-channels': 0.5 } }

    const mix = shareWhatIf(twoProjects, twoProjects, { shares: even, picks: 4 }, { 'titan-platform': 4 })

    expect(mix.after).toEqual({ 'claude-channels': 4 })
  })

  it('reports a project the shares leave out after the shared ones', () => {
    const third = [...twoProjects, { id: 'X-1', initiative: 'relay', tier: 3 }]

    const mix = shareWhatIf([third.at(-1)!, ...twoProjects], third, { shares: raised, picks: 2 })

    expect(renderShareMix(mix)).toBe(
      'next 2 picks by project: titan-platform 1 -> 2, claude-channels 0 -> 0, relay 1 -> 0',
    )
  })
})

describe('burndown plan --shares flags', () => {
  it('refuses --shares without --seat, with --scored, and --picks without --shares', () => {
    expect(planFlagError({ shares: 'a=1' })).toBe('burndown plan --shares needs --seat <name>')
    expect(planFlagError({ seat: 's', scored: true, shares: 'a=1' })).toBe(
      'burndown plan --shares does not apply with --scored',
    )
    expect(planFlagError({ seat: 's', picks: 5 })).toBe('burndown plan --picks applies only with --shares')
    expect(planFlagError({ seat: 's', shares: 'a=1', picks: 5 })).toBeUndefined()
  })

  it('refuses the flag through the verb before reading anything', async () => {
    const report = await burndownPlanVerb.run({ shares: 'titan-platform=0.8' }, ctx)

    expect(report).toEqual({ ok: false, lines: [], errors: ['burndown plan --shares needs --seat <name>'] })
  })

  it('parses slug=share pairs and refuses a malformed, negative or repeated one', () => {
    expect(parseShares('titan-platform=0.8, claude-channels=0.2')).toEqual(raised)
    expect(() => parseShares('titan-platform')).toThrow(
      "--shares wants <slug>=<share>,...; got 'titan-platform'",
    )
    expect(() => parseShares('a=x')).toThrow("got 'a=x'")
    expect(() => parseShares('a=')).toThrow("got 'a='")
    expect(() => parseShares('a=-1')).toThrow('--shares a=-1 is negative')
    expect(() => parseShares('a=1,a=2')).toThrow('--shares names a twice')
  })
})

describe('the share what-if from disk', () => {
  const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'score-2026-09-29')
  const snapshot = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'tasks.json'), 'utf8')) as {
    today: string
    tasks: { id: string; slug: string }[]
  }
  const saved = { ...process.env }
  let world: string

  beforeEach(() => {
    world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-shares-')))
    for (const task of snapshot.tasks) {
      const dir = path.join(world, task.slug, 'tasks')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${task.id}.yml`), stringify(task))
    }
  })

  afterEach(() => {
    process.env = { ...saved }
    fs.rmSync(world, { recursive: true, force: true })
  })

  const opts = () => ({
    seat: 'sample-seat',
    now: new Date(`${snapshot.today}T12:00:00`),
    root: world,
    autonomyRoot: FIXTURE,
  })
  const live = { priorPicks: {}, readySet: false }

  it("shifts the seat's next picks toward the project given the whole share", () => {
    const mix = shareWhatIfFromDisk(opts(), { shares: { initiatives: { delta: 1 } }, picks: 3 }, live)

    expect(renderShareMix(mix)).toBe('next 3 picks by project: delta 0 -> 3, alpha 2 -> 0, beta 1 -> 0')
  })

  it("refuses a share naming an initiative outside the seat's scope", () => {
    const shares = { initiatives: { alpha: 0.5, nowhere: 0.5 } }

    expect(() => shareWhatIfFromDisk(opts(), { shares, picks: 20 }, live)).toThrow(
      "--shares names nowhere, not in seat sample-seat's scope",
    )
  })
})
