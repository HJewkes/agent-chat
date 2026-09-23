import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventLog } from '../broker/event-log.js'
import { AgentLog } from '../agents/identity.js'
import { resolvePredecessor } from '../agents/predecessor.js'
import { transcriptPath } from '../agents/transcript.js'

/**
 * CC-133. A successor is briefed from the log: its predecessor's last report to
 * whoever spawned it, where its work sits, and where its conversation is.
 */

const SESSION = '11111111-2222-4333-8444-555555555555'
const tmpDirs: string[] = []
let events: EventLog
let agents: AgentLog

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** Advance the clock so rows written by consecutive calls never share a millisecond. */
const tick = (): void => {
  vi.advanceTimersByTime(10)
}

function spawnWorker(opts: { name?: string; by?: string; configDir?: string } = {}): string {
  const agentId = `a${Math.random().toString(16).slice(2, 8)}`
  tick()
  events.append({
    kind: 'agent_spawned',
    actor: opts.by ?? 'coord',
    target: opts.name ?? 'worker',
    msgId: agentId,
    body: 'first assignment',
    meta: {
      name: opts.name ?? 'worker',
      profile: 'implementer',
      cwd: '/repo/.worktrees/worker',
      session_id: SESSION,
      ...(opts.configDir ? { config_dir: opts.configDir } : {}),
    },
  })
  events.append({
    kind: 'isolation_allocated',
    actor: opts.name ?? 'worker',
    ref: agentId,
    meta: { strategy: 'worktree', branch: 'agent-chat/worker', worktree: '/repo/.worktrees/worker' },
  })
  return agentId
}

function send(from: string, to: string, body: string): void {
  tick()
  events.append({ kind: 'message', actor: from, target: to, body })
}

const sectionOf = (result: ReturnType<typeof resolvePredecessor>): string =>
  'text' in result ? result.text : `ERROR: ${result.error}`

beforeEach(() => {
  vi.useFakeTimers()
  const dir = tmp('agent-chat-pred-')
  events = new EventLog(path.join(dir, 'events.db'))
  agents = new AgentLog(events)
})

afterEach(() => {
  events.close()
  vi.useRealTimers()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the predecessor section of a successor briefing', () => {
  it("carries the predecessor's newest report to its spawner, its branch, worktree and session", () => {
    spawnWorker()
    send('worker', 'coord', 'Status: DONE_WITH_CONCERNS. First report.')
    send('worker', 'coord', 'Status: DONE. PR #90 on agent-chat/worker.')
    send('worker', 'peer', 'unrelated chatter to a peer')

    const text = sectionOf(resolvePredecessor(agents, events, 'worker', 'coord'))

    expect(text).toContain('# Predecessor: worker')
    expect(text).toContain('Status: DONE. PR #90 on agent-chat/worker.')
    expect(text).not.toContain('First report')
    expect(text).not.toContain('unrelated chatter')
    expect(text).toContain('- Branch: agent-chat/worker')
    expect(text).toContain('- Worked in: /repo/.worktrees/worker')
    expect(text).toContain(`- Session id: ${SESSION}`)
  })

  it('falls back to its newest message to anyone when it never wrote to its spawner', () => {
    spawnWorker()
    send('worker', 'reviewer', 'handed the diff to the reviewer')

    expect(sectionOf(resolvePredecessor(agents, events, 'worker', 'coord'))).toContain(
      'Its last report (to reviewer',
    )
  })

  it('ignores messages an earlier holder of the same name sent before this one was spawned', () => {
    send('worker', 'coord', 'a report from a previous agent called worker')
    spawnWorker()

    const text = sectionOf(resolvePredecessor(agents, events, 'worker', 'coord'))

    expect(text).not.toContain('previous agent')
    expect(text).toContain('sent no message after it was spawned')
  })

  it('points at the transcript when it is on disk', () => {
    const configDir = tmp('agent-chat-cfg-')
    spawnWorker({ configDir })
    const file = transcriptPath('/repo/.worktrees/worker', SESSION, configDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{}\n')

    expect(sectionOf(resolvePredecessor(agents, events, 'worker', 'coord'))).toContain(
      `- Transcript: ${file}`,
    )
  })

  it('warns while the predecessor is unretired, and not once it is', () => {
    const agentId = spawnWorker()
    events.append({ kind: 'agent_attached', actor: 'worker', ref: agentId })

    expect(resolvePredecessor(agents, events, 'worker', 'coord')).toMatchObject({
      warning: expect.stringMatching(/worker is live, not retired/),
    })

    events.append({ kind: 'isolation_released', actor: 'worker', ref: agentId })
    events.append({ kind: 'agent_retired', actor: 'human', target: 'worker', ref: agentId })
    const retired = resolvePredecessor(agents, events, 'worker', 'coord')

    expect(retired).not.toHaveProperty('warning')
    expect(sectionOf(retired)).toContain('/repo/.worktrees/worker (removed when it was retired)')
  })

  it("refuses to hand over an agent someone else spawned, since the section copies that agent's report", () => {
    spawnWorker({ by: 'other-coord' })

    expect(resolvePredecessor(agents, events, 'worker', 'coord')).toEqual({
      error: expect.stringMatching(/spawned by other-coord, not by you/),
    })
    expect(resolvePredecessor(agents, events, 'worker', 'human')).toHaveProperty('text')
  })

  it('refuses a name no spawned agent ever held', () => {
    expect(resolvePredecessor(agents, events, 'nobody', 'coord')).toEqual({
      error: 'no spawned agent named "nobody" to take over from',
    })
  })
})
