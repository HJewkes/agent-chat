import os from 'node:os'
import { frontmatterField } from '../active-work.js'
import { expandHome } from '../burndown/seat-dispatch.js'
import type { Pool } from './charter.js'

/** CC-959: the account a seat runs on, which every launch of the seat must use. */
export interface SeatAccount {
  configDir: string
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
  const configDir = own === undefined ? pools.get(pool ?? '')?.configDir : expandHome(own, home)
  if (configDir === undefined) return undefined
  const profile = field('profile')
  const cwd = field('cwd')
  return {
    configDir,
    ...(profile === undefined ? {} : { profile }),
    ...(cwd === undefined ? {} : { cwd: expandHome(cwd, home) }),
  }
}
