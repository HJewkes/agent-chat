import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { invokeCommand } from '@titan-design/registry'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrokerClient } from '../client/broker-client.js'
import { withBroker } from '../cli/client.js'
import type { Report, Verb, VerbContext } from '../cli/command.js'
import { PortEnvelope } from '../cli/port.js'
import {
  PortSpawnFrame,
  SpawnPortOutput,
  portResumeVerbWith,
  portRetireVerb,
  portSpawnVerbWith,
} from '../cli/verbs/port-agent.js'
import { spawnFrame } from '../agents/burndown/execute.js'
import type { ClientMessage, SpawnResultFields } from '../protocol.js'
import { socketPath } from '../paths.js'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-port-agent-'))
  process.env.AGENT_CHAT_HOME = home
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(home, { recursive: true, force: true })
})

const frame = spawnFrame({
  name: 'agent-x',
  profile: 'worker',
  brief: 'do the synthetic task',
  cwd: '/tmp/repo',
  configDir: '/tmp/config',
  initiative: 'demo',
  taskId: 'DEMO-1',
})

/** A broker that answers every frame with `reply` and records what it was sent. */
function answering(reply: SpawnResultFields | Error) {
  const sent: ClientMessage[] = []
  const ctx: VerbContext = {
    warnings: [],
    format: 'human',
    withBroker: async fn =>
      fn({
        request: async (msg: ClientMessage) => {
          sent.push(msg)
          if (reply instanceof Error) throw reply
          return { t: 'spawn_result', ...reply }
        },
      } as unknown as BrokerClient),
  }
  return { ctx, sent }
}

async function report<A>(verb: Verb<A>, args: NoInfer<A>, ctx: VerbContext): Promise<Report> {
  const { envelope } = await invokeCommand(verb, args, ctx)
  expect(envelope.ok).toBe(true)
  return (envelope as { data: Report }).data
}

const spawn = (stdin: string, ctx: VerbContext) =>
  report(
    portSpawnVerbWith(async () => stdin),
    { frameStdin: true },
    ctx,
  )

const envelopeOf = (r: Report) => PortEnvelope.parse(JSON.parse(r.lines[0]!))

