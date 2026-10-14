import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { advance, applyActions, claimKey, type Action, type Observation } from '../agents/burndown/advance.js'
import type { Claim, Ledger } from '../agents/burndown/ledger.js'
import { renderStatus } from '../agents/burndown/tick.js'

/** CC-1222: `burndown status` names why a queued claim went back, from its ladder record. */

const AT = '2026-10-01T12:00:00.000Z'
const NOW = new Date('2026-10-01T12:05:00.000Z')
const REPO = 'example-org/example-repo'
const prUrl = (n: number): string => `https://github.com/${REPO}/pull/${n}`

const claim = (slice: string, over: Partial<Claim> = {}): Claim => ({
  taskId: 'T-1',
  initiative: 'demo',
  spawnedAt: AT,
  phaseAt: AT,
  phase: 'queued',
  slice,
  ...over,
})

const parentClaim = (over: Partial<Claim> = {}): Claim =>
  claim('a', { phase: 'shepherding', pr: prUrl(10), agentName: 'bd-t-1-a', ...over })

const childClaim = (over: Partial<Claim> = {}): Claim =>
  claim('b', {
    phase: 'implementing',
    agentName: 'bd-t-1-b',
    dependsOn: ['a'],
    owns: ['src/b.ts'],
    stackedOn: { taskId: 'T-1', slice: 'a', pr: prUrl(10), branch: 'agent-chat/bd-t-1-a' },
    ...over,
  })

const ticked = (ledger: Ledger, parentObs: Observation = {}): Ledger =>
  applyActions(ledger, advance(ledger.claims, new Map([[claimKey(parentClaim()), parentObs]]), NOW), NOW)

const childLine = (ledger: Ledger, root: string): string =>
  renderStatus(ledger, NOW, root).find(l => l.startsWith('T-1 (demo) ') && !l.includes('shepherding')) ?? ''

const CLOSED: Observation = { prState: { kind: 'closed', pr: prUrl(10) } }

let world: string
let autonomyRoot: string
const saved = { ...process.env }

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-status-release-')))
  process.env.AGENT_CHAT_HOME = path.join(world, 'home')
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(world, 'aw')
  process.env.CLAUDE_PROFILE_ROOT = path.join(world, 'profiles')
  autonomyRoot = path.join(world, 'aw', 'claude-channels', 'sources', 'autonomy')
})

afterEach(() => {
  process.env = { ...saved }
  fs.rmSync(world, { recursive: true, force: true })
})

describe('burndown status release cause', () => {
  it('names a stack-broken release for a closed parent, with the kept branch', () => {
    const ledger = ticked({ version: 1, claims: [parentClaim(), childClaim()] }, CLOSED)

    const line = childLine(ledger, autonomyRoot)

    expect(line).toContain(
      'queued since 2026-10-01T12:05:00.000Z RELEASED 1x: stack-broken: parent T-1 a #10 closed, branch agent-chat/bd-t-1-b',
    )
  })

  it('names a stack-broken release for a parent released back to the queue', () => {
    const parent = parentClaim({ phase: 'queued', pr: undefined, agentName: undefined })
    const ledger = ticked({ version: 1, claims: [parent, childClaim()] })

    const line = renderStatus(ledger, NOW, autonomyRoot).find(l => l.includes('RELEASED')) ?? ''

    expect(line).toContain('RELEASED 1x: stack-broken: parent T-1 a #10 released')
  })

  it('shows the reason, not a stall code carried over from an earlier release', () => {
    const carried: Ledger = {
      version: 1,
      claims: [parentClaim(), childClaim()],
      ladder: { 'T-1#b': { respawns: 1, lastAt: AT, releases: 1, code: 'lease-expired' } },
    }

    const line = childLine(ticked(carried, CLOSED), autonomyRoot)

    expect(line).toContain('RELEASED 2x: stack-broken: parent T-1 a #10 closed')
    expect(line).not.toContain('lease-expired')
  })

  it('shows the stall code of a ladder release that carries no reason', () => {
    const release: Action = {
      kind: 'release',
      key: { taskId: 'T-1', slice: 'b' },
      requeue: true,
      code: 'lease-expired',
      names: ['bd-t-1-b'],
    }
    const ledger = applyActions(
      { version: 1, claims: [childClaim({ stackedOn: undefined })] },
      [release],
      NOW,
    )

    const line = childLine(ledger, autonomyRoot)

    expect(line).toMatch(/RELEASED 1x: lease-expired$/)
  })

  it('adds nothing to a queued claim without a ladder record', () => {
    const ledger: Ledger = { version: 1, claims: [childClaim({ phase: 'queued' })] }

    expect(childLine(ledger, autonomyRoot)).not.toContain('RELEASED')
  })

  it('adds nothing once the released claim has re-dispatched', () => {
    const released = ticked({ version: 1, claims: [parentClaim(), childClaim()] }, CLOSED)
    const redispatched: Ledger = {
      ...released,
      claims: released.claims.map(c => (c.slice === 'b' ? { ...c, phase: 'implementing' as const } : c)),
    }

    const line = childLine(redispatched, autonomyRoot)

    expect(line).toContain('implementing')
    expect(line).not.toContain('RELEASED')
  })
})
