import fs from 'node:fs'
import os from 'node:os'
import { home } from '../paths.js'

/**
 * CC-1096: a child spawned with a cwd that was removed under it (a parked
 * agent worktree) fails with `uv_cwd` before it runs a line. The broker and
 * its children therefore pick a directory that exists at spawn time.
 */
export function existingDirOr(candidate: unknown, fallback: string): string {
  if (typeof candidate !== 'string' || candidate === '') return fallback
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : fallback
  } catch {
    return fallback
  }
}

/** The agent-chat home, never an agent tree that whoever started the broker happened to sit in. */
export function brokerCwd(): string {
  return existingDirOr(home(), os.homedir())
}