describe('agent-chat port spawn', () => {
  it("sends burndown's frame unchanged and prints the agent id", async () => {
    const { ctx, sent } = answering({ ok: true, agentId: 'id-1', name: 'agent-x', warnings: ['w'] })

    const r = await spawn(JSON.stringify(frame), ctx)

    expect(r.ok).toBe(true)
    expect(r.lines).toHaveLength(1)
    const envelope = envelopeOf(r)
    if (!envelope.ok) throw new Error('expected ok envelope')
    expect(SpawnPortOutput.parse(envelope.data)).toMatchObject({ agentId: 'id-1', warnings: ['w'] })
    expect(sent).toEqual([frame])
  })

  it.each([
    ['spawnedAs shepherd', { ...frame, spawnedAs: 'shepherd' }],
    ['no task', { ...frame, task: undefined }],
    ['a blank task', { ...frame, task: '  ' }],
    ['a field the tick never sends', { ...frame, forkFrom: 'agent-y' }],
    ['a visible surface', { ...frame, surface: 'pane' }],
  ])('refuses a frame with %s as a usage error and sends nothing', async (_case, bad) => {
    const { ctx, sent } = answering({ ok: true })

    const r = await spawn(JSON.stringify(bad), ctx)

    expect(r.exit).toBe(64)
    expect(envelopeOf(r)).toMatchObject({ ok: false, error: { code: 'invalid_input', retryable: false } })
    expect(sent).toEqual([])
  })

  it('refuses stdin that is not JSON as a usage error', async () => {
    const { ctx, sent } = answering({ ok: true })

    const r = await spawn('not json', ctx)

    expect(r.exit).toBe(64)
    expect(sent).toEqual([])
  })

  // Mutation caught: dropping retryAfterMs from the refusal mapping.
  it('passes broker_draining through as retryable with its delay', async () => {
    const { ctx } = answering({
      ok: false,
      reason: 'the broker is draining for a restart',
      code: 'broker_draining',
      retryable: true,
      retryAfterMs: 30_000,
    })

    const r = await spawn(JSON.stringify(frame), ctx)

    expect(r.ok).toBe(false)
    expect(r.exit).toBe(1)
    expect(envelopeOf(r)).toEqual({
      ok: false,
      error: {
        code: 'broker_draining',
        message: 'the broker is draining for a restart',
        retryable: true,
        retryAfterMs: 30_000,
      },
    })
  })

  it('names a refusal without a code spawn_refused, not retryable', async () => {
    const { ctx } = answering({ ok: false, reason: 'name taken' })

    const r = await spawn(JSON.stringify(frame), ctx)

    expect(envelopeOf(r)).toEqual({
      ok: false,
      error: { code: 'spawn_refused', message: 'name taken', retryable: false },
    })
  })

  it('reports a spawn whose reply never came as broker_timeout with unknown set', async () => {
    const { ctx } = answering(new Error('broker did not answer spawn_result'))

    const r = await spawn(JSON.stringify(frame), ctx)

    expect(envelopeOf(r)).toMatchObject({ ok: false, error: { code: 'broker_timeout', unknown: true } })
  })

  it('exits 69 with broker_unavailable and starts no broker when none is listening', async () => {
    const r = await spawn(JSON.stringify(frame), { warnings: [], format: 'human', withBroker })

    expect(r.exit).toBe(69)
    expect(envelopeOf(r)).toMatchObject({ ok: false, error: { code: 'broker_unavailable' } })
    expect(fs.existsSync(socketPath())).toBe(false)
  })

  it("accepts every frame burndown's own spawnFrame builds", () => {
    const full = spawnFrame({
      name: 'agent-z',
      profile: 'worker',
      brief: 'b',
      cwd: '/tmp/repo',
      configDir: '/tmp/config',
      initiative: 'demo',
      taskId: 'DEMO-2',
      predecessor: 'agent-y',
      worktree: '/tmp/repo/.worktrees/agent-z',
      tier: 2,
      claimPaths: ['src/a.ts'],
    })

    expect(PortSpawnFrame.parse(full)).toEqual(full)
  })
})

describe('agent-chat port retire', () => {
  it('retires by name alone, never forced, and keeps a caveat reason on ok', async () => {
    const { ctx, sent } = answering({ ok: true, reason: 'process still running' })

    const r = await report(portRetireVerb, { name: 'agent-x' }, ctx)

    expect(sent).toEqual([{ t: 'retire', name: 'agent-x' }])
    const envelope = envelopeOf(r)
    if (!envelope.ok) throw new Error('expected ok envelope')
    expect(SpawnPortOutput.parse(envelope.data).reason).toBe('process still running')
  })

  it('maps a refused retire to retire_refused', async () => {
    const { ctx } = answering({ ok: false, reason: 'no agent named agent-x' })

    const r = await report(portRetireVerb, { name: 'agent-x' }, ctx)

    expect(envelopeOf(r)).toMatchObject({ ok: false, error: { code: 'retire_refused' } })
  })
})

describe('agent-chat port resume', () => {
  const resume = (stdin: string, ctx: VerbContext) =>
    report(
      portResumeVerbWith(async () => stdin),
      { name: 'agent-x', messageStdin: true },
      ctx,
    )

  it('resumes headless on the message from stdin', async () => {
    const { ctx, sent } = answering({ ok: true, transcript: { path: '/tmp/t.jsonl', found: true } })

    const r = await resume('wake up', ctx)

    expect(sent).toEqual([{ t: 'resume', name: 'agent-x', surface: 'headless', message: 'wake up' }])
    const envelope = envelopeOf(r)
    if (!envelope.ok) throw new Error('expected ok envelope')
    expect(SpawnPortOutput.parse(envelope.data).transcript).toEqual({ path: '/tmp/t.jsonl', found: true })
  })

  it('refuses an empty message as a usage error and sends nothing', async () => {
    const { ctx, sent } = answering({ ok: true })

    const r = await resume('  \n', ctx)

    expect(r.exit).toBe(64)
    expect(sent).toEqual([])
  })
})
