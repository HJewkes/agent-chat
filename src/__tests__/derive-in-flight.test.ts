import { describe, expect, it } from 'vitest'
import type { Claim } from '../agents/burndown/ledger.js'
import {
  deriveInFlight,
  type InFlightInput,
  type ShepherdFlight,
  type VerdictRecord,
} from '../agents/seats/in-flight-read.js'
import type { AgentIdentity } from '../protocol.js'

/** CC-1584: characterization of deriveInFlight's branches. Every name, repo and sha is synthetic. */

const SEAT = 'sample-coord'
const HEAD = 'a'.repeat(40)
const OTHER_HEAD = 'b'.repeat(40)

const claim = (over: Partial<Claim>): Claim =>
  ({
    taskId: 'T-1',
    initiative: 'init',
    spawnedAt: '2026-10-10T00:00:00.000Z',
    phase: 'implementing',
    phaseAt: '2026-10-10T00:00:00.000Z',
    seat: SEAT,
    ...over,
  }) as Claim

const agent = (over: Partial<AgentIdentity>): AgentIdentity =>
  ({
    agentId: 'id',
    name: 'sc-impl',
    profile: 'implementer',
    state: 'running',
    spawnedBy: SEAT,
    cwd: '/wt/one',
    ...over,
  }) as AgentIdentity

const flight = (over: Partial<ShepherdFlight>): ShepherdFlight => ({
  repo: 'acme/widgets',
  pr: 12,
  branch: 'agent-chat/sc-task-one',
  runId: 'r1',
  task: 'init/T-1',
  phase: 'review',
  headSha: HEAD,
  nextAction: null,
  pendingGate: null,
  gateSince: null,
  implementer: null,
  held: false,
  stalled: false,
  ...over,
})

const verdict = (pr: string, head: string, v: string): VerdictRecord => ({ pr, head, verdict: v })

const derive = (over: Partial<InFlightInput>) =>
  deriveInFlight({
    seat: SEAT,
    prefix: 'sc',
    roster: [],
    shepherd: [],
    verdicts: [],
    claims: [],
    ...over,
  })

