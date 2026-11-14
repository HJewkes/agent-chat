import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { accountDirs, readAccountUsage } from '../../agents/account-budget.js'
import { readGuardState, saveGuardState } from '../../agents/account-guard-state.js'
import { runGuard, type GuardDeps } from '../../agents/account-guard-pass.js'
import { accountIdentity } from '../../agents/account-identity.js'
import { charterSeats, isSeatName } from '../../agents/seats/charter.js'
import { defaultAutonomyRoot, readText } from '../../agents/seats/io.js'
import type { BrokerClient } from '../../client/broker-client.js'
import { resolveAccountRotation } from '../../config.js'
import { defineVerb, Report, type AccountPool } from '../command.js'
import { kicksInBroker } from './job-kick.js'
import { notifyAsWatchdog, type Reply } from './seat-broker.js'

const machinePool = (): AccountPool => ({
  readings: () => accountDirs(os.homedir(), process.env).map(dir => readAccountUsage(dir)),
  config: resolveAccountRotation,
  identify: dir => accountIdentity(dir),
})

function charterSeatFiles(root: string): { name: string; seatFile: string }[] {
  const charter = readText(path.join(root, 'charter.md'))
  if (charter === undefined) return []
  return charterSeats(charter)
    .filter(isSeatName)
    .flatMap(name => {
      const seatFile = readText(path.join(root, 'seats', `${name}.md`))
      return seatFile === undefined ? [] : [{ name, seatFile }]
    })
}

async function sendMove(
  client: BrokerClient,
  name: string,
  to: string,
): Promise<{ ok: boolean; detail: string }> {
  const res = (await client.request(
    { t: 'account_move', name, to },
    'teleport_result',
  )) as Reply<'teleport_result'>
  return { ok: res.ok, detail: res.ok ? `moving to ${to}` : (res.reason ?? 'refused') }
}

/** The machine's seats, roster, readings and broker; the watchdog run reuses it with its own client. */
export function liveGuardDeps(
  root: string,
  client: BrokerClient,
  pool: AccountPool = machinePool(),
): GuardDeps {
  return {
    seats: () => charterSeatFiles(root),
    roster: async () =>
      ((await client.request({ t: 'list' }, 'list_result')) as Reply<'list_result'>).sessions,
    readings: () => pool.readings(),
    config: () => pool.config(),
    ...(pool.identify === undefined ? {} : { identify: (dir: string) => pool.identify?.(dir) }),
    readState: () => readGuardState(),
    saveState: state => saveGuardState(state),
    move: (name, to) => sendMove(client, name, to),
    notify: notifyAsWatchdog,
    now: () => Date.now(),
  }
}

/**
 * CC-894: move an idle seat that declares `account: least-used` off an account at its five_hour
 * ceiling or 90% seven_day, onto the least-used account. The seats watchdog runs it every tick.
 */
export const accountsGuardVerb = defineVerb({
  name: 'accounts.guard',
  description:
    'move each idle seat whose seat file declares `account: least-used` to the least-used account when its ' +
    'own is at the five_hour ceiling or 90% seven_day and the target has 15 points more seven_day headroom; ' +
    '60 min dwell, no move back before the tripping reset, one owner notice per episode with no target',
  args: z.object({ dryRun: z.boolean().optional(), root: z.string().optional() }),
  result: Report,
  cli: {
    options: {
      dryRun: {
        long: '--dry-run',
        description: 'print each decision; move nothing, notify nothing, write nothing',
      },
      root: { long: '--root', description: 'autonomy directory holding charter.md and seats/' },
    },
  },
  async run({ dryRun, root }, ctx) {
    if (kicksInBroker() && dryRun !== true)
      return {
        ok: false,
        lines: [],
        errors: ['refused from an agent shell: moving a session is the human’s call'],
      }
    const dir = root ?? defaultAutonomyRoot()
    return ctx.withBroker(async client => {
      const lines = await runGuard(liveGuardDeps(dir, client, ctx.accountPool), { dryRun: dryRun === true })
      return { ok: true, lines: lines.length === 0 ? ['guard: no seat declares account: least-used'] : lines }
    })
  },
})
