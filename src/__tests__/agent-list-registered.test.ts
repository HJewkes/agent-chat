import { describe, expect, it } from 'vitest'
import type { AgentIdentity } from '../protocol.js'
import { agentList } from '../server/commands/agent-list.js'

const worker = (state: AgentIdentity['state']): AgentIdentity => ({
  agentId: 'a1',
  name: 'worker',
  profile: 'implementer',
  state,
  origin: 'spawned',
  spawnedBy: 'boss',
  spawnedAt: 1,
  brief: 'do it',
  cwd: '/tmp/cc217-nowhere',
  isolation: 'none',
  surface: 'headless',
  sessionId: 'cc217-session',
  configDir: '/tmp/cc217-config',
  lastEventAt: 2,
  generation: 1,
})

const workerRow = async (agent: AgentIdentity, sessionNames: string[]): Promise<string> => {
  const ctx = {
    registeredName: 'boss',
    broker: {
      request: async (m: { t: string }) =>
        m.t === 'list'
          ? { t: 'list_result', sessions: sessionNames.map(name => ({ name })) }
          : { t: 'agents_result', agents: [agent] },
    },
  } as never
  const out = await agentList.run({}, ctx)
  return out.split('\n').find(line => line.startsWith('- worker ')) ?? ''
}

describe('agent_list against the registered sessions chat_list shows', () => {
  it('marks an attached agent that never called chat_register', async () => {
    const row = await workerRow(worker('live'), [])

    expect(row).toContain('[live, attached-unregistered, implementer, headless')
  })

  it('leaves an attached agent with a registered session unmarked', async () => {
    const row = await workerRow(worker('live'), ['worker'])

    expect(row).toContain('[live, implementer, headless')
    expect(row).not.toContain('attached-unregistered')
  })

  it('marks an attached agent whose session holds only the derived name', async () => {
    const row = await workerRow(worker('live'), ['unregistered session in /tmp/x'])

    expect(row).toContain('attached-unregistered')
  })

  it('does not mark a detached or exited agent with no session', async () => {
    const detached = await workerRow(worker('detached'), [])
    const exited = await workerRow(worker('exited'), [])

    expect(detached).toContain('[detached, ')
    expect(exited).toContain('[exited, ')
    expect(`${detached}${exited}`).not.toContain('attached-unregistered')
  })
})