describe('deriveInFlight', () => {
  it('returns nothing when every source is undefined', () => {
    expect(
      deriveInFlight({
        seat: SEAT,
        prefix: undefined,
        roster: undefined,
        shepherd: undefined,
        verdicts: undefined,
        claims: undefined,
      }),
    ).toEqual({ prs: [], agents: [], claims: [] })
  })

  it('drops shepherd rows without a PR, from another seat, or when the seat has no prefix', () => {
    const rows = [flight({}), flight({ pr: null }), flight({ pr: 13, branch: 'x/other-task' })]
    expect(derive({ shepherd: rows }).prs.map(p => p.pr)).toEqual(['acme/widgets#12'])
    expect(derive({ shepherd: rows, prefix: undefined }).prs).toEqual([])
  })

  it('builds a PR row from a shepherd run with its flags and ci', () => {
    const rows = [
      flight({ nextAction: 'wait', pendingGate: 'gate-1', held: true, stalled: true, phase: 'fixing' }),
    ]
    expect(derive({ shepherd: rows }).prs).toEqual([
      {
        pr: 'acme/widgets#12',
        head: HEAD,
        verdict: null,
        verdictHead: null,
        ci: 'failing',
        phase: 'fixing',
        task: 'init/T-1',
        agent: null,
        claim: null,
        nextAction: 'wait',
        pendingGate: 'gate-1',
        flags: ['held', 'stalled'],
      },
    ])
  })

  it('maps shepherd phases to ci', () => {
    const ci = (phase: string) => derive({ shepherd: [flight({ phase })] }).prs[0]?.ci
    expect([ci('ci'), ci('fixing'), ci('review'), ci('merging'), ci('done'), ci('queued')]).toEqual([
      'pending',
      'failing',
      'passed',
      'passed',
      'passed',
      'unknown',
    ])
  })

  it('attaches the verdict for the exact head, matching the PR case-insensitively', () => {
    const verdicts = [
      verdict('ACME/Widgets#12', OTHER_HEAD, 'WAIT'),
      verdict('acme/widgets#12', HEAD, 'MERGE'),
    ]
    const p = derive({ shepherd: [flight({})], verdicts }).prs[0]
    expect([p?.verdict, p?.verdictHead]).toEqual(['MERGE', null])
  })

  it('falls back to the newest verdict and names its head when none matches the head', () => {
    const verdicts = [
      verdict('acme/widgets#12', OTHER_HEAD, 'FIX_FIRST'),
      verdict('acme/widgets#99', HEAD, 'MERGE'),
    ]
    const p = derive({ shepherd: [flight({})], verdicts }).prs[0]
    expect([p?.verdict, p?.verdictHead]).toEqual(['FIX_FIRST', OTHER_HEAD])
  })

  it('takes the newest verdict when the row has no head', () => {
    const verdicts = [verdict('acme/widgets#12', HEAD, 'WAIT')]
    const p = derive({ shepherd: [flight({ headSha: null })], verdicts }).prs[0]
    expect([p?.verdict, p?.verdictHead]).toEqual(['WAIT', HEAD])
  })

  it('links a claim to its shepherd PR and labels it with its slice', () => {
    const claims = [
      claim({ pr: 'https://github.com/acme/widgets/pull/12', agentName: 'sc-impl', slice: 'S1' }),
    ]
    const p = derive({ shepherd: [flight({})], claims }).prs[0]
    expect([p?.agent, p?.claim]).toEqual(['sc-impl', 'T-1/S1 implementing'])
  })

  it('adds a PR row for a claim shepherd does not list, keeping its own head', () => {
    const claims = [claim({ pr: 'acme/widgets#30', prHead: HEAD, agentName: 'sc-impl' })]
    const verdicts = [verdict('acme/widgets#30', HEAD, 'MERGE')]
    expect(derive({ claims, verdicts }).prs).toEqual([
      {
        pr: 'acme/widgets#30',
        head: HEAD,
        verdict: 'MERGE',
        verdictHead: null,
        ci: 'unknown',
        phase: null,
        task: 'T-1',
        agent: 'sc-impl',
        claim: 'T-1 implementing',
        nextAction: null,
        pendingGate: null,
        flags: [],
      },
    ])
  })

  it('does not duplicate a claim PR that shepherd already lists, and ignores done or foreign claims', () => {
    const claims = [
      claim({ pr: 'acme/widgets#12' }),
      claim({ taskId: 'T-2', pr: 'acme/widgets#31', phase: 'done' }),
      claim({ taskId: 'T-3', pr: 'acme/widgets#32', seat: 'someone' }),
    ]
    expect(derive({ shepherd: [flight({})], claims }).prs.map(p => p.pr)).toEqual(['acme/widgets#12'])
  })

  it('lists agents by spawner or prefix, sorted, without those already on a PR', () => {
    const roster = [
      agent({ name: 'sc-zed' }),
      agent({ name: 'sc-alpha', spawnedBy: 'nobody' }),
      agent({ name: 'sc-onpr' }),
      agent({ name: 'free-lance', spawnedBy: SEAT }),
      agent({ name: 'elsewhere', spawnedBy: 'someone' }),
    ]
    const claims = [
      claim({ pr: 'acme/widgets#12', agentName: 'sc-onpr' }),
      claim({ taskId: 'T-4', agentName: 'sc-zed', slice: 'S2' }),
    ]
    expect(derive({ roster, claims, shepherd: [flight({})] }).agents).toEqual([
      { name: 'free-lance', profile: 'implementer', state: 'running', cwd: '/wt/one' },
      { name: 'sc-alpha', profile: 'implementer', state: 'running', cwd: '/wt/one' },
      {
        name: 'sc-zed',
        profile: 'implementer',
        state: 'running',
        cwd: '/wt/one',
        claim: 'T-4/S2 implementing',
      },
    ])
  })

  it('matches agents by prefix only when the seat has one', () => {
    const roster = [agent({ name: 'sc-alpha', spawnedBy: 'nobody' })]
    expect(derive({ roster, prefix: undefined }).agents).toEqual([])
  })

  it('lists claims with no PR and no agent on the roster', () => {
    const claims = [
      claim({ taskId: 'T-5' }),
      claim({ taskId: 'T-6', agentName: 'sc-impl' }),
      claim({ taskId: 'T-7', agentName: 'sc-gone', slice: 'S3' }),
      claim({ taskId: 'T-8', pr: 'acme/widgets#40' }),
    ]
    expect(derive({ claims, roster: [agent({})] }).claims).toEqual([
      'T-5 implementing',
      'T-7/S3 implementing',
    ])
  })
})
