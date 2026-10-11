import fs from 'node:fs'
import path from 'node:path'
import type { AgentIdentity } from '../../protocol.js'
import { canonicalPath } from '../spawn-cwd.js'

export interface ParsedTree {
  path: string
  branch?: string
}

export interface SeatTree {
  path: string
  cause: 'agent' | 'pattern'
  agent?: string
  branch?: string
}

const BRANCH_PREFIX = 'refs/heads/'

/** Linked trees of `git worktree list --porcelain`: the first block is the main checkout, bare and prunable ones are skipped. */
export function parseWorktreeList(porcelain: string): ParsedTree[] {
  const blocks = porcelain.split(/\n\s*\n/).filter(b => b.trim() !== '')
  return blocks.slice(1).flatMap(block => {
    const lines = block.split('\n')
    const treePath = lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length)
    if (treePath === undefined || lines.includes('bare') || lines.some(l => l.startsWith('prunable')))
      return []
    const ref = lines.find(l => l.startsWith('branch '))?.slice('branch '.length)
    const branch = ref?.startsWith(BRANCH_PREFIX) ? ref.slice(BRANCH_PREFIX.length) : ref
    return [branch === undefined ? { path: treePath } : { path: treePath, branch }]
  })
}

const escapeRegExp = (s: string): string => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

/** `*` matches any run of characters including `/`; everything else is literal and the match is anchored. */
const globRegExp = (glob: string): RegExp => new RegExp(`^${glob.split('*').map(escapeRegExp).join('.*')}$`)

export const matchesCountedTree = (glob: string, branch: string | undefined, basename: string): boolean => {
  const re = globRegExp(glob)
  return (branch !== undefined && re.test(branch)) || re.test(basename)
}

export interface SeatTreeInput {
  agents: AgentIdentity[]
  /** `git worktree list --porcelain` text, one entry per seat repo. */
  repoTrees: string[]
  patterns: string[]
  realpath?: (dir: string) => string
  exists?: (dir: string) => boolean
}

/** An exited agent whose checkout is still on disk holds its slot; a parked one (checkout removed) does not. */
export const hasTreeOnDisk = (
  agent: AgentIdentity,
  exists: (dir: string) => boolean = fs.existsSync,
): boolean => agent.isolation === 'worktree' && agent.state !== 'retired' && exists(agent.cwd)

/** One entry per canonical path, `agent` winning over `pattern`, sorted by path. */
export function seatTrees(input: SeatTreeInput): SeatTree[] {
  const real = input.realpath ?? canonicalPath
  const byPath = new Map<string, SeatTree>()
  for (const a of input.agents) {
    if (!hasTreeOnDisk(a, input.exists)) continue
    const key = real(a.cwd)
    byPath.set(key, { path: key, cause: 'agent', agent: a.name })
  }
  for (const text of input.repoTrees) {
    for (const tree of parseWorktreeList(text)) {
      const key = real(tree.path)
      const counted = input.patterns.some(g => matchesCountedTree(g, tree.branch, path.basename(tree.path)))
      if (!counted || byPath.has(key)) continue
      byPath.set(key, {
        path: key,
        cause: 'pattern',
        ...(tree.branch === undefined ? {} : { branch: tree.branch }),
      })
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}
