import { describe, expect, it } from 'vitest'
import { advance, applyActions, claimKey, type Action, type Observation } from '../agents/burndown/advance.js'
import type { Runner } from '../agents/burndown/exec.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { checkoutPrs, observe, type CheckoutPr } from '../agents/burndown/observe.js'
import { adjudicateOutside, type OtherPr } from '../agents/burndown/owns-adjudicate.js'
import type { PrFacts } from '../agents/burndown/pr-facts.js'
import type { AgentIdentity } from '../protocol.js'

/** CC-1150 f: an outside-owns PR amends its owns and registers, or escalates naming what it collides with. */

const NOW = new Date('2026-10-12T12:00:00.000Z')
const EARLIER = '2026-10-12T11:00:00.000Z'
const PR = 'https://github.com/o/r/pull/9'
const OWNED = 'packages/x/src/index.ts'
const HELPER = 'packages/x/test/helpers.ts'
const DOC = 'docs/x.md'

const claim = (patch: Partial<Claim> = {}): Claim => ({
  taskId: 'CC-1',
  initiative: 'demo',
  slice: 'a',
  owns: [OWNED],
  agentId: 'a1',
  agentName: 'bd-cc-1',
  spawned: ['bd-cc-1'],
  worktree: '/repo/.worktrees/bd-cc-1',
  spawnedAt: EARLIER,
  phase: 'implementing',
  phaseAt: EARLIER,
  ...patch,
})

const stalledOutside = (patch: Partial<Claim> = {}): Claim =>
  claim({
    stalledReason: `outside-owns: PR touches ${HELPER} (+1 more) outside its slice owns`,
    stalledClass: 'failed',
    stallCode: 'outside-owns',
    ...patch,
  })

const other = (patch: Partial<Claim> = {}): Claim =>
  claim({
    taskId: 'CC-2',
    slice: 'b',
    agentName: 'bd-cc-2',
    spawned: ['bd-cc-2'],
    worktree: '/repo/.worktrees/bd-cc-2',
    owns: ['docs/**'],
    ...patch,
  })

const exitedRow = { agentId: 'a1', name: 'bd-cc-1', state: 'exited', spawnedAt: 1 } as AgentIdentity

const openPr = (number: number, files: string[] | undefined, branch = `feat/${number}`): CheckoutPr => ({
  number,
  branch,
  files: () => files,
})

async function observed(
  c: Claim,
  opts: { changed?: string[]; prs?: readonly CheckoutPr[] | undefined; others?: Claim[] } = {},
): Promise<Observation> {
  const { observations } = await observe(
    [c, ...(opts.others ?? [])],
    { agents: [exitedRow] },
    {
      root: '/active-work',
      inboxSince: async () => [],
      finalText: () => `Status: DONE\nPR: ${PR}`,
      diff: () => ({ reviewable: true, reason: '1 commit ahead' }),
      changedFiles: () => opts.changed ?? [OWNED, HELPER, DOC],
      openPrs: () => ('prs' in opts ? opts.prs : []),
    },
  )
  return observations.get(claimKey(c)) ?? {}
}

function step(c: Claim, obs: Observation): { actions: Action[]; after: Claim } {
  const actions = advance([c], new Map([[claimKey(c), obs]]), NOW)
  const ledger: Ledger = { ...EMPTY_LEDGER, claims: [c] }
  const [after] = applyActions(ledger, actions, NOW).claims
  if (after === undefined) throw new Error('no claim after the step')
  return { actions, after }
}

const registers = (actions: Action[]) => actions.filter(a => a.kind === 'register')

describe('an outside-owns PR with no collision (test 21)', () => {
  for (const [name, start] of [
    ['a fresh DONE report', claim()],
    ['a claim already stalled outside-owns', stalledOutside()],
  ] as const) {
    it(`amends owns and registers with Shepherd in the same tick, from ${name}`, async () => {
      const obs = await observed(start)

      const { actions, after } = step(start, obs)

      expect(obs.owned).toEqual({
        outside: [HELPER, DOC],
        adjudicated: { kind: 'amend', files: [HELPER, DOC] },
      })
      expect(registers(actions)).toHaveLength(1)
      expect(after).toEqual(
        expect.objectContaining({
          phase: 'shepherding',
          pr: PR,
          owns: [OWNED, HELPER, DOC],
          ownsAmended: [HELPER, DOC],
        }),
      )
      expect(after.stalledReason).toBeUndefined()
      expect(after.stallCode).toBeUndefined()
    })
  }

  it('ignores the claim own PR, its own branch, a queued claim and a claim in another repo', async () => {
    const obs = await observed(claim(), {
      prs: [openPr(9, [DOC]), openPr(31, [HELPER], 'agent-chat/bd-cc-1')],
      others: [other({ phase: 'queued' }), other({ worktree: '/elsewhere/.worktrees/bd-cc-2' })],
    })

    expect(obs.owned).toEqual(
      expect.objectContaining({ adjudicated: { kind: 'amend', files: [HELPER, DOC] } }),
    )
  })
})

