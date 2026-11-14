import os from 'node:os'
import path from 'node:path'
import { accountDirs, readAccountUsage } from './account-budget.js'
import { accountIdentity } from './account-identity.js'
import { chooseAccount, LEAST_USED } from './account-request.js'
import { frontmatterField } from './active-work.js'
import { defaultConfigDir } from './config-dir.js'
import { resolveAccountRotation } from '../config.js'

/** CC-894: a seat whose seat file declares `account: least-used` runs wherever usage is lowest. */

export const declaresLeastUsed = (seatFile: string | undefined): boolean =>
  seatFile !== undefined && frontmatterField(seatFile, 'account') === LEAST_USED

/** The least-used account on this machine, `preferDir` winning a tie; undefined when none qualifies. */
export function machineLeastUsedDir(preferDir: string | undefined): string | undefined {
  const usages = accountDirs(os.homedir(), process.env).map(dir => readAccountUsage(dir))
  const choice = chooseAccount(usages, resolveAccountRotation(), {
    account: LEAST_USED,
    identify: dir => accountIdentity(dir),
    ...(preferDir === undefined ? {} : { preferDir }),
  })
  return choice.ok ? choice.dir : undefined
}

export interface SuccessorAccount {
  dir: string
  /** The account the predecessor ran on, so the seat file follows the change. */
  from: string
}

/**
 * The account a declaring seat's successor starts on: the least-used one when that differs from the
 * predecessor's. Undefined keeps the predecessor's, as every other teleport does.
 */
export function successorAccount(
  seatFile: string | undefined,
  currentDir: string | undefined,
  leastUsed: (preferDir: string | undefined) => string | undefined,
): SuccessorAccount | undefined {
  if (!declaresLeastUsed(seatFile)) return undefined
  const from = currentDir ?? defaultConfigDir()
  const dir = leastUsed(from)
  if (dir === undefined || path.resolve(dir) === path.resolve(from)) return undefined
  return { dir, from }
}
