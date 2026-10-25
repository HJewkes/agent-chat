import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { requiredString } from '../../args.js'
import type { ServerMessage } from '../../protocol.js'
import { selfSession } from '../../agents/move-account-self.js'
import type { BrokerClient } from '../../client/broker-client.js'
import { accountDirs, readAccountUsage } from '../../agents/account-budget.js'
import { accountIdentity } from '../../agents/account-identity.js'
import { PROFILE_ACCOUNTS } from '../../agents/account-move.js'
import { chooseAccount, LEAST_USED } from '../../agents/account-request.js'
import { defaultConfigDir } from '../../agents/config-dir.js'
import { resolveAccountRotation } from '../../config.js'
import { defineVerb, Report, type AccountPool } from '../command.js'

type TeleportResult = Extract<ServerMessage, { t: 'teleport_result' }>

const PLACEMENT_WORDS = {
  'same-pane': 'in the same window',
  'new-surface': 'in a new surface, not this window',
  'other-machine': 'on another machine',
  unreported: 'shortly',
} as const

/** The session to move: `--name`, else the roster row this Claude Code session's id names. */
async function subjectName(
  b: BrokerClient,
  name: string | undefined,
): Promise<{ name: string } | { error: string }> {
  if (name !== undefined) return { name }
  const list = (await b.request({ t: 'list' }, 'list_result')) as Extract<ServerMessage, { t: 'list_result' }>
  return selfSession(list.sessions, process.env.CLAUDE_CODE_SESSION_ID)
}

const machinePool = (): AccountPool => ({
  readings: () => accountDirs(os.homedir(), process.env).map(dir => readAccountUsage(dir)),
  config: resolveAccountRotation,
  identify: dir => accountIdentity(dir),
})

/** The name `account_move` knows the picked config dir by: `claude` for the default one. */
function moveNameOf(dir: string): string {
  if (path.resolve(dir) === defaultConfigDir()) return 'claude'
  const base = path.basename(dir)
  return (PROFILE_ACCOUNTS as readonly string[]).includes(base) ? base : path.resolve(dir)
}

/** `least-used` becomes the pool's pick, by the same `chooseAccount` a spawn uses; any other account stands. */
function resolveAccount(account: string, pool: AccountPool): { account: string } | { error: string } {
  if (account !== LEAST_USED) return { account }
  const choice = chooseAccount(pool.readings(), pool.config(), {
    account,
    ...(pool.identify === undefined ? {} : { identify: pool.identify }),
  })
  return choice.ok ? { account: moveNameOf(choice.dir) } : { error: choice.text }
}

/** A broker started before CC-1592 drops the check unanswered, so the timeout is the only sign. */
function tooOld(err: unknown): never {
  if (!/did not answer/.test((err as Error).message)) throw err
  throw new Error('the broker did not answer the dry run; it may predate CC-1592, so restart the broker')
}

function describeMove(to: string, res: TeleportResult, dryRun: boolean): Report {
  const name = res.name ?? 'the session'
  if (!res.ok) return { ok: false, lines: [`Not moved: ${res.reason ?? 'refused'}`] }
  const warnings = (res.warnings ?? []).map(w => `  warning: ${w}`)
  if (dryRun)
    return {
      ok: true,
      lines: [
        `Dry run: ${name} passes every account check for ${to}; nothing was ended.`,
        'The profile and surface checks run only on the move itself.',
      ],
    }
  const when =
    res.countdownMs === undefined
      ? 'It ends now'
      : `It ends in ${Math.round(res.countdownMs / 1000)}s (agent-chat teleport abort ${name} stops it)`
  const where = PLACEMENT_WORDS[res.placement ?? 'unreported']
  return {
    ok: true,
    lines: [
      `Moving ${name} to ${to}. ${when}, and its same conversation resumes on ${to} ${where}.`,
      ...warnings,
    ],
  }
}

/**
 * CC-1592: the human moves a live session, by default the one this runs inside, to another
 * account. Sends the human-only `account_move`, or with `--dry-run` its check alone.
 */
export const agentMoveAccount = defineVerb({
  name: 'agent.move-account',
  description: 'move a live session (default: this one) to another account, resuming its same conversation',
  args: z.object({
    account: requiredString('account'),
    name: z.string().optional(),
    force: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  }),
  result: Report,
  cli: {
    positional: ['account'],
    options: {
      name: {
        long: '--name',
        description: 'the session to move (default: the one CLAUDE_CODE_SESSION_ID names)',
      },
      force: { long: '--force', description: 'lift the usage ceilings only; every other refusal stands' },
      dryRun: { long: '--dry-run', description: 'run every account check and end nothing' },
    },
  },
  async run({ account: requested, name, force, dryRun }, ctx) {
    const resolved = resolveAccount(requested, ctx.accountPool ?? machinePool())
    if ('error' in resolved) return { ok: false, lines: [], errors: [`Not moved: ${resolved.error}`] }
    const { account } = resolved
    return ctx.withBroker(async b => {
      const subject = await subjectName(b, name)
      if ('error' in subject) return { ok: false, lines: [], errors: [`Not moved: ${subject.error}`] }
      const frame = {
        t: dryRun === true ? ('account_move_check' as const) : ('account_move' as const),
        name: subject.name,
        to: account,
        ...(force === true ? { force: true } : {}),
      }
      const sent = b.request(frame, 'teleport_result')
      const res = (await (dryRun === true ? sent.catch(tooOld) : sent)) as TeleportResult
      return describeMove(account, { ...res, name: res.name ?? subject.name }, dryRun === true)
    })
  },
})
