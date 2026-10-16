import { describe, expect, it } from 'vitest'
import { advance, applyActions, claimKey, type Action } from '../agents/burndown/advance.js'
import { EMPTY_LEDGER, type Claim } from '../agents/burndown/ledger.js'
import { observe, type CheckoutPr, type ObserveDeps } from '../agents/burndown/observe.js'
import type { ShepherdRow } from '../agents/burndown/shepherd.js'
import type { AgentIdentity } from '../protocol.js'

/**
 * CC-1247: the gone-row fence (CC-1254) and the run-only-PR fence (CC-1329) together. Each claim's PR is read once
 * per tick, whichever wrapper reads it, and neither case hands a PR outside owns to Shepherd.
 */

const NOW = new Date('2026-10-14T12:00:00.000Z')
const EARLIER = '2026-10-14T11:00:00.000Z'
const INSIDE = 'src/a.ts'
const OUTSIDE = 'src/x/o.ts'
/** Another open PR holding the outside file, so the adjudicator escalates rather than amends. */
const COLLIDING: CheckoutPr = { number: 7, branch: 'other', files: () => [OUTSIDE] }

type Row = 'gone' | 'exited'
type Source = 'run only' | 'claim.pr' | 'DONE report'

interface Case {
  claim: Claim
  agent?: AgentIdentity
  run: ShepherdRow
  finalText: string
}

/** One implementing claim; `n` keeps agent, task and PR apart when several share a tick. */
function scenario(row: Row, source: Source, n = 9, runPhase: ShepherdRow['phase'] = 'ci'): Case {
  const name = `bd-cc-${n}`
  const pr = `o/r#${n}`
  const claim: Claim = {
    taskId: `CC-${n}`,
    initiative: 'demo',
    slice: 'a',
    dependsOn: [],
    owns: [INSIDE],
    agentId: name,
    agentName: name,
    spawned: [name],
    spawnedAt: EARLIER,
    phase: 'implementing',
    phaseAt: EARLIER,
    /** Absent and not under `.worktrees`: no exited or parked work is read, so the PR is the only file source. */
    ...(row === 'exited' ? { worktree: `/nowhere/${name}` } : {}),
    ...(source === 'claim.pr' ? { pr } : {}),
  }
  const agent = { agentId: name, name, state: 'exited', spawnedAt: 1 } as AgentIdentity
  return {
    claim,
    ...(row === 'exited' ? { agent } : {}),
    run: {
      repo: 'o/r',
      pr: n,
      runId: `run-${n}`,
      phase: runPhase,
      headSha: `h${n}`,
      stalled: null,
      implementer: name,
      branch: `agent-chat/${name}`,
    },
    finalText: source === 'DONE report' ? `Status: DONE\nPR: ${pr}` : 'Status: unknown',
  }
}

interface Tick {
  calls: string[]
  actions: Action[]
  after: Claim[]
}

/** Real observe over a complete roster, then advance and applyActions, as the tick does. */
async function tick(cases: Case[], files: string[]): Promise<Tick> {
  const calls: string[] = []
  const texts = new Map(cases.map(c => [c.claim.agentName, c.finalText]))
  const deps: ObserveDeps = {
    root: '/active-work',
    inboxSince: async () => [],
    finalText: agent => texts.get(agent.name),
    diff: () => ({ reviewable: false, reason: 'clean and level' }),
    changedFiles: () => [],
    readFile: () => undefined,
    shepherdRows: () => cases.map(c => c.run),
    openPrs: () => [COLLIDING],
    landed: () => true,
    spendCap: () => undefined,
    progress: () => 'unreadable',
    prFiles: pr => (calls.push(pr), files),
  }
  const claims = cases.map(c => c.claim)
  const agents = cases.flatMap(c => (c.agent === undefined ? [] : [c.agent]))
  const { observations } = await observe(claims, { agents }, deps)
  const actions = advance(claims, observations, NOW)
  return { calls, actions, after: applyActions({ ...EMPTY_LEDGER, claims }, actions, NOW).claims }
}

const registers = (actions: Action[]): Action[] => actions.filter(a => a.kind === 'register')

const MATRIX: [Row, Source][] = [
  ['gone', 'run only'],
  ['gone', 'claim.pr'],
  ['exited', 'run only'],
  ['exited', 'DONE report'],
]

describe('an implementer handed off on a gone or exited row, its PR from the run, the claim or the report', () => {
  it.each(MATRIX)(
    'stalls a %s row whose %s PR touches a file outside owns, with no register and one read',
    async (row, source) => {
      const { calls, actions, after } = await tick([scenario(row, source)], [INSIDE, OUTSIDE])

      expect(calls).toEqual(['o/r#9'])
      expect(registers(actions)).toEqual([])
      expect(after).toEqual([expect.objectContaining({ phase: 'implementing', stallCode: 'outside-owns' })])
      expect(after[0]?.stalledReason).toContain(OUTSIDE)
    },
  )

  it.each(MATRIX)(
    'hands a %s row whose %s PR stays inside owns to the open run as shepherding',
    async (row, source) => {
      const { calls, after } = await tick([scenario(row, source)], [INSIDE])

      expect(calls).toEqual(['o/r#9'])
      expect(after).toEqual([expect.objectContaining({ phase: 'shepherding', pr: 'o/r#9' })])
      expect(after[0]?.stallCode).toBeUndefined()
    },
  )

  it('reads each PR once in a tick that mixes all four cases', async () => {
    const cases = MATRIX.map(([row, source], i) => scenario(row, source, 9 + i))

    const { calls, actions, after } = await tick(cases, [INSIDE, OUTSIDE])

    expect([...calls].sort()).toEqual(['o/r#10', 'o/r#11', 'o/r#12', 'o/r#9'])
    expect(registers(actions)).toEqual([])
    expect(after.map(c => [claimKey(c), c.stallCode])).toEqual(
      cases.map(c => [claimKey(c.claim), 'outside-owns']),
    )
  })

  it.each(['failed', 'done', 'cancelled'] as const)(
    'reads nothing and hands nothing off for a gone row whose only run has %s',
    async phase => {
      const { calls, actions, after } = await tick([scenario('gone', 'run only', 9, phase)], [OUTSIDE])

      expect(calls).toEqual([])
      expect(registers(actions)).toEqual([])
      expect(after[0]?.stallCode).not.toBe('outside-owns')
    },
  )
})
