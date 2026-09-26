import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseAutonomy } from '../agents/active-work.js'
import { readAccountBudget } from '../agents/budget.js'
import { gateAccount } from '../agents/burndown/budget-gate.js'
import { grantGap } from '../agents/burndown/eligibility.js'
import {
  addClaim,
  EMPTY_LEDGER,
  isStalled,
  readLedger,
  writeLedger,
  type Claim,
} from '../agents/burndown/ledger.js'
import { planFromDisk } from '../agents/burndown/tick.js'

/**
 * The dry-run tick over a fixture world: an active-work root, a profile root
 * with one account's status cache and trust file, and an agent-chat home.
 * Nothing here reads the developer's real sessions, briefs or ledger.
 */

let world: string
const saved = { ...process.env }
const NOON = new Date(2026, 8, 26, 12, 0)

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const brief = (autonomy: string): string =>
  `---\ntitle: Demo\nstate: focused\nrank: 1\nprofile: agents\n${autonomy}---\n# Demo\n`

const OPTED_IN = 'autonomy:\n  mode: burndown\n  lanes: 1\n  accounts: [agents]\n  grants: []\n  repo: REPO\n'

const task = (id: string, extra = ''): string =>
  `id: ${id}\ntitle: Do ${id}\npriority: 3\nestimate: 1\ndone_when: unit tests cover the new branch\nstatus: open\ntags:\n  - agent-chat\n${extra}`

function account(name: string, usage: { seven_day: number; five_hour: number }, trusted: string[]): void {
  const dir = path.join(world, 'profiles', name)
  const rate_limits = {
    seven_day: { used_percentage: usage.seven_day },
    five_hour: { used_percentage: usage.five_hour },
  }
  write(
    path.join(dir, 'status-cache', 'sessions', 's1.json'),
    JSON.stringify({ session_id: 's1', written_at: NOON.getTime() / 1000 - 30, rate_limits }),
  )
  const projects = Object.fromEntries(trusted.map(p => [p, { hasTrustDialogAccepted: true }]))
  write(path.join(dir, '.claude.json'), JSON.stringify({ projects }))
}

const repo = (): string => path.join(world, 'repo')

function initiative(slug: string, autonomy: string, tasks: Record<string, string>): void {
  write(path.join(world, 'aw', slug, 'brief.md'), brief(autonomy.replace('REPO', repo())))
  for (const [id, text] of Object.entries(tasks))
    write(path.join(world, 'aw', slug, 'tasks', `${id}.yml`), text)
}

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-burndown-')))
  process.env.AGENT_CHAT_HOME = path.join(world, 'home')
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(world, 'aw')
  process.env.CLAUDE_PROFILE_ROOT = path.join(world, 'profiles')
  delete process.env.AGENT_CHAT_STATUS_CACHE
})

afterEach(() => {
  process.env = { ...saved }
  fs.rmSync(world, { recursive: true, force: true })
})

describe('burndown plan', () => {
  it('dispatches an eligible task into a worktree under a trusted repo', () => {
    initiative('demo', OPTED_IN, { 'DM-1': task('DM-1') })
    account('agents', { seven_day: 40, five_hour: 10 }, [repo()])

    const result = planFromDisk(NOON)

    expect(result.refusals).toEqual([])
    expect(result.dispatch).toEqual([
      expect.objectContaining({
        initiative: 'demo',
        task: 'DM-1',
        profile: 'implementer-lite',
        account: 'agents',
        cwd: path.join(repo(), '.worktrees', 'bd-dm-1'),
      }),
    ])
  })

  it('refuses a task when the only account is inside its seven-day reserve', () => {
    initiative('demo', OPTED_IN, { 'DM-1': task('DM-1') })
    account('agents', { seven_day: 80, five_hour: 10 }, [repo()])

    const result = planFromDisk(NOON)

    expect(result.dispatch).toEqual([])
    expect(result.refusals).toEqual([
      expect.objectContaining({
        task: 'DM-1',
        kind: 'budget',
        reason: expect.stringContaining('inside the reserve'),
      }),
    ])
  })

  it('refuses a task whose worktree would land outside any trusted folder on the account', () => {
    initiative('demo', OPTED_IN, { 'DM-1': task('DM-1') })
    account('agents', { seven_day: 40, five_hour: 10 }, [path.join(world, 'some-other-repo')])

    const result = planFromDisk(NOON)

    expect(result.dispatch).toEqual([])
    expect(result.refusals).toEqual([
      expect.objectContaining({
        task: 'DM-1',
        kind: 'trust',
        reason: expect.stringContaining('no accepted trust entry'),
      }),
    ])
  })

  it('skips reserved, unestimated and claimed tasks and picks the eligible one', () => {
    initiative('demo', OPTED_IN.replace('lanes: 1', 'lanes: 2'), {
      'DM-1': task('DM-1').replace('  - agent-chat', '  - human-only'),
      'DM-2': task('DM-2').replace('estimate: 1\n', ''),
      'DM-3': task('DM-3'),
      'DM-4': task('DM-4'),
    })
    account('agents', { seven_day: 40, five_hour: 10 }, [repo()])
    const claim: Claim = {
      taskId: 'DM-3',
      initiative: 'demo',
      agentId: 'a1',
      spawnedAt: NOON.toISOString(),
      phase: 'implementing',
      phaseAt: NOON.toISOString(),
    }
    writeLedger(path.join(world, 'home', 'burndown.json'), addClaim(EMPTY_LEDGER, claim))

    const result = planFromDisk(NOON)

    expect(result.dispatch.map(d => d.task)).toEqual(['DM-4'])
    expect(result.refusals.map(r => [r.task, r.kind])).toEqual(
      expect.arrayContaining([
        ['DM-1', 'reserved-tag'],
        ['DM-2', 'no-estimate'],
        ['DM-3', 'claimed'],
      ]),
    )
  })

  it('never reads an initiative without an autonomy block', () => {
    initiative('demo', '', { 'DM-1': task('DM-1') })
    account('agents', { seven_day: 40, five_hour: 10 }, [repo()])

    const result = planFromDisk(NOON)

    expect(result).toEqual({ dispatch: [], refusals: [], notOptedIn: ['demo'] })
  })
})

