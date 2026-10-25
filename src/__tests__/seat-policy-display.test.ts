import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentIdentity } from '../protocol.js'
import { agentList } from '../server/commands/agent-list.js'
import { agentProfiles } from '../server/commands/agent-profiles.js'

/** CC-1616: agent_list and agent_profiles show a policy seat's root and ceiling. Every name is synthetic. */

const SEAT = 'example-seat'
const POLICY = {
  version: 1,
  seats: {
    [SEAT]: { root: true, launchProfiles: ['example-coord'], ceiling: ['example-worker', 'example-coord'] },
  },
}

let home: string
const previousHome = process.env['AGENT_CHAT_HOME']

const writePolicy = (): void => {
  const file = path.join(home, 'seat-policy.json')
  fs.writeFileSync(file, JSON.stringify(POLICY))
  fs.chmodSync(file, 0o644)
}

const agent = (over: Partial<AgentIdentity>): AgentIdentity => ({
  agentId: 'a1',
  name: SEAT,
  profile: 'example-coord',
  state: 'live',
  origin: 'spawned',
  spawnedBy: 'human',
  spawnedAt: 1,
  brief: 'hold the seat',
  cwd: '/tmp/cc1616-nowhere',
  isolation: 'none',
  surface: 'headless',
  sessionId: 'cc1616-session',
  configDir: '/tmp/cc1616-config',
  lastEventAt: 2,
  generation: 1,
  ...over,
})

const ctxFor = (agents: AgentIdentity[], registeredName: string | null) =>
  ({
    registeredName,
    broker: {
      request: async (m: { t: string }) =>
        m.t === 'list'
          ? { t: 'list_result', sessions: agents.map(a => ({ name: a.name })) }
          : { t: 'agents_result', agents },
    },
  }) as never

const listRows = async (agents: AgentIdentity[]): Promise<string> => agentList.run({}, ctxFor(agents, 'boss'))

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc1616-')))
  process.env['AGENT_CHAT_HOME'] = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env['AGENT_CHAT_HOME']
  else process.env['AGENT_CHAT_HOME'] = previousHome
  fs.rmSync(home, { recursive: true, force: true })
})

describe('agent_list on a seat-policy root', () => {
  it('marks the row of a listed seat held under a launch profile', async () => {
    writePolicy()

    expect(await listRows([agent({})])).toContain('root seat (seat-policy.json)')
  })

  it('marks a teleport successor recorded as adopted', async () => {
    writePolicy()

    const out = await listRows([agent({ origin: 'adopted', teleportFrom: 'prev' })])

    expect(out).toContain('root seat (seat-policy.json)')
  })

  it('leaves the row unmarked when the policy file is absent', async () => {
    expect(await listRows([agent({})])).not.toContain('root seat')
  })

  it('leaves a launch under a profile outside launchProfiles unmarked', async () => {
    writePolicy()

    expect(await listRows([agent({ profile: 'example-worker' })])).not.toContain('root seat')
  })

  it('leaves a hand-started session of the same name unmarked', async () => {
    writePolicy()

    expect(await listRows([agent({ origin: 'adopted' })])).not.toContain('root seat')
  })
})

describe('agent_profiles called by a seat-policy root', () => {
  it('lists the seat ceiling', async () => {
    writePolicy()

    const out = await agentProfiles.run({}, ctxFor([agent({})], SEAT))

    expect(out).toContain(`You hold root seat "${SEAT}"`)
    expect(out).toContain('Spawn ceiling, by profile name: example-worker, example-coord')
  })

  it('lists no ceiling for a session that only carries the seat name', async () => {
    writePolicy()

    const out = await agentProfiles.run({}, ctxFor([agent({ origin: 'adopted' })], SEAT))

    expect(out).not.toContain('Spawn ceiling')
  })

  it('lists no ceiling for a caller the policy does not name', async () => {
    writePolicy()

    const out = await agentProfiles.run({}, ctxFor([agent({})], 'someone-else'))

    expect(out).not.toContain('Spawn ceiling')
  })

  it('lists no ceiling when the policy file is absent', async () => {
    const out = await agentProfiles.run({}, ctxFor([agent({})], SEAT))

    expect(out).not.toContain('Spawn ceiling')
  })
})
