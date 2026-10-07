import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runner } from '../agents/burndown/exec.js'
import { execute, type ExecuteDeps, type Step } from '../agents/burndown/execute.js'
import { readLedger, writeLedger, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { registerWithShepherd } from '../agents/burndown/shepherd.js'

const reg = {
  target: { repo: 'Acme/Widgets', pr: 7 },
  task: 'init/T-1',
  implementer: 'worker-a',
  headSha: 'aaa111',
}

const row = { repo: 'acme/widgets', pr: 7, runId: 'r1', phase: 'ci', headSha: 'aaa111', stalled: null }

function shepherd(rows: unknown[] | undefined): { exec: Runner; calls: string[][] } {
  const calls: string[][] = []
  const exec: Runner = (_bin, args) => {
    calls.push(args)
    if (args[1] === 'status')
      return rows === undefined ? { status: 1, stdout: '' } : { status: 0, stdout: JSON.stringify(rows) }
    return { status: 0, stdout: '' }
  }
  return { exec, calls }
}

describe('burndown registering a PR with Shepherd (TP-468)', () => {
  it('skips a PR Shepherd already lists, so the worker’s --kind survives', () => {
    const { exec, calls } = shepherd([row])

    expect(registerWithShepherd(reg, exec)).toEqual({ ok: true })
    expect(calls.some(a => a[1] === 'register')).toBe(false)
  })

  it('registers again when the listed row is at an older head', () => {
    const { exec, calls } = shepherd([{ ...row, headSha: 'old000' }])

    registerWithShepherd(reg, exec)

    expect(calls.some(a => a[1] === 'register')).toBe(true)
  })

  it.each(['done', 'failed', 'cancelled'])('registers again when the listed row is in phase %s', phase => {
    const { exec, calls } = shepherd([{ ...row, phase }])

    registerWithShepherd(reg, exec)

    expect(calls.some(a => a[1] === 'register')).toBe(true)
  })

  it('registers a PR Shepherd does not list', () => {
    const { exec, calls } = shepherd([])

    expect(registerWithShepherd(reg, exec)).toEqual({ ok: true })
    expect(calls.some(a => a[1] === 'register')).toBe(true)
  })

  it('still registers when Shepherd status is unreadable', () => {
    const { exec, calls } = shepherd(undefined)

    registerWithShepherd(reg, exec)

    expect(calls.some(a => a[1] === 'register')).toBe(true)
  })
})

/** CC-671 S3: a refused register spends the claim's liveness budget; the ledger is re-read from disk between ticks. */
describe('burndown Shepherd register liveness (CC-716)', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-register-'))
    file = path.join(dir, 'ledger.json')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const NOW = new Date(2026, 9, 6, 12, 0)
  const registration = { target: { repo: 'o/r', pr: 9 }, task: 'demo/CC-1', implementer: 'bd-cc-1' }
  const step: Step = { kind: 'register', key: { taskId: 'CC-1' }, registration }
  const shepherding = (prHead: string): Claim => ({
    taskId: 'CC-1',
    initiative: 'demo',
    agentId: 'a1',
    agentName: 'bd-cc-1',
    spawned: ['bd-cc-1'],
    worktree: '/w/bd-cc-1',
    spawnedAt: NOW.toISOString(),
    phase: 'shepherding',
    pr: 'o/r#9',
    prHead,
    phaseAt: NOW.toISOString(),
  })
  const REFUSED = { ok: false, refused: true, reason: 'denyRepos' }

  function ticker(replies: Array<typeof REFUSED | { ok: boolean; refused?: boolean; reason?: string }>): {
    tick: () => Promise<Ledger>
    calls: () => number
  } {
    let calls = 0
    const deps: ExecuteDeps = {
      ledgerFile: file,
      spawn: async () => ({ ok: true }),
      retire: async () => ({ ok: true }),
      register: () => replies[Math.min(calls++, replies.length - 1)] as ReturnType<ExecuteDeps['register']>,
      log: () => {},
      now: NOW,
    }
    return { tick: async () => (await execute([step], readLedger(file), deps)).ledger, calls: () => calls }
  }

  it('retries the first two refusals and parks the third as retry-spent', async () => {
    writeLedger(file, { version: 1, claims: [shepherding('aaa111')] })
    const { tick, calls } = ticker([REFUSED])

    const first = await tick()
    const second = await tick()
    const third = await tick()

    expect(first.claims[0]?.stalledReason).toBeUndefined()
    expect(second.claims[0]?.stalledReason).toBeUndefined()
    expect(calls()).toBe(3)
    expect(third.claims[0]).toMatchObject({ stalledClass: 'gate-trip', stallCode: 'retry-spent' })
  })

  it('spends nothing when Shepherd never answers', async () => {
    writeLedger(file, { version: 1, claims: [shepherding('aaa111')] })
    const { tick } = ticker([{ ok: false, reason: 'shepherd down' }])

    let ledger: Ledger = readLedger(file)
    for (let i = 0; i < 5; i++) ledger = await tick()

    expect(ledger.liveness).toBeUndefined()
    expect(ledger.claims[0]?.stalledReason).toBeUndefined()
  })

  it('counts a refusal after the PR head changed as a retry', async () => {
    writeLedger(file, { version: 1, claims: [shepherding('aaa111')] })
    const { tick } = ticker([REFUSED])
    await tick()
    await tick()
    const ledger = readLedger(file)
    writeLedger(file, { ...ledger, claims: [shepherding('bbb222')] })

    const after = await tick()

    expect(after.claims[0]?.stalledReason).toBeUndefined()
  })

  it('clears the record when a register succeeds', async () => {
    writeLedger(file, { version: 1, claims: [shepherding('aaa111')] })
    const { tick } = ticker([REFUSED, { ok: true }])
    await tick()

    const after = await tick()

    expect(after.liveness).toEqual({})
  })
})
