import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { advance, applyActions } from '../agents/burndown/advance.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { observe, type CheckoutPr, type ObserveDeps, type Roster } from '../agents/burndown/observe.js'
import type { AgentIdentity } from '../protocol.js'

/** CC-832 b: the owns read survives a rename into owns, an unreadable worktree with only a report's PR, and a pruned row. */

const NOW = new Date('2026-10-14T12:00:00.000Z')
const RECENT = '2026-10-14T11:55:00.000Z'
const WORKTREE = '/nowhere/bd-cc-1-a'
const OUTSIDE = ['src/a.ts', 'src/b.ts']
const COLLIDING: CheckoutPr = { number: 7, branch: 'other', files: () => ['src/b.ts'] }
const OUTSIDE_REASON =
  'outside-owns: PR touches src/b.ts outside its slice owns; not amended: #7 touches src/b.ts'

const implementing = (patch: Partial<Claim> = {}): Claim => ({
  taskId: 'CC-1',
  initiative: 'demo',
  slice: 'a',
  dependsOn: [],
  owns: ['src/a.ts'],
  agentId: 'bd-cc-1-a',
  agentName: 'bd-cc-1-a',
  spawned: ['bd-cc-1-a'],
  spawnedAt: RECENT,
  phase: 'implementing',
  phaseAt: RECENT,
  worktree: WORKTREE,
  ...patch,
})

const outsideStall = (patch: Partial<Claim> = {}): Claim =>
  implementing({
    pr: 'o/r#41',
    stalledReason: OUTSIDE_REASON,
    stalledClass: 'failed',
    stallCode: 'outside-owns',
    ...patch,
  })

const planText = (owns: string[]): string =>
  [
    '```burndown-slices',
    JSON.stringify([{ n: 'a', title: 'slice a', points: 1, doneWhen: 'a is done', dependsOn: [], owns }]),
    '```',
  ].join('\n')

const exitedIn = (cwd: string): Roster => ({
  agents: [
    {
      agentId: 'bd-cc-1-a',
      name: 'bd-cc-1-a',
      state: 'exited',
      spawnedAt: 1,
      cwd,
      sessionId: 's',
      configDir: '',
    } as AgentIdentity,
  ],
})

const PRUNED: Roster = { agents: [] }

const baseDeps = (deps: Partial<ObserveDeps>): ObserveDeps => ({
  finalText: () => 'Status: DONE\nPR: https://github.com/o/r/pull/41',
  inboxSince: async () => [],
  root: '/nowhere',
  diff: () => ({ reviewable: true }) as never,
  changedFiles: () => undefined,
  readFile: () => undefined,
  landed: () => true,
  spendCap: () => undefined,
  progress: () => 'unreadable',
  activity: () => ({ ok: false, reason: 'stub' }) as never,
  openPrs: () => [COLLIDING],
  ...deps,
})

type Defaulted = 'changedFiles' | 'openPrs'

/** Observe then advance, as the tick does; `defaulted` stubs are dropped, so observe uses its own reads. */
async function tick(
  ledger: Ledger,
  roster: Roster,
  deps: Partial<ObserveDeps>,
  defaulted: readonly Defaulted[] = [],
): Promise<Ledger> {
  const held = ledger.claims.filter(c => c.phase !== 'done')
  const full = baseDeps(deps)
  for (const key of defaulted) delete full[key]
  const { observations } = await observe(held, roster, full)
  return applyActions(ledger, advance(held, observations, NOW), NOW)
}

const ledgerOf = (claim: Claim): Ledger => ({ ...EMPTY_LEDGER, claims: [claim] })

describe('a file moved into owns', () => {
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd,
      stdio: 'ignore',
    })
  }

  it('stalls outside-owns naming the unowned old path', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'owns-move-in-'))
    try {
      git(repo, 'init', '-q', '-b', 'main')
      fs.mkdirSync(path.join(repo, 'src'))
      fs.writeFileSync(path.join(repo, 'src/x.ts'), 'export const x = 1\n')
      git(repo, 'add', '.')
      git(repo, 'commit', '-q', '-m', 'base')
      git(repo, 'checkout', '-q', '-b', 'work')
      git(repo, 'mv', 'src/x.ts', 'src/a.ts')
      git(repo, 'commit', '-q', '-m', 'move')

      const after = await tick(
        ledgerOf(implementing({ worktree: repo })),
        exitedIn(repo),
        { finalText: () => 'Status: DONE' },
        ['changedFiles', 'openPrs'],
      )

      expect(after.claims[0]).toMatchObject({ stallCode: 'outside-owns' })
      expect(after.claims[0]?.stalledReason).toContain('src/x.ts')
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('an unreadable worktree with only the report naming the PR', () => {
  it('stalls outside-owns on the tick from the report PR files', async () => {
    const after = await tick(ledgerOf(implementing()), exitedIn(WORKTREE), { prFiles: () => OUTSIDE })

    expect(after.claims[0]).toMatchObject({ stallCode: 'outside-owns', stalledReason: OUTSIDE_REASON })
  })

  it('hands the PR to Shepherd on the tick when its files are inside owns', async () => {
    const after = await tick(ledgerOf(implementing()), exitedIn(WORKTREE), { prFiles: () => ['src/a.ts'] })

    expect(after.claims[0]).toMatchObject({ phase: 'shepherding', pr: 'https://github.com/o/r/pull/41' })
    expect(after.claims[0]?.stallCode).toBeUndefined()
  })
})

describe('an outside-owns stall whose agent row was pruned', () => {
  it('clears once the PR touches only owned files, dropping its stale stamp', async () => {
    const stale = { class: 'outside-owns' as const, proposed: 'widen owns', since: RECENT }
    const after = await tick(ledgerOf(outsideStall({ stale })), PRUNED, { prFiles: () => ['src/a.ts'] })

    expect(after.claims[0]?.stallCode).toBeUndefined()
    expect(after.claims[0]?.stale).toBeUndefined()
  })

  it('hands the cleared PR to Shepherd past the phase timeout instead of laddering', async () => {
    const held = [outsideStall({ phaseAt: '2026-10-14T06:00:00.000Z' })]
    const { observations } = await observe(held, PRUNED, baseDeps({ prFiles: () => ['src/a.ts'] }))
    const actions = advance(held, observations, NOW)
    const after = applyActions(ledgerOf(held[0] as Claim), actions, NOW)

    expect(after.claims[0]).toMatchObject({ phase: 'shepherding', pr: 'o/r#41' })
    expect(after.claims[0]?.stallCode).toBeUndefined()
    expect(actions.map(a => a.kind)).toContain('register')
  })

  it('stays unchanged while a file is still outside', async () => {
    const stalled = outsideStall({ stale: { class: 'outside-owns', proposed: 'widen owns', since: RECENT } })
    const held = [stalled]
    const { observations } = await observe(held, PRUNED, baseDeps({ prFiles: () => OUTSIDE }))

    expect(advance(held, observations, NOW)).toEqual([])
  })

  it('clears against a widened plan and keeps its owns', async () => {
    const after = await tick(ledgerOf(outsideStall()), PRUNED, {
      prFiles: () => OUTSIDE,
      readFile: () => planText(OUTSIDE),
    })

    expect(after.claims[0]?.stallCode).toBeUndefined()
    expect(after.claims[0]?.owns).toEqual(OUTSIDE)
  })
})
