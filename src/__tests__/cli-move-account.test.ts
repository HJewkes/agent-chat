import { invokeCommand } from '@titan-design/registry'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrokerClient } from '../client/broker-client.js'
import type { AccountUsage } from '../agents/account-budget.js'
import type { AccountPool, Report, VerbContext } from '../cli/command.js'
import { agentMoveAccount } from '../cli/verbs/agent-move-account.js'
import type { ClientMessage, ServerMessage, SessionInfo } from '../protocol.js'

/** CC-1592: the human's move-account verb finds the session it runs in by its Claude Code session id. */

const SESSION = '11111111-2222-4333-8444-555555555555'

const row = (name: string, claudeSessionId?: string): SessionInfo =>
  ({
    name,
    workingOn: 'a synthetic task',
    cwd: '/tmp/demo',
    status: 'working',
    dnd: false,
    idleMs: 0,
    registeredAt: 0,
    ...(claudeSessionId === undefined ? {} : { observed: { claudeSessionId } }),
  }) as SessionInfo

/** A broker that lists `sessions` and answers every move with `result`, recording each frame. */
function broker(sessions: SessionInfo[], result: Partial<Extract<ServerMessage, { t: 'teleport_result' }>>) {
  const sent: ClientMessage[] = []
  const ctx: VerbContext = {
    warnings: [],
    format: 'human',
    withBroker: async fn =>
      fn({
        request: async (msg: ClientMessage) => {
          sent.push(msg)
          if (msg.t === 'list') return { t: 'list_result', sessions }
          return { t: 'teleport_result', ok: true, ...result }
        },
      } as unknown as BrokerClient),
  }
  return { ctx, sent }
}

async function run(args: Parameters<typeof agentMoveAccount.run>[0], ctx: VerbContext): Promise<Report> {
  const { envelope } = await invokeCommand(agentMoveAccount, args, ctx)
  expect(envelope.ok).toBe(true)
  return (envelope as { data: Report }).data
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('agent move-account without --name', () => {
  it('moves the roster row whose observed session id is this one', async () => {
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', SESSION)
    const { ctx, sent } = broker([row('other', 'not-this-one'), row('scout', SESSION)], { name: 'scout' })

    const report = await run({ account: 'personal' }, ctx)

    expect(sent.at(-1)).toEqual({ t: 'account_move', name: 'scout', to: 'personal' })
    expect(report.ok).toBe(true)
    expect(report.lines.join('\n')).toContain('Moving scout to personal')
  })

  it('sends nothing and fails when no row reports this session id', async () => {
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', SESSION)
    const { ctx, sent } = broker([row('tpo-demo', 'not-this-one'), row('unseen')], {})

    const report = await run({ account: 'personal' }, ctx)

    expect(report.ok).toBe(false)
    expect(report.errors?.join('\n')).toContain(SESSION)
    expect(sent.map(m => m.t)).toEqual(['list'])
  })

  it('sends nothing when two rows report the same session id', async () => {
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', SESSION)
    const { ctx, sent } = broker([row('a', SESSION), row('b', SESSION)], {})

    const report = await run({ account: 'personal' }, ctx)

    expect(report.ok).toBe(false)
    expect(report.errors?.join('\n')).toMatch(/2 live sessions .*a, b/)
    expect(sent.map(m => m.t)).toEqual(['list'])
  })

  it('sends nothing outside a Claude Code session', async () => {
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', '')
    const { ctx, sent } = broker([row('scout', SESSION)], {})

    const report = await run({ account: 'personal' }, ctx)

    expect(report.ok).toBe(false)
    expect(sent.map(m => m.t)).toEqual(['list'])
  })
})

describe('agent move-account with flags', () => {
  it('sends the check frame on --dry-run and says nothing ended', async () => {
    const { ctx, sent } = broker([], { name: 'scout' })

    const report = await run({ account: 'personal', name: 'scout', dryRun: true, force: true }, ctx)

    expect(sent).toEqual([{ t: 'account_move_check', name: 'scout', to: 'personal', force: true }])
    expect(report.lines[0]).toContain('nothing was ended')
  })

  it('reports a refusal as a failure', async () => {
    const { ctx } = broker([], { ok: false, reason: 'five_hour 96% is at or over the ceiling' })

    const report = await run({ account: 'personal', name: 'scout' }, ctx)

    expect(report.ok).toBe(false)
    expect(report.lines).toEqual(['Not moved: five_hour 96% is at or over the ceiling'])
  })
})

describe('agent move-account to least-used', () => {
  const usage = (dir: string, pct: number, over: Partial<AccountUsage> = {}): AccountUsage => ({
    account: path.basename(dir),
    config_dir: dir,
    source: 'usage-poller',
    five_hour: { used_pct: pct, resets_at: 0 },
    seven_day: { used_pct: pct, resets_at: 0 },
    age_seconds: 10,
    stale: false,
    auth_fail: false,
    ...over,
  })
  const pool = (readings: AccountUsage[]): AccountPool => ({
    readings: () => readings,
    config: () => ({ enabled: true, ceilingPct: 90, exclude: [] }),
  })

  it('moves to the logged-in account with the lowest usage, dry run included', async () => {
    const { ctx, sent } = broker([], { name: 'scout' })
    ctx.accountPool = pool([
      usage('/srv/demo/alpha', 80),
      usage('/srv/demo/personal', 20),
      usage('/srv/demo/beta', 5, { auth_fail: true }),
    ])

    await run({ account: 'least-used', name: 'scout', dryRun: true }, ctx)

    expect(sent).toEqual([{ t: 'account_move_check', name: 'scout', to: 'personal' }])
  })

  it('refuses with nothing sent when no account is usable', async () => {
    const { ctx, sent } = broker([], { name: 'scout' })
    ctx.accountPool = pool([usage('/srv/demo/alpha', 5, { auth_fail: true }), usage('/srv/demo/beta', 95)])

    const report = await run({ account: 'least-used', name: 'scout' }, ctx)

    expect(report.ok).toBe(false)
    expect(report.errors?.join('\n')).toContain('Not moved')
    expect(sent).toEqual([])
  })
})
