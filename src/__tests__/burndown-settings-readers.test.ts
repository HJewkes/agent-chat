import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runChecks } from '../broker/doctor.js'
import { dispatchStatsPorts } from '../agents/burndown/dispatch-stats-source.js'
import { bootDeps } from '../cli/verbs/seats.js'

/**
 * CC-955 S2b: the seats boot `ready` read, the doctor's burndown check and the dispatch-stats `maxAgents` port read the
 * resolved config, so a settings file they cannot parse is seen by each. The flat file alone never held such a file.
 */

let world: string
const saved = { ...process.env }
const settingsFile = (): string => path.join(world, 'home', 'burndown.settings.json')

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const MALFORMED = JSON.stringify({ seats: { 'seat-t': { on: 'maybe' } } })

const DEFAULTS = `defaults:
  kind_weights: {platform: 0.8}
  share_caps: {}
  initiative_decay: 0.85
  score_terms: {severity: 0.40, priority_pct: 0.30, unblocks: 0.20, staleness: 0.10}
  severity: {unset: 0.3}
  readiness: {ready: 1.0, untriaged: 0.6, blocked: 0.25}
  size: {le3: 1.0, le8: 0.9, gt8: 0.75}
  stop_short_factor: 0.8
  worktrees_per_repo_per_seat: 3
  worktrees_left_free_per_repo: 0`

function seatWorld(): string {
  const autonomy = path.join(world, 'aw', 'claude-channels', 'sources', 'autonomy')
  const pool = `pool-t: {config_dir: ${path.join(world, 'acct')}, human_uses: false, reserve_seven_day: 30, ceiling_five_hour: 75}`
  write(path.join(autonomy, 'charter.md'), `---\nseats: [seat-t]\n${DEFAULTS}\npools:\n  ${pool}\n---\n`)
  const seat = `prefix: st\npool: pool-t\ninitiatives: {demo: 1.0}\nrepos:\n  - {path: ${world}, initiatives: [demo]}\nconcurrency: {implementers: 2, reviewers: 1, planners: 1}`
  write(path.join(autonomy, 'seats', 'seat-t.md'), `---\n${seat}\n---\n`)
  write(path.join(world, 'aw', 'demo', 'brief.md'), '---\ntitle: demo\nstate: focused\n---\n# demo\n')
  const task =
    'id: T-1\ntitle: Do T-1\npriority: 3\nestimate: 2\ndone_when: tests\nstatus: open\ntags:\n  - agent-chat\n'
  write(path.join(world, 'aw', 'demo', 'tasks', 'T-1.yml'), task)
  return autonomy
}

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-settings-readers-')))
  process.env.AGENT_CHAT_HOME = path.join(world, 'home')
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(world, 'aw')
  write(
    path.join(world, 'home', 'burndown.config.json'),
    JSON.stringify({ enabled: true, reportTo: 'coord' }),
  )
})

afterEach(() => {
  process.env = { ...saved }
  fs.rmSync(world, { recursive: true, force: true })
})

describe('seats boot ready read under the resolved burndown config', () => {
  it('reads the ready set when the settings file is sound', async () => {
    const ready = await bootDeps(seatWorld()).ready('seat-t', new Date())

    expect(ready.order.length).toBeGreaterThan(0)
  })

  it('fails naming the settings file when it is malformed', async () => {
    const autonomy = seatWorld()
    write(settingsFile(), MALFORMED)

    await expect(bootDeps(autonomy).ready('seat-t', new Date())).rejects.toThrow(/settings .* is malformed/)
  })
})

describe('doctor burndown check under the resolved burndown config', () => {
  const burndown = async () => (await runChecks()).find(check => check.name === 'burndown')

  it('is enabled from the flat file when the settings file is sound', async () => {
    expect((await burndown())?.detail).toMatch(/^enabled,/)
  })

  it('warns naming the settings file when it is malformed', async () => {
    write(settingsFile(), MALFORMED)

    expect(await burndown()).toMatchObject({ status: 'warn', detail: expect.stringMatching(/is malformed/) })
  })
})

describe('dispatch-stats maxAgents under the resolved burndown config', () => {
  const maxAgents = (): number => dispatchStatsPorts(path.join(world, 'autonomy'), new Date()).maxAgents()

  it('reads the flat file cap when the settings file is sound', () => {
    write(path.join(world, 'home', 'burndown.config.json'), JSON.stringify({ maxAgents: 7 }))

    expect(maxAgents()).toBe(7)
  })

  it('fails naming the settings file when it is malformed', () => {
    write(settingsFile(), MALFORMED)

    expect(maxAgents).toThrow(/settings .* is malformed/)
  })
})
