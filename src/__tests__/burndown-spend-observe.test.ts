import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Claim } from '../agents/burndown/ledger.js'
import { observe, type ObserveDeps, type Roster } from '../agents/burndown/observe.js'
import { projectSlug } from '../agents/transcript.js'
import { readTranscriptSpend, type TranscriptSpendRead } from '../agents/transcript-spend.js'
import type { AgentIdentity } from '../protocol.js'

/** CC-723: the observe step's per-claim spend read, over fixture transcripts in a temp config dir. */

const CWD = '/repo/.worktrees/sd-cc-1'
const TS = '2026-02-03T04:05:00.000Z'
const KEY = 'CC-1#'

let configDir: string

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-spend-observe-'))
})

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true })
})

const assistant = (id: string, inputTokens: number) => ({
  type: 'assistant',
  timestamp: TS,
  message: {
    id,
    model: 'claude-opus-5-5',
    role: 'assistant',
    usage: { input_tokens: inputTokens, output_tokens: 1000 },
  },
})

/** Writes the agent's transcript where `findTranscript` derives it, and returns its path. */
function writeTranscript(sessionId: string, inputTokens: number): string {
  const file = path.join(configDir, 'projects', projectSlug(CWD), `${sessionId}.jsonl`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(assistant(`msg-${sessionId}`, inputTokens))}\n`)
  return file
}

const agentRow = (name: string, sessionId: string, spawnedAt = 1): AgentIdentity =>
  ({ name, agentId: `id-${name}`, sessionId, cwd: CWD, configDir, state: 'live', spawnedAt }) as AgentIdentity

const claim = (over: Partial<Claim> = {}): Claim =>
  ({
    taskId: 'CC-1',
    initiative: 'demo',
    seat: 'alpha',
    phase: 'implementing',
    phaseAt: TS,
    spawnedAt: TS,
    agentName: 'sd-cc-1-s1',
    worktree: CWD,
    spawned: ['sd-cc-1', 'sd-cc-1-s1', 'sd-cc-1-r0'],
    ...over,
  }) as Claim

const baseDeps = (over: Partial<ObserveDeps> = {}): ObserveDeps => ({
  inboxSince: async () => [],
  root: configDir,
  activity: () => 'unknown',
  progress: () => 'unreadable',
  spendCap: () => 30,
  ...over,
})

function recordingSpend(): { calls: string[]; spend: NonNullable<ObserveDeps['spend']> } {
  const calls: string[] = []
  const spend = async (agent: AgentIdentity): Promise<TranscriptSpendRead> => {
    calls.push(agent.name)
    return { ok: false, path: agent.name, reason: 'recorded' }
  }
  return { calls, spend }
}

const threeAgents = (): Roster => ({
  agents: [agentRow('sd-cc-1', 's-0'), agentRow('sd-cc-1-s1', 's-1'), agentRow('sd-cc-1-r0', 's-2')],
})

describe('observing a claim spend', () => {
  it('sums the original, successor and reviewer transcripts, not only the current agent', async () => {
    const files = [
      writeTranscript('s-0', 100_000),
      writeTranscript('s-1', 200_000),
      writeTranscript('s-2', 300_000),
    ]
    const reads = await Promise.all(files.map(readTranscriptSpend))
    const usd = reads.reduce((sum, r) => sum + (r.ok ? (r.usd_est ?? 0) : 0), 0)

    const { observations } = await observe([claim()], threeAgents(), baseDeps())

    const spend = observations.get(KEY)?.spend
    expect(spend?.cap).toBe(30)
    expect(spend?.claim).toMatchObject({ agents: 3, tokens: 603_000, unknown: [] })
    expect(spend?.claim.usd).toBeCloseTo(usd, 4)
    expect(spend?.claim.usd).toBeGreaterThan(0)
  })

  it('puts a spawned name with no agent row into unknown', async () => {
    writeTranscript('s-0', 100_000)
    const roster = { agents: [agentRow('sd-cc-1', 's-0')] }

    const { observations } = await observe(
      [claim({ spawned: ['sd-cc-1', 'sd-cc-1-s1'] })],
      roster,
      baseDeps(),
    )

    expect(observations.get(KEY)?.spend?.claim).toMatchObject({ agents: 2, unknown: ['sd-cc-1-s1'] })
  })

  it('reads no transcript for a seat without per_claim_usd', async () => {
    const { calls, spend } = recordingSpend()

    const { observations } = await observe(
      [claim()],
      threeAgents(),
      baseDeps({ spend, spendCap: () => undefined }),
    )

    expect(calls).toEqual([])
    expect(observations.get(KEY)?.spend).toBeUndefined()
  })

  it('reads no transcript for a claim with no seat', async () => {
    const { calls, spend } = recordingSpend()
    const capped: string[] = []

    await observe(
      [claim({ seat: undefined })],
      threeAgents(),
      baseDeps({ spend, spendCap: s => (capped.push(s), 30) }),
    )

    expect(calls).toEqual([])
    expect(capped).toEqual([])
  })

  it('reads no transcript when the default cap finds no seat file', async () => {
    const { calls, spend } = recordingSpend()

    const { spendCap: _, ...defaultCap } = baseDeps({ spend })

    await observe([claim()], threeAgents(), defaultCap)

    expect(calls).toEqual([])
  })

  it('gives no cap and keeps the rest of the observation when the seat file fails to load', async () => {
    const throwing = baseDeps({
      spendCap: () => {
        throw new Error('bad seat file')
      },
    })

    const { observations, unread } = await observe([claim()], threeAgents(), throwing)

    expect(unread).toEqual([])
    expect(observations.get(KEY)).toEqual({
      agent: { id: 'id-sd-cc-1-s1', state: 'live' },
      activity: { read: 'unknown', spawnedAt: 1 },
      progress: 'unreadable',
    })
  })

  it('reads each seat cap once per tick', async () => {
    const capped: string[] = []
    const { spend } = recordingSpend()
    const claims = [claim(), claim({ taskId: 'CC-2' }), claim({ taskId: 'CC-3', seat: 'beta' })]

    await observe(claims, threeAgents(), baseDeps({ spend, spendCap: s => (capped.push(s), 30) }))

    expect(capped).toEqual(['alpha', 'beta'])
  })

  it('puts an agent whose spend read throws into unknown and keeps the rest of the observation', async () => {
    const throwing = baseDeps({
      spend: agent => {
        if (agent.name === 'sd-cc-1-s1') throw new Error('transcript path unresolvable')
        return Promise.resolve({ ok: false, path: agent.name, reason: 'recorded' })
      },
    })

    const { observations, unread } = await observe([claim()], threeAgents(), throwing)

    expect(unread).toEqual([])
    expect(observations.get(KEY)).toMatchObject({
      agent: { id: 'id-sd-cc-1-s1', state: 'live' },
      activity: { read: 'unknown', spawnedAt: 1 },
      progress: 'unreadable',
      spend: { cap: 30, claim: { agents: 3, unknown: ['sd-cc-1', 'sd-cc-1-s1', 'sd-cc-1-r0'] } },
    })
  })

  it('puts an agent whose spend read rejects into unknown', async () => {
    const rejecting = baseDeps({ spend: () => Promise.reject(new Error('read failed')) })

    const { observations } = await observe([claim({ spawned: ['sd-cc-1'] })], threeAgents(), rejecting)

    expect(observations.get(KEY)?.spend?.claim).toMatchObject({ agents: 1, unknown: ['sd-cc-1'] })
  })

  it('puts a roster row with no cwd into unknown under the default reader', async () => {
    writeTranscript('s-0', 100_000)
    const noCwd = { ...agentRow('sd-cc-1-s1', 's-1'), cwd: undefined } as unknown as AgentIdentity
    const roster = { agents: [agentRow('sd-cc-1', 's-0'), noCwd] }

    const { observations, unread } = await observe(
      [claim({ spawned: ['sd-cc-1', 'sd-cc-1-s1'] })],
      roster,
      baseDeps(),
    )

    expect(unread).toEqual([])
    expect(observations.get(KEY)?.spend?.claim).toMatchObject({
      agents: 2,
      tokens: 101_000,
      unknown: ['sd-cc-1-s1'],
    })
  })

  it('still observes a second claim when the first claim spend read throws', async () => {
    const roster = { agents: [...threeAgents().agents, agentRow('sd-cc-2', 's-3')] }
    const throwing = baseDeps({
      spend: agent => {
        if (agent.name !== 'sd-cc-2') throw new Error('transcript path unresolvable')
        return Promise.resolve({ ok: false, path: agent.name, reason: 'recorded' })
      },
    })
    const second = claim({ taskId: 'CC-2', agentName: 'sd-cc-2', spawned: ['sd-cc-2'] })

    const { observations } = await observe([claim(), second], roster, throwing)

    expect(observations.get(KEY)?.spend?.claim.unknown).toHaveLength(3)
    expect(observations.get('CC-2#')).toMatchObject({
      agent: { id: 'id-sd-cc-2', state: 'live' },
      spend: { cap: 30, claim: { agents: 1, unknown: ['sd-cc-2'] } },
    })
  })
})