describe('autonomy frontmatter', () => {
  it('reads block lists and ignores trailing comments', () => {
    const text = brief(
      'autonomy:\n  mode: burndown  # opted in\n  accounts:\n    - agents\n    - personal\n  grants: [merge-on-green-approve]\n',
    )

    expect(parseAutonomy(text)).toEqual({
      mode: 'burndown',
      lanes: 1,
      accounts: ['agents', 'personal'],
      grants: ['merge-on-green-approve'],
    })
  })

  it('treats any other mode as not opted in', () => {
    expect(parseAutonomy(brief('autonomy:\n  mode: manual\n'))).toBeUndefined()
  })
})

describe('grant keywords', () => {
  it('sends a merge to the backlog without the merge grant and passes it with one', () => {
    expect(grantGap('PR merged to main', [])).toContain('merge-on-green-approve')
    expect(grantGap('PR merged to main', ['merge-on-green-approve'])).toBeUndefined()
  })

  it('never lets a grant unlock a broker restart', () => {
    expect(grantGap('shipped in a planned restart window', ['merge-on-green-approve'])).toContain(
      'human-only',
    )
  })
})

describe('budget gate', () => {
  const rule = { reserve_seven_day: 25, ceiling_five_hour: 70, night: { reserve_seven_day: 10 } }
  const reading = { sevenDay: 80, fiveHour: 10, ageSeconds: 5 }
  const night = new Date(2026, 8, 26, 2, 0)

  it('lowers the reserve at night only when the human has been gone half an hour', () => {
    const away = gateAccount('agents', rule, reading, {
      now: night,
      humanLastTurnAt: night.getTime() - 3_600_000,
    })
    const unknown = gateAccount('agents', rule, reading, { now: night })

    expect(away.open).toBe(true)
    expect(unknown.open).toBe(false)
  })

  it('stays closed with no reading rather than assuming zero usage', () => {
    expect(gateAccount('agents', rule, undefined, { now: NOON }).open).toBe(false)
  })
})

describe('account budget', () => {
  it('takes the freshest session reading under the config dir', () => {
    const dir = path.join(world, 'acct')
    const at = (id: string, writtenAt: number, sevenDay: number): void =>
      write(
        path.join(dir, 'status-cache', 'sessions', `${id}.json`),
        JSON.stringify({
          session_id: id,
          written_at: writtenAt,
          rate_limits: { seven_day: { used_percentage: sevenDay } },
        }),
      )
    at('old', 1_000, 10)
    at('new', 2_000, 55)

    const read = readAccountBudget(dir, 2_100_000)

    expect(read.found && read.budget.rate_limits.seven_day?.used_pct).toBe(55)
  })
})

describe('claim ledger', () => {
  const claim: Claim = {
    taskId: 'DM-1',
    initiative: 'demo',
    agentId: 'a1',
    spawnedAt: '2026-09-26T08:00:00.000Z',
    phase: 'implementing',
    phaseAt: '2026-09-26T08:00:00.000Z',
  }

  it('round-trips through an atomic write and refuses a second claim on a held task', () => {
    const file = path.join(world, 'home', 'burndown.json')
    writeLedger(file, addClaim(EMPTY_LEDGER, claim))

    const read = readLedger(file)

    expect(read.claims).toEqual([claim])
    expect(() => addClaim(read, claim)).toThrow('already claimed')
  })

  it('marks an implementing claim stalled after four hours', () => {
    expect(isStalled(claim, new Date('2026-09-26T11:59:00.000Z'))).toBe(false)
    expect(isStalled(claim, new Date('2026-09-26T12:01:00.000Z'))).toBe(true)
  })

  it('refuses to read a malformed ledger rather than treating it as empty', () => {
    const file = path.join(world, 'home', 'burndown.json')
    write(file, '{"claims": "nope"}')

    expect(() => readLedger(file)).toThrow('malformed')
  })
})
