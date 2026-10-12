import os from 'node:os'
import path from 'node:path'
import { canonicalPath, isAtOrUnder } from './spawn-cwd.js'

const PATH_TOKEN = /^(?:~\/|\.{1,2}\/|\/)?(?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.[A-Za-z0-9]{1,8}$/
const WRAPPING = /^[`'"([<{]+|[`'")\]>},;:.!?]+$/g

/** Path-like words of the brief that end in a file extension; prose and URLs drop out. */
function briefPathTokens(brief: string): string[] {
  const tokens = brief
    .split(/\s+/)
    .filter(word => !word.includes('://'))
    .map(word => word.replace(WRAPPING, '').replace(/:\d+(?::\d+)?$/, ''))
  return [...new Set(tokens.filter(token => PATH_TOKEN.test(token)))]
}

const expandHome = (p: string): string => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)

/**
 * CC-236: a path the brief names inside the cwd that resolves, through a symlink,
 * outside the cwd and every granted dir makes a headless worker's Write wait on a
 * prompt nobody answers. Advisory only: one warning per such path, never a refusal.
 */
export function crossingBriefPaths(brief: string, cwd: string, grantedDirs: readonly string[]): string[] {
  const lexicalCwd = path.resolve(cwd)
  const realCwd = canonicalPath(cwd)
  const granted = grantedDirs.map(dir => canonicalPath(dir))
  return briefPathTokens(brief).flatMap(token => {
    const lexical = path.resolve(lexicalCwd, expandHome(token))
    if (!isAtOrUnder(lexical, lexicalCwd) && !isAtOrUnder(lexical, realCwd)) return []
    const real = canonicalPath(lexical)
    if (isAtOrUnder(real, realCwd) || granted.some(dir => isAtOrUnder(real, dir))) return []
    return [
      `brief path ${token} resolves to ${real} through a symlink outside cwd; the worker cannot write it without a prompt. Name the real path or grant the directory.`,
    ]
  })
}
