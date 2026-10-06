import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner } from '../agents/burndown/exec.js'
import { readLedger, writeLedger, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { tickFromDisk, type TickBroker } from '../agents/burndown/run-tick.js'
import { projectSlug } from '../agents/transcript.js'
import { burndownLedgerPath } from '../paths.js'
import type { AgentIdentity } from '../protocol.js'

/**
 * CC-724: a claim whose transcript spend is over its seat's `per_claim_usd` parks once with
 * stall code `budget`, and its agents are retired. Seat, prefix, task id and paths are synthetic.
 */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'autonomy-2026-09-29')
const SEAT = 'seat-x'
const SESSION = 'session-1'
const NOW = new Date(2026, 1, 3, 4, 5)
const TS = NOW.toISOString()
const CAP = 12

let world: string
let configDir: string
let cwd: string

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const transcriptFile = (): string => path.join(configDir, 'projects', projectSlug(cwd), `${SESSION}.jsonl`)

/** One opus request: `inputTokens` input tokens price it, so the count sets the spend. */
const writeTranscript = (inputTokens: number): void =>
  write(
    transcriptFile(),
    `${JSON.stringify({
      type: 'assistant',
      timestamp: TS,
      message: {
        id: 'msg-1',
        model: 'claude-opus-5-5',
        role: 'assistant',
        usage: { input_tokens: inputTokens, output_tokens: 1000 },
      },
    })}\n`,
  )

const OVER = 10_000_000
const UNDER = 1_000

const claimIn = (worktree: string): Claim => ({
  taskId: 'AB-12',
  initiative: 'demo',
  seat: SEAT,
  namePrefix: 'sx',
  spawnedAt: TS,
  phase: 'implementing',
  phaseAt: TS,
  agentName: 'sx-ab-12',
  agentId: 'id-sx-ab-12',
  spawned: ['sx-ab-12'],
  worktree,
  notified: ['dispatched'],
})

const agentRow = (state: AgentIdentity['state']): AgentIdentity =>
  ({
    agentId: 'id-sx-ab-12',
    name: 'sx-ab-12',
    state,
    cwd,
    sessionId: SESSION,
    configDir,
    spawnedAt: NOW.getTime(),
  }) as AgentIdentity

interface Fake {
  broker: TickBroker
  retires: string[]
  spawns: string[]
  notices: { to: string; text: string }[]
}

function fakeBroker(state: AgentIdentity['state'] = 'live'): Fake {
  const fake: Fake = { retires: [], spawns: [], notices: [], broker: undefined as unknown as TickBroker }
  fake.broker = {
    roster: async () => ({ agents: [agentRow(state)], slots: { held: 1, cap: 36 } }),
    inboxSince: async () => [],
    spawn: async frame => (fake.spawns.push(frame.name), { ok: true, agentId: `id-${frame.name}` }),
    retire: async name => (fake.retires.push(name), { ok: true }),
    queue: async () => [],
    resume: async name => ({ ok: true, agentId: `id-${name}` }),
    collisionView: async () => ({ names: [], claims: [] }),
    seatSender: async () => ({
      send: async (to, text) => (fake.notices.push({ to, text }), { ok: true }),
      notify: async text => (fake.notices.push({ to: '', text }), { ok: true }),
      close: () => undefined,
    }),
  }
  return fake
}

const noExternal: Runner = () => ({ status: 0, stdout: '[]', stderr: '' })

const tick = (fake: Fake) =>
  tickFromDisk({ dryRun: false, broker: fake.broker, now: NOW, log: () => {}, exec: noExternal })

const ledger = (): Ledger => readLedger(burndownLedgerPath())
const stalledEvents = (fake: Fake) => fake.notices.filter(n => n.text.includes('stalled'))

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-spend-cap-tick-')))
  configDir = path.join(world, 'profile')
  cwd = path.join(world, 'worktree')
  fs.mkdirSync(cwd)
  process.env.AGENT_CHAT_HOME = path.join(world, 'home')
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(world, 'aw')
  const autonomy = path.join(world, 'aw', 'claude-channels', 'sources', 'autonomy')
  const charter = fs.readFileSync(path.join(FIXTURE, 'charter.md'), 'utf8')
  write(path.join(autonomy, 'charter.md'), charter.replace('seats: [seat-a,', `seats: [${SEAT}, seat-a,`))
  fs.cpSync(path.join(FIXTURE, 'seats'), path.join(autonomy, 'seats'), { recursive: true })
  write(
    path.join(autonomy, 'seats', `${SEAT}.md`),
    `---\nprefix: sx\npool: pool-x\nspend: {per_claim_usd: ${CAP}}\n---\n`,
  )
  const config = { enabled: true, reportTo: 'coord', seats: [SEAT] }
  write(path.join(world, 'home', 'burndown.config.json'), JSON.stringify(config))
  writeLedger(burndownLedgerPath(), { version: 1, claims: [claimIn(cwd)] })
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  delete process.env.AGENT_CHAT_ACTIVE_WORK_ROOT
  fs.rmSync(world, { recursive: true, force: true })
})

/** The stub answers every `git` call with a non-empty status, so the existing worktree reads as dirty and reviewable. */
describe('a claim over its seat cap', () => {
  it('parks once with stall code budget, retires its agent and tells the owner once', async () => {
    writeTranscript(OVER)
    const fake = fakeBroker()

    await tick(fake)

    const parked = ledger().claims[0]
    expect(parked).toMatchObject({ stallCode: 'budget', stalledClass: 'failed' })
    expect(parked?.stalledReason).toMatch(/^budget: spent \$\d+\.\d\d of \$12 \(1 agents\)$/)
    expect(fake.retires).toEqual(['sx-ab-12'])
    expect(fake.spawns).toEqual([])
    expect(stalledEvents(fake)).toHaveLength(1)

    const afterFirst = JSON.stringify(ledger().claims)
    await tick(fake)

    expect(fake.retires).toEqual(['sx-ab-12'])
    expect(stalledEvents(fake)).toHaveLength(1)
    expect(JSON.stringify(ledger().claims)).toBe(afterFirst)
  })

  it('spawns no reviewer for a finished worker whose diff is reviewable', async () => {
    writeTranscript(OVER)
    const fake = fakeBroker('exited')

    await tick(fake)

    expect(ledger().claims[0]).toMatchObject({ phase: 'implementing', stallCode: 'budget' })
    expect(fake.spawns).toEqual([])
  })
})

describe('a claim under its seat cap', () => {
  it('leaves the ledger as it was apart from lastTickAt', async () => {
    writeTranscript(UNDER)
    const fake = fakeBroker()
    await tick(fake)
    const settled = ledger()

    await tick(fake)

    expect(settled.claims[0]?.stalledReason).toBeUndefined()
    expect(ledger()).toEqual({ ...settled, lastTickAt: TS })
    expect(fake.retires).toEqual([])
  })
})

describe('a claim whose transcript cannot be read', () => {
  it('is not parked once the transcript is gone between ticks', async () => {
    writeTranscript(UNDER)
    const fake = fakeBroker()
    await tick(fake)

    fs.rmSync(transcriptFile())
    await tick(fake)

    expect(ledger().claims[0]?.stalledReason).toBeUndefined()
    expect(fake.retires).toEqual([])
  })
})
