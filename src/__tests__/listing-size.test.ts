import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentIdentity } from '../protocol.js'
import { agentList } from '../server/commands/agent-list.js'
import { agentProfiles } from '../server/commands/agent-profiles.js'

/**
 * CC-1597: a coordinator's tool result overflows at about 8k chars, and both
 * listings ran to ~56k on a machine with a long history. The fixtures are sized
 * like that machine: two dozen profiles with ~170 denied command patterns each,
 * and 150 agents mostly exited.
 */
const BOUND = 8000

const DENIED = Array.from({ length: 170 }, (_, i) => `Bash(fixture-cli subcommand-${i} --flag:*)`)
const ALLOWED = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash',
  'mcp__plugin_agent-chat_agent-chat__chat_send',
]
const DESCRIPTION =
  'Implements one task in an isolated worktree, runs the verify script, opens a pull request and reports to ' +
  'its spawner. Never merges, never deploys, never edits settings or hooks, and stops when it is blocked.'

let dir: string
const previousHome = process.env['AGENT_CHAT_HOME']

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc1597-'))
  process.env['AGENT_CHAT_HOME'] = dir
  fs.mkdirSync(path.join(dir, 'profiles'))
  for (let i = 0; i < 24; i += 1) {
    const body = {
      description: DESCRIPTION,
      model: 'opus',
      effort: 'high',
      allowedTools: ALLOWED,
      disallowedTools: ['AskUserQuestion', ...DENIED],
      isolation: 'worktree',
      surface: 'headless',
      promptPrelude: '',
    }
    fs.writeFileSync(path.join(dir, 'profiles', `fixture-implementer-${i}.json`), JSON.stringify(body))
  }
})

afterEach(() => {
  if (previousHome === undefined) delete process.env['AGENT_CHAT_HOME']
  else process.env['AGENT_CHAT_HOME'] = previousHome
  fs.rmSync(dir, { recursive: true, force: true })
})

const agent = (i: number): AgentIdentity => ({
  agentId: `agent-${i}`,
  name: `fx-worker-${1000 + i}`,
  profile: 'fx-implementer',
  state: i < 5 ? 'detached' : 'exited',
  origin: 'spawned',
  spawnedBy: 'fixture-operator',
  launchedBy: 'seat-watchdog',
  spawnedAt: i,
  brief: 'do it',
  cwd: `/tmp/cc1597/projects/fixture-repo/.worktrees/fx-worker-${1000 + i}`,
  isolation: 'worktree',
  surface: 'headless',
  sessionId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  configDir: '/tmp/cc1597/config-fixture-account',
  host: 'fixture-host',
  lastEventAt: i,
  generation: 1,
})

const listRoster = (args: Parameters<typeof agentList.run>[0]): Promise<string> => {
  const roster = Array.from({ length: 150 }, (_, i) => agent(i))
  const broker = {
    request: async (m: { t: string }) =>
      m.t === 'list' ? { t: 'list_result', sessions: [] } : { t: 'agents_result', agents: roster },
  }
  return agentList.run(args, { registeredName: 'fixture-operator', broker } as never)
}

describe('agent_profiles over two dozen profiles with long deny lists', () => {
  it('fits the bound by default, one line per profile with the denies counted', async () => {
    const out = await agentProfiles.run({}, {} as never)

    expect(out.length).toBeLessThan(BOUND)
    expect(out).toContain('- fixture-implementer-3 [worker, opus, effort high, headless, isolation worktree')
    expect(out).toMatch(/fixture-implementer-3 [^\n]*\(7 tools, \d{3} denied\)/)
    expect(out).not.toContain('fixture-cli subcommand-')
  })

  it('still lists every deny for a named profile', async () => {
    const out = await agentProfiles.run({ name: 'fixture-implementer-3' }, {} as never)

    expect(out).toContain('denies: AskUserQuestion, Bash(fixture-cli subcommand-0 --flag:*)')
    expect(out).toContain('Bash(fixture-cli subcommand-169 --flag:*)')
    expect(out).toContain(`    ${DESCRIPTION}`)
  })

  it('lists every profile in full with verbose, which is what overflowed', async () => {
    const out = await agentProfiles.run({ verbose: true }, {} as never)

    expect(out.length).toBeGreaterThan(5 * BOUND)
    expect(out).toContain('    tools: Read, Edit, Write')
  })
})

describe('agent_list over 150 mostly exited agents', () => {
  it('fits the bound with include_finished and limit 150, one line per agent', async () => {
    const out = await listRoster({ include_finished: true, limit: 150 })

    const rows = out.split('\n').filter(line => line.startsWith('- '))
    expect(out.length).toBeLessThan(BOUND)
    expect(rows).toHaveLength(150)
    expect(rows[0]).toBe('- fx-worker-1000 [detached, fx-implementer]')
  })

  it('adds spawner, cwd and transcript with verbose', async () => {
    const out = await listRoster({ include_finished: true, limit: 150, verbose: true })

    expect(out.length).toBeGreaterThan(3 * BOUND)
    expect(out).toContain('spawned by fixture-operator (seat-watchdog)')
    expect(out).toContain('    /tmp/cc1597/projects/fixture-repo/.worktrees/fx-worker-1000\n    transcript: ')
  })

  it('keeps the session a retired row needs for resume_session', async () => {
    const retired = { ...agent(7), state: 'retired' as const }
    const broker = {
      request: async (m: { t: string }) =>
        m.t === 'list' ? { t: 'list_result', sessions: [] } : { t: 'agents_result', agents: [retired] },
    }

    const out = await agentList.run({ include_retired: true }, { registeredName: 'x', broker } as never)

    expect(out).toContain(`- fx-worker-1007 [retired, fx-implementer] session: ${retired.sessionId}`)
  })
})
