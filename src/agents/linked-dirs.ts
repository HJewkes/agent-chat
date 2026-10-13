import fs from 'node:fs'
import path from 'node:path'
import type { Allocation } from './isolation/index.js'
import { isAtOrUnder } from './spawn-cwd.js'

export interface LinkedDir {
  /** The top-level entry name in the cwd, e.g. `sources`. */
  link: string
  /** Its realpath, which is what `--add-dir` needs. */
  dir: string
}

const realOf = (p: string): string | undefined => {
  try {
    return fs.realpathSync(p)
  } catch {
    return undefined
  }
}

const linkTarget = (entry: string): string | undefined => {
  const real = realOf(entry)
  return real !== undefined && fs.statSync(real).isDirectory() ? real : undefined
}

/**
 * CC-236: Claude Code prompts for a Write whose path is lexically in the cwd but
 * resolves outside every working directory, even under a bare Write allow rule,
 * and a headless worker cannot answer that prompt. Only links into the
 * active-work root count, so sibling-repo links do not widen a worker's write reach.
 */
export function linkedWriteDirs(cwd: string, root: string): LinkedDir[] {
  const realCwd = realOf(cwd)
  const realRoot = realOf(root)
  if (realCwd === undefined || realRoot === undefined) return []
  return fs
    .readdirSync(realCwd, { withFileTypes: true })
    .filter(entry => entry.isSymbolicLink())
    .flatMap(entry => {
      const dir = linkTarget(path.join(realCwd, entry.name))
      if (dir === undefined || !isAtOrUnder(dir, realRoot) || isAtOrUnder(dir, realCwd)) return []
      return [{ link: entry.name, dir }]
    })
}

/** Grants each linked dir to the allocation and tells the agent the real path behind each link. */
export function withLinkedDirs(allocation: Allocation, root: string): Allocation {
  const linked = linkedWriteDirs(allocation.cwd, root)
  if (linked.length === 0) return allocation
  const addDirs = [...new Set([...(allocation.addDirs ?? []), ...linked.map(l => l.dir)])]
  const lines = linked.map(
    l => `${path.join(allocation.cwd, l.link)} is ${l.dir}; write there by either path`,
  )
  return { ...allocation, addDirs, note: [allocation.note, ...lines].filter(Boolean).join('\n') }
}
