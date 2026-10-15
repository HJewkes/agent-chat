import fs from 'node:fs'
import { expandHome } from '../burndown/seat-dispatch.js'
import type { Pool } from './charter.js'
import { sameDir } from './seat-target.js'

/** CC-892 d: the seat file's account fields follow an account move; the reader is `seat-account.ts`. */

export interface AccountMove {
  newDir: string
  /** The charter pool whose dir is `newDir`; undefined leaves `pool:` as it is. */
  newPool: string | undefined
  oldDir: string
  date: string
  home?: string
}

/** The charter pool whose `configDir` is `dir`. */
export const poolForDir = (pools: Map<string, Pool>, dir: string): string | undefined =>
  [...pools.values()].find(pool => sameDir(pool.configDir, dir))?.name

/** Whether a move to `dir` lands on an account some charter pool bills; `start` refuses a seat move that does not. */
export const accountInCharterPool = (pools: Map<string, Pool>, dir: string): boolean =>
  poolForDir(pools, dir) !== undefined

const FIELD = (key: string): RegExp => new RegExp(`^(${key}:[ \\t]*)([^\\s#]+)([ \\t]*(?:#.*)?)$`)

/** The line's own comment, if any, then the move mark. */
const mark = (rest: string, old: string, date: string): string =>
  `${rest.trim() === '' ? ' ' : `${rest.trimEnd()} `}# CC-892 moved from ${old} ${date}`

function frontmatterRange(lines: string[]): [number, number] | undefined {
  if (lines[0] !== '---') return undefined
  const end = lines.indexOf('---', 1)
  return end === -1 ? undefined : [1, end]
}

/** The value of the first `key:` line inside the frontmatter, unquoted and comment-free. */
const valueOf = (lines: string[], key: string): string | undefined => {
  for (const line of lines) {
    const m = FIELD(key).exec(line)
    if (m?.[2] !== undefined) return m[2].replace(/^['"]|['"]$/g, '')
  }
  return undefined
}

const setField = (line: string, key: string, value: string, old: string, date: string): string => {
  const m = FIELD(key).exec(line)
  if (m?.[1] === undefined || m[3] === undefined) return line
  return `${m[1]}${value}${mark(m[3], old, date)}`
}

/**
 * The seat file with `config_dir:` and `pool:` moved to the new account. An `overflow_pool:` equal to the new pool
 * becomes the old pool, so the seat never overflows onto the pool it now runs on. Comments stay and gain a
 * `# CC-892 moved from` mark. Undefined when the file already holds the new account or has no frontmatter.
 */
export function rewriteSeatAccount(text: string, move: AccountMove): string | undefined {
  const lines = text.split('\n')
  const range = frontmatterRange(lines)
  if (range === undefined) return undefined
  const block = lines.slice(range[0], range[1])
  const oldPool = valueOf(block, 'pool')
  const ownDir = valueOf(block, 'config_dir')
  const home = move.home ?? ''
  const dirStale = ownDir !== undefined && !sameDir(expandHome(ownDir, home), move.newDir)
  const poolStale = move.newPool !== undefined && oldPool !== undefined && oldPool !== move.newPool
  if (!dirStale && !poolStale) return undefined
  const out = block.map(line => {
    if (dirStale && FIELD('config_dir').test(line))
      return setField(line, 'config_dir', move.newDir, ownDir ?? move.oldDir, move.date)
    if (poolStale && FIELD('pool').test(line))
      return setField(line, 'pool', move.newPool ?? '', oldPool ?? '', move.date)
    if (poolStale && oldPool !== undefined && FIELD('overflow_pool').exec(line)?.[2] === move.newPool)
      return setField(line, 'overflow_pool', oldPool, move.newPool ?? '', move.date)
    return line
  })
  return [...lines.slice(0, range[0]), ...out, ...lines.slice(range[1])].join('\n')
}

/** Writes `next` over `file` through tmp+rename, after saving the old text beside it as `<file>.bak`. */
export function writeSeatFile(file: string, previous: string, next: string): void {
  fs.writeFileSync(`${file}.bak`, previous)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, next)
  fs.renameSync(tmp, file)
}
