import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolHandler } from '../server/tools.js'
import { agentProfiles } from '../server/commands/agent-profiles.js'
import { profiles } from '../cli/agents.js'
import type { BrokerClient } from '../client/broker-client.js'
import type { ServerMessage, SessionInfo } from '../protocol.js'

const session = (name: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  name,
  workingOn: 'task',
  cwd: '/repo',
  status: 'available',
  dnd: false,
  idleMs: 1000,
  registeredAt: 0,
  ...over,
})
const roster: SessionInfo[] = [
  session('alpha', { status: 'working', tags: [{ tag: 'owner:src', by: '*self*', at: 0 }] }),
  session('beta'),
  session('gamma', { status: 'working' }),
]
const handler = () =>
  new ToolHandler({
    request: async () => ({ t: 'list_result', sessions: roster }) as ServerMessage,
  } as unknown as BrokerClient)
const list = async (args: Record<string, unknown>) =>
  ((await handler().handle('chat_list', args)) as { content: { text: string }[] }).content[0]!.text
const rowNames = (out: string) =>
  out
    .split('\n')
    .filter(l => l.startsWith('- '))
    .map(l => l.split(' ')[1])

describe('chat_list filters', () => {
  it('returns everyone without filters', async () => {
    expect(rowNames(await list({}))).toEqual(['alpha', 'beta', 'gamma'])
  })
  it('filters by name', async () => {
    expect(rowNames(await list({ name: 'beta' }))).toEqual(['beta'])
  })
  it('filters by tag', async () => {
    expect(rowNames(await list({ tag: 'owner:src' }))).toEqual(['alpha'])
  })
  it('filters to working sessions with active', async () => {
    expect(rowNames(await list({ active: true }))).toEqual(['alpha', 'gamma'])
  })
  it('returns an empty list, not an error, for an unknown name', async () => {
    expect(await list({ name: 'nobody' })).toBe('No sessions are registered.')
  })
})

describe('agent_profiles name filter', () => {
  const homes: string[] = []
  afterEach(() => {
    delete process.env.AGENT_CHAT_HOME
    for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true })
  })
  const withProfiles = (names: string[]) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-prof-'))
    homes.push(home)
    process.env.AGENT_CHAT_HOME = home
    fs.mkdirSync(path.join(home, 'profiles'))
    for (const n of names)
      fs.writeFileSync(
        path.join(home, 'profiles', `${n}.json`),
        JSON.stringify({
          description: 'd',
          model: 'opus',
          allowedTools: ['Read'],
          isolation: 'none',
          surface: 'headless',
        }),
      )
  }
  const run = (name?: string) => agentProfiles.run({ name } as never, {} as never)

  it('lists every profile without a name', async () => {
    withProfiles(['deep', 'plain'])
    const out = String(await run())
    expect(out).toContain('- deep [')
    expect(out).toContain('- plain [')
  })
  it('returns only the named profile', async () => {
    withProfiles(['deep', 'plain'])
    const out = String(await run('deep'))
    expect(out).toContain('- deep [')
    expect(out).not.toContain('- plain [')
  })
  it('errors on an unknown name, listing close matches', async () => {
    withProfiles(['deep', 'plain'])
    await expect(run('plan')).rejects.toThrow(/No profile "plan"\. Close matches:.*plain/)
  })
  it('CLI profiles() filters and reports an unknown name', () => {
    withProfiles(['deep', 'plain'])
    expect(profiles('deep').lines.join('\n')).not.toContain('plain')
    const bad = profiles('plan')
    expect(bad.ok).toBe(false)
    expect(bad.errors?.[0]).toMatch(/Close matches:.*plain/)
  })
  it('describes the parameter', () => {
    expect(agentProfiles.description).toContain('name')
  })
})
