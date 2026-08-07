import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isStale, newestBuildMtime, stalenessWarning } from '../broker/staleness.js'

/**
 * CC-57: a broker loads its code once and keeps serving it after `dist/` is
 * rebuilt underneath it. Found the hard way — CC-47's tool denial was merged
 * and compiled, and two of three peers spawned that session ignored it, because
 * the broker that wrote their argv predated the build. Argv is fixed at spawn
 * time, so that agent carries the old contract for its whole life.
 *
 * The bar these hold is that "cannot tell" never reads as "stale": a warning
 * that fires without evidence is the kind people learn to ignore, which would
 * cost more than the silence it replaced.
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const tree = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-staleness-'))
  dirs.push(dir)
  return dir
}

const write = (dir: string, rel: string, mtimeMs?: number): string => {
  const full = path.join(dir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, '// built')
  if (mtimeMs !== undefined) fs.utimesSync(full, mtimeMs / 1000, mtimeMs / 1000)
  return full
}

describe('newestBuildMtime', () => {
  it('reports the newest compiled module and which file it was', () => {
    const dir = tree()
    write(dir, 'old.js', 1_000_000)
    const newest = write(dir, 'broker/new.js', 2_000_000)

    expect(newestBuildMtime(dir)).toEqual({ mtimeMs: 2_000_000, file: newest })
  })

  it('ignores the dashboard, whose rebuild changes nothing the broker does', () => {
    // Left in, a dashboard-only rebuild would raise a warning that is true and
    // irrelevant — the fastest way to train someone to ignore the warning.
    const dir = tree()
    write(dir, 'cli.js', 1_000_000)
    write(dir, 'dashboard/assets/index-abc123.js', 9_000_000)

    expect(newestBuildMtime(dir)?.mtimeMs).toBe(1_000_000)
  })

  it('ignores maps and declarations, which are rebuilt but never loaded', () => {
    const dir = tree()
    write(dir, 'cli.js', 1_000_000)
    write(dir, 'cli.js.map', 9_000_000)
    write(dir, 'cli.d.ts', 9_000_000)

    expect(newestBuildMtime(dir)?.mtimeMs).toBe(1_000_000)
  })

  it('returns null for a tree that is not there, rather than throwing', () => {
    expect(newestBuildMtime(path.join(os.tmpdir(), 'agent-chat-no-such-dist'))).toBeNull()
  })

  it('returns null for a tree with nothing loadable in it', () => {
    const dir = tree()
    write(dir, 'README.md', 1_000_000)

    expect(newestBuildMtime(dir)).toBeNull()
  })
})

describe('isStale', () => {
  const stamp = (mtimeMs: number) => ({ mtimeMs, file: '/dist/broker/socket.js' })

  it('is stale when the build moved after the broker loaded it', () => {
    expect(isStale(1_000, stamp(2_000))).toBe(true)
  })

  it('is not stale when the broker loaded the current build', () => {
    expect(isStale(2_000, stamp(2_000))).toBe(false)
  })

  it('is not stale when the broker is newer than the build', () => {
    expect(isStale(3_000, stamp(2_000))).toBe(false)
  })

  it('is not stale when there is no stamp, which is a broker predating this', () => {
    // An old meta file must stay quiet rather than accuse every broker of being
    // out of date the first time this ships.
    expect(isStale(undefined, stamp(2_000))).toBe(false)
  })

  it('is not stale when the tree cannot be read', () => {
    expect(isStale(1_000, null)).toBe(false)
  })
})

describe('stalenessWarning', () => {
  it('names the file and the remedy, since a warning without a move is noise', () => {
    const warning = stalenessWarning(0, { mtimeMs: 10 * 60_000, file: '/dist/broker/socket.js' })

    expect(warning).toContain('socket.js')
    expect(warning).toContain('10 minutes')
    expect(warning).toContain('agent-chat service restart')
  })

  it('explains that a spawned agent cannot be fixed by restarting later', () => {
    // The whole reason this is worth saying at spawn time: argv is frozen, so
    // the damage outlives the staleness that caused it.
    const warning = stalenessWarning(0, { mtimeMs: 60_000, file: '/dist/cli.js' })

    expect(warning).toMatch(/fixed at spawn time/i)
  })

  it('says a minute rather than zero for a rebuild that just happened', () => {
    expect(stalenessWarning(0, { mtimeMs: 1_000, file: '/dist/cli.js' })).toContain('1 minute')
  })

  it('is null whenever isStale is false, so callers need only one check', () => {
    expect(stalenessWarning(undefined, { mtimeMs: 2_000, file: '/dist/cli.js' })).toBeNull()
    expect(stalenessWarning(3_000, { mtimeMs: 2_000, file: '/dist/cli.js' })).toBeNull()
    expect(stalenessWarning(1_000, null)).toBeNull()
  })
})
