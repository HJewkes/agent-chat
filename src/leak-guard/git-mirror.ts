import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * `<git-bin>/core`: the exec-path agents run git with (TP-4249). git puts its exec-path first on the
 * PATH of every shell it starts, so there `git` and `git-<builtin>` are the push shim. It sits under
 * the shim dir, so the pre-push hook drops it from its scan PATH with the shim.
 */
export const gitMirrorDirFor = (shimDir: string): string => path.join(shimDir, 'core')

/** An inherited GIT_EXEC_PATH would make a probe read the mirror back and mirror itself. */
export function probeGit(real: string, args: readonly string[]): string {
  const env = { ...process.env }
  delete env.GIT_EXEC_PATH
  return execFileSync(real, args, { encoding: 'utf8', timeout: 5000, env })
}

/** Each mirror entry's link target: the shim for `git` and every dashed builtin, the real entry otherwise. */
export function mirrorEntries(
  listing: readonly string[],
  builtins: readonly string[],
  core: string,
  shim: string,
): Map<string, string> {
  const shimmed = new Set(['git', ...builtins.map(name => `git-${name}`)])
  const entries = new Map(listing.map(name => [name, shimmed.has(name) ? shim : path.join(core, name)]))
  for (const name of shimmed) entries.set(name, shim)
  return entries
}

// A new git version, core path, builtin list or core listing gets its own dir, so a running agent never sees one half-built.
const mirrorKey = (
  version: string,
  core: string,
  builtins: readonly string[],
  listing: readonly string[],
): string =>
  createHash('sha256')
    .update(JSON.stringify([version, core, builtins, listing]))
    .digest('hex')
    .slice(0, 16)

function buildOnce(dir: string, entries: Map<string, string>): void {
  if (fs.existsSync(dir)) return
  const temp = `${dir}.${process.pid}.tmp`
  fs.rmSync(temp, { recursive: true, force: true })
  fs.mkdirSync(temp, { mode: 0o700 })
  for (const [name, target] of entries) fs.symlinkSync(target, path.join(temp, name))
  try {
    fs.renameSync(temp, dir)
  } catch (err) {
    fs.rmSync(temp, { recursive: true, force: true })
    if (!fs.existsSync(dir)) throw err
  }
}

/** Swapped through a rename, so a git reading the exec-path never finds it missing. */
function pointAt(link: string, target: string): void {
  const temp = `${link}.${process.pid}.tmp`
  fs.rmSync(temp, { force: true })
  fs.symlinkSync(target, temp)
  fs.renameSync(temp, link)
}

/**
 * Builds the mirror of the real `core` for the shim in `shimDir` and returns its stable path, or
 * '' when git's version or core cannot be read. Then the link is removed, so the shim and the
 * launcher both leave the exec-path alone rather than point git at a stale mirror.
 */
export function writeGitMirror(
  shimDir: string,
  real: string,
  core: string,
  builtins: readonly string[],
): string {
  try {
    if (core === '' || builtins.length === 0) throw new Error('no core or builtin list')
    const version = probeGit(real, ['--version']).trim()
    const listing = fs.readdirSync(core).sort()
    const name = `core-${mirrorKey(version, core, builtins, listing)}`
    buildOnce(path.join(shimDir, name), mirrorEntries(listing, builtins, core, path.join(shimDir, 'git')))
    pointAt(gitMirrorDirFor(shimDir), name)
    return gitMirrorDirFor(shimDir)
  } catch {
    fs.rmSync(gitMirrorDirFor(shimDir), { force: true })
    return ''
  }
}