describe('an outside-owns PR that collides fails closed (test 22)', () => {
  const cases: [string, Parameters<typeof observed>[1], string][] = [
    ['a file under another held claim', { others: [other()] }, `${DOC} is under CC-2 slice b's owns`],
    ['a file in another open PR', { prs: [openPr(12, ['README.md', DOC])] }, `#12 touches ${DOC}`],
    [
      'a protected factory path',
      { changed: [OWNED, 'products/factory/src/shepherd/x.ts'] },
      'products/factory/src/shepherd/x.ts is a protected path',
    ],
    [
      'a protected package path',
      { changed: [OWNED, 'packages/github/src/y.ts'] },
      'packages/github/src/y.ts is a protected path',
    ],
    ['an unreadable open-PR list', { prs: undefined }, 'could not read open PRs'],
    [
      'an unreadable PR file list',
      { prs: [openPr(12, undefined)] },
      'could not read open PRs (no file list for #12)',
    ],
  ]
  for (const [name, opts, cause] of cases) {
    it(`escalates ${name}, naming it and leaving owns unchanged`, async () => {
      const obs = await observed(claim(), opts)

      const { actions, after } = step(claim(), obs)

      expect(registers(actions)).toEqual([])
      expect(after.owns).toEqual([OWNED])
      expect(after.ownsAmended).toBeUndefined()
      expect(after.stallCode).toBe('outside-owns')
      expect(after.stalledReason).toMatch(
        new RegExp(`outside its slice owns; not amended: ${escape(cause)}$`),
      )
    })
  }

  it('rewrites a stall without a cause once, then holds it with no actions', async () => {
    const stalled = stalledOutside()
    const obs = await observed(stalled, { others: [other()] })

    const first = step(stalled, obs)
    const second = step(first.after, obs)

    expect(first.after.stalledReason).toContain(`not amended: ${DOC} is under CC-2 slice b's owns`)
    expect(second.actions).toEqual([])
  })

  it('reads no PR files when a held or protected file already escalates', () => {
    const read: number[] = []
    const prs: OtherPr[] = [{ number: 12, files: () => (read.push(12), []) }]

    const verdict = adjudicateOutside([DOC, 'src/agents/x.ts'], { held: [], openPrs: () => prs })

    expect(verdict).toEqual({ kind: 'escalate', reason: 'src/agents/x.ts is a protected path' })
    expect(read).toEqual([])
  })
})

describe('a claim whose owns were amended before (test 23)', () => {
  const amended = claim({ owns: [OWNED, DOC], ownsAmended: [DOC] })

  it('adjudicates only the new outside file, so an older amended file colliding later does not block it', async () => {
    const obs = await observed(amended, { prs: [openPr(12, [DOC])] })

    const { after } = step(amended, obs)

    expect(obs.owned).toEqual({ outside: [HELPER], adjudicated: { kind: 'amend', files: [HELPER] } })
    expect(after.owns).toEqual([OWNED, DOC, HELPER])
    expect(after.ownsAmended).toEqual([DOC, HELPER])
  })

  it('escalates when the new file collides', async () => {
    const obs = await observed(amended, { prs: [openPr(12, [HELPER])] })

    const { after } = step(amended, obs)

    expect(after.stalledReason).toContain(`not amended: #12 touches ${HELPER}`)
    expect(after.owns).toEqual([OWNED, DOC])
  })
})

describe("the tick's open-PR reader", () => {
  const origin: Runner = () => ({ status: 0, stdout: 'https://github.com/o/r.git\n', stderr: '' })
  const facts =
    (patch: Partial<PrFacts> = {}) =>
    (): PrFacts => ({
      prs: [
        {
          number: 12,
          title: 't',
          branch: 'feat/12',
          body: '',
          headSha: 'h',
          base: 'main',
          draft: false,
          updatedAt: EARLIER,
        },
      ],
      at: EARLIER,
      stale: false,
      ageMs: 0,
      complete: true,
      ...patch,
    })

  it('lists the PRs from a fresh complete read', () => {
    expect(checkoutPrs('/repo', facts(), origin)?.map(pr => pr.number)).toEqual([12])
  })

  it('fails closed on a stale list, a truncated list, or a checkout with no GitHub origin', () => {
    const noOrigin: Runner = () => ({ status: 2, stdout: '', stderr: 'no remote' })

    expect(checkoutPrs('/repo', facts({ stale: true }), origin)).toBeUndefined()
    expect(checkoutPrs('/repo', facts({ complete: false }), origin)).toBeUndefined()
    expect(checkoutPrs('/repo', facts(), noOrigin)).toBeUndefined()
  })
})

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
