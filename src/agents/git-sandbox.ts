import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gitMirrorDirFor, probeGit } from '../leak-guard/git-mirror.js'
import {
  findRealGit,
  isExecutableFile,
  realpathOr,
  writeGitShim,
  type SpawnConfigHome,
} from '../leak-guard/git-shim.js'

/**
 * CC-1645: a mount namespace in which every git binary is the push shim. A git named by path, a
 * reset PATH or sudo's env then still reaches the shim. Inert until a launch wraps itself in it.
 */

/** The sandbox shim, its mirror, the core it mirrors, and the real-git copy the shim execs. */
export interface SandboxGit {
  shim: string
  mirror: string
  core: string
  realCopy: string
}

export interface SandboxSpec {
  shim: string
  targets: readonly string[]
  ghShim?: string
  ghTargets?: readonly string[]
}

export type SandboxProbe = { ok: true; bwrap: string } | { ok: false; reason: string }

export type RunSync = (
  bin: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>

const onPath = (pathValue: string, name: string): string[] =>
  pathValue
    .split(path.delimiter)
    .filter(dir => path.isAbsolute(dir))
    .map(dir => path.join(dir, name))

const readlinkOr = (file: string): string => {
  try {
    return fs.readlinkSync(file)
  } catch {
    return ''
  }
}

/** Throws when the mirror cannot be listed: binding fewer paths than the shim covers would fail open. */
function shimmedCoreEntries({ shim, mirror, core }: SandboxGit): string[] {
  return fs
    .readdirSync(mirror)
    .filter(name => readlinkOr(path.join(mirror, name)) === shim)
    .map(name => path.join(core, name))
}

/**
 * Every `git` in the PATH dirs and every core entry the mirror links to the shim, resolved and
 * deduplicated. The shim and its real-git copy are never targets: binding over them would loop.
 */
export function gitOverlayTargets(pathValue: string, git: SandboxGit): string[] {
  const own = new Set([git.shim, git.realCopy].map(realpathOr))
  const found = [...onPath(pathValue, 'git'), ...shimmedCoreEntries(git)]
    .filter(isExecutableFile)
    .map(realpathOr)
  return [...new Set(found.filter(target => !own.has(target)))]
}

const bindsOver = (shim: string, targets: readonly string[]): string[] =>
  targets.flatMap(target => ['--ro-bind', shim, target])

/** bwrap's options, ending in `--`: the caller appends the command's own argv, never a shell line. */
export function sandboxArgv(spec: SandboxSpec): string[] {
  return [
    '--dev-bind',
    '/',
    '/',
    '--die-with-parent',
    ...bindsOver(spec.shim, spec.targets),
    ...(spec.ghShim === undefined ? [] : bindsOver(spec.ghShim, spec.ghTargets ?? [])),
    '--',
  ]
}

/** `<root>/<content hash>/git`, built once through a rename, so a running sandbox never sees it half-copied. */
function copyOnce(real: string, root: string): string {
  const key = createHash('sha256').update(fs.readFileSync(real)).digest('hex').slice(0, 16)
  const dir = path.join(root, key)
  if (fs.existsSync(dir)) return path.join(dir, 'git')
  const temp = `${dir}.${process.pid}.tmp`
  fs.rmSync(temp, { recursive: true, force: true })
  fs.mkdirSync(temp, { recursive: true, mode: 0o700 })
  fs.copyFileSync(real, path.join(temp, 'git'))
  fs.chmodSync(path.join(temp, 'git'), 0o755)
  try {
    fs.renameSync(temp, dir)
  } catch (err) {
    fs.rmSync(temp, { recursive: true, force: true })
    if (!fs.existsSync(dir)) throw err
  }
  return path.join(dir, 'git')
}

/**
 * The real git is copied out from under the overlay, and a shim whose real git is that copy is written
 * in `<stateDir>/git-sandbox`. `pathValue` is the PATH before any shim dir is put on it. Undefined
 * when git, its mirror or its core cannot be read, so a caller never binds an incomplete overlay.
 */
export function writeSandboxGit(
  stateDir: string,
  guard: string,
  pathValue: string = process.env.PATH ?? '',
  shellAliases: readonly string[] = [],
  spawnHome: SpawnConfigHome = process.env,
): SandboxGit | undefined {
  const shimDir = path.join(stateDir, 'git-sandbox')
  const real = findRealGit(pathValue, shimDir)
  if (real === undefined) return undefined
  try {
    const realCopy = copyOnce(real, path.join(stateDir, 'git-real'))
    const shimPath = `${path.dirname(realCopy)}${path.delimiter}${pathValue}`
    if (!writeGitShim(shimDir, guard, shimPath, shellAliases, spawnHome)) return undefined
    const mirror = gitMirrorDirFor(shimDir)
    const core = probeGit(realCopy, ['--exec-path']).trim()
    if (!fs.existsSync(mirror) || core === '') return undefined
    return { shim: path.join(shimDir, 'git'), mirror, core, realCopy }
  } catch {
    return undefined
  }
}

const firstLine = (text: string | undefined): string => `${text ?? ''}`.trim().split('\n')[0] ?? ''

/** bwrap on PATH and able to bind a file over another in a new mount namespace. */
export function probeSandbox(
  pathValue: string = process.env.PATH ?? '',
  run: RunSync = spawnSync,
): SandboxProbe {
  const bwrap = onPath(pathValue, 'bwrap').find(isExecutableFile)
  if (bwrap === undefined) return { ok: false, reason: 'bwrap not found on PATH' }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-bwrap-probe-'))
  const target = path.join(dir, 'target')
  fs.writeFileSync(target, '')
  try {
    const out = run(bwrap, ['--dev-bind', '/', '/', '--ro-bind', '/bin/true', target, target], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    if (out.status === 0) return { ok: true, bwrap }
    const why = out.error?.message ?? (firstLine(out.stderr) || `exit ${out.status}`)
    return { ok: false, reason: `bwrap refused: ${why}` }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
