import os from 'node:os'
import { frontmatterField } from '../active-work.js'
import { expandHome } from '../burndown/seat-dispatch.js'
import type { Pool } from './charter.js'
import { sameDir } from './seat-target.js'
import type { SeatAgent } from './watchdog.js'

/** CC-959: the account a seat runs on, which every launch of the seat must use. */
export interface SeatAccount {
  configDir: string
  /** CC-1053: the charter pool's dir, kept when the seat file overrides it. */
  poolDir?: string
  profile?: string
  cwd?: string
}

/** The seat file's `config_dir:` wins over its pool's; undefined when neither names one. */
export function seatAccount(
  seatFile: string,
  pools: Map<string, Pool>,
  home = os.homedir(),
): SeatAccount | undefined {
  const field = (name: string): string | undefined => frontmatterField(seatFile, name)
  const own = field('config_dir')
  const pool = field('pool')
  const poolDir = pools.get(pool ?? '')?.configDir
  const configDir = own === undefined ? poolDir : expandHome(own, home)
  if (configDir === undefined) return undefined
  const profile = field('profile')
  const cwd = field('cwd')
  return {
    configDir,
    ...(poolDir === undefined ? {} : { poolDir }),
    ...(profile === undefined ? {} : { profile }),
    ...(cwd === undefined ? {} : { cwd: expandHome(cwd, home) }),
  }
}

/**
 * CC-1053: a seat launches only on its charter pool's account or the one its own spawned row ran on,
 * so a seat file `config_dir:` cannot move it onto another account. Undefined when allowed.
 */
export function accountRefusal(
  account: SeatAccount,
  spawned: SeatAgent,
  home = os.homedir(),
): string | undefined {
  const allowed = [account.poolDir, spawned.configDir].flatMap(dir =>
    dir === undefined || dir === '' ? [] : [expandHome(dir, home)],
  )
  if (allowed.some(dir => sameDir(dir, expandHome(account.configDir, home)))) return undefined
  const row = spawned.agentId ?? spawned.name
  return (
    `seat config_dir ${account.configDir} is neither its pool's (${account.poolDir ?? 'none'}) ` +
    `nor spawned row ${row}'s (${spawned.configDir || 'unrecorded'})`
  )
}
