import fs from 'node:fs'
import path from 'node:path'
import { distDir } from './paths.js'

/**
 * CC-1728: the commit a `dist/` was built from, written by `scripts/build-stamp.mjs` at build.
 *
 * Read from the stamp, never from `git rev-parse` at runtime: a checkout's source can move while
 * its dist stays behind, which is exactly the drift this exists to report.
 */
export const BUILD_COMMIT_FILE = 'build-commit'

const COMMIT = /^[0-9a-f]{7,40}$/

/** The stamped commit in `dir`, or undefined when the build was not stamped or the stamp is garbled. */
export function readBuildCommit(dir: string = distDir()): string | undefined {
  try {
    const commit = fs.readFileSync(path.join(dir, BUILD_COMMIT_FILE), 'utf8').trim()
    return COMMIT.test(commit) ? commit : undefined
  } catch {
    return undefined
  }
}

let loaded: { commit: string | undefined } | undefined

/** This process's build, read once: a dist rebuilt under a running process does not change its code. */
export function ownBuildCommit(): string | undefined {
  loaded ??= { commit: readBuildCommit() }
  return loaded.commit
}

/** A commit as a person reads it in a notice. */
export const shortCommit = (commit: string | undefined): string =>
  commit === undefined ? 'an unstamped build' : commit.slice(0, 12)
