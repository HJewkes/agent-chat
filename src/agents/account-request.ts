import os from 'node:os'
import path from 'node:path'
import { groupByAccount, type AccountRow, type AccountUsage } from './account-budget.js'
import { leastUsedText, pickLeastUsed, type LeastUsedPick, type RotationConfig } from './account-rotation.js'
import { accountName, defaultConfigDir, profileDir } from './config-dir.js'

/**
 * TP-4214: a spawn that asks for an account by name, or for the least-used one. The pick runs over
 * one row per Anthropic login, since two dirs on one login read the same limits. A row stands for
 * the dir the request named, or for the spawner's own dir, so the readings, the gates and the
 * launch all speak of the dir the caller meant rather than of the login's first one.
 */

export const LEAST_USED = 'least-used'

export type AccountChoice =
  | { ok: true; dir: string; text: string; warning?: string }
  /** `unknown`: the name matched no account, which no wait will fix. */
  | { ok: false; reason: string; text: string; unknown: boolean }

export interface AccountRequest {
  /** An account name, an absolute config dir, or `least-used`. */
  account: string
  /** The spawner's own config dir, which wins a tie it is part of. */
  preferDir?: string
  refuses?: (dir: string) => boolean
  /** A config dir's Anthropic login; absent, every dir is its own account. */
  identify?: (configDir: string) => string | undefined
  home?: string
}

const sameDir = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b)

function standingFor(rows: readonly AccountRow[], dir: string, home: string): AccountRow[] {
  return rows.map(row =>
    row.config_dirs.some(member => sameDir(member, dir))
      ? { ...row, account: accountName(dir, home), config_dir: dir }
      : row,
  )
}

const memberNamed = (rows: readonly AccountRow[], wanted: string, home: string): string | undefined =>
  rows
    .flatMap(row => row.config_dirs)
    .find(dir => accountName(dir, home) === wanted || (path.isAbsolute(wanted) && sameDir(dir, wanted)))

function choiceOf(pick: LeastUsedPick, unknown: boolean): AccountChoice {
  const text = leastUsedText(pick.record)
  if (!pick.ok) return { ok: false, reason: pick.reason, text, unknown }
  const { warning } = pick.record
  return { ok: true, dir: pick.dir, text, ...(warning === undefined ? {} : { warning }) }
}

export function chooseAccount(
  usages: readonly AccountUsage[],
  config: RotationConfig,
  request: AccountRequest,
): AccountChoice {
  const home = request.home ?? os.homedir()
  const rows = groupByAccount(usages, request.identify ?? (() => undefined))
  const refuses = request.refuses ?? (() => false)
  const { preferDir } = request
  if (request.account === LEAST_USED) {
    const standing = preferDir === undefined ? rows : standingFor(rows, preferDir, home)
    return choiceOf(pickLeastUsed(standing, config, { refuses, ...(preferDir ? { preferDir } : {}) }), false)
  }
  const member = memberNamed(rows, request.account, home)
  const standing = member === undefined ? rows : standingFor(rows, member, home)
  return choiceOf(pickLeastUsed(standing, config, { refuses, explicit: member ?? request.account }), !member)
}

/** On another host a name resolves under that host's home, as an explicit config dir does there. */
export function remoteAccountDir(account: string, home: string): string {
  if (path.isAbsolute(account)) return account
  return account === 'default' ? defaultConfigDir(home) : profileDir(account, {}, home)
}
