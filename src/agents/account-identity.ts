import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultConfigDir } from './config-dir.js'

/** A file's text, or undefined when it cannot be read. Injected so tests never touch a real login. */
export type ReadText = (file: string) => string | undefined

const readFile: ReadText = file => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== ''

/** `accountUuid/organizationUuid` from one `.claude.json`'s `oauthAccount`; the email is ignored because it changes. */
function identityIn(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  try {
    const account = (JSON.parse(text) as { oauthAccount?: Record<string, unknown> }).oauthAccount
    const user = account?.accountUuid
    const org = account?.organizationUuid
    return nonEmpty(user) && nonEmpty(org) ? `${user}/${org}` : undefined
  } catch {
    return undefined
  }
}

/**
 * CC-1289: the Anthropic login a config dir bills, or undefined when no login can be read.
 * The default dir keeps its login in `~/.claude.json` when `CLAUDE_CONFIG_DIR` is unset, so
 * that file is read first and `<dir>/.claude.json` only when it names no login.
 */
export function accountIdentity(
  configDir: string,
  home: string = os.homedir(),
  read: ReadText = readFile,
): string | undefined {
  const own = path.join(configDir, '.claude.json')
  const files =
    path.resolve(configDir) === defaultConfigDir(home) ? [path.join(home, '.claude.json'), own] : [own]
  for (const file of files) {
    const identity = identityIn(read(file))
    if (identity !== undefined) return identity
  }
  return undefined
}

/** Charter pools grouped by the Anthropic account they log in to. */
export interface AccountGroups {
  /** The account key a pool bills: the first member in charter order, or the pool itself when alone or unknown. */
  keyOf: (pool: string) => string
  /** The pools on an account key, in charter order; `[key]` for a key no group holds. */
  members: (key: string) => string[]
  /** Only the groups with more than one pool. */
  shared: string[][]
}

/** A pool whose login cannot be read stays its own account, so API-key pools never merge with each other. */
export function accountGroups(
  pools: Iterable<{ name: string; configDir: string }>,
  identify: (configDir: string) => string | undefined = dir => accountIdentity(dir),
): AccountGroups {
  const byIdentity = new Map<string, string[]>()
  const groups: string[][] = []
  for (const pool of pools) {
    const identity = identify(pool.configDir)
    const existing = identity === undefined ? undefined : byIdentity.get(identity)
    if (existing !== undefined) {
      existing.push(pool.name)
      continue
    }
    const group = [pool.name]
    groups.push(group)
    if (identity !== undefined) byIdentity.set(identity, group)
  }
  const keyByPool = new Map(groups.flatMap(group => group.map(name => [name, group[0] ?? name] as const)))
  const membersByKey = new Map(groups.map(group => [group[0] ?? '', group] as const))
  return {
    keyOf: pool => keyByPool.get(pool) ?? pool,
    members: key => [...(membersByKey.get(key) ?? [key])],
    shared: groups.filter(group => group.length > 1).map(group => [...group]),
  }
}
