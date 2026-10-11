import path from 'node:path'
import { matchPattern } from '../isolation/file-ownership.js'

/**
 * A slice's PR against its declared `owns` (CC-669): the files it touches that
 * no owns entry matches and that are no owned file's companion test. Pure.
 *
 * A companion is a test file (`*.test.*`, `*.spec.*`, or under `__tests__/` or
 * `test/`) whose stem, minus `.test`/`.spec`, equals or ends with `-<stem>` of an
 * owned concrete file, and that sits in that file's dir or in a `__tests__`/`test`
 * dir on one of its ancestors: this repo keeps its tests in `src/__tests__/`.
 * For a wildcard or dir entry the stem must start with the entry's last literal
 * dir followed by `-`. A fixture counts only when owned explicitly.
 */

export function outsideOwns(files: readonly string[], owns: readonly string[]): string[] {
  return files.filter(
    file => !owns.some(pattern => matchPattern(file, pattern) || isCompanion(file, pattern)),
  )
}

const TEST_DIRS: ReadonlySet<string> = new Set(['__tests__', 'test'])
const TEST_NAME = /\.(test|spec)\.[^.]+$/

const isTest = (file: string): boolean =>
  TEST_NAME.test(file) || file.split('/').some(segment => TEST_DIRS.has(segment))

const testStem = (file: string): string =>
  path.posix
    .basename(file)
    .replace(TEST_NAME, '')
    .replace(/\.[^.]+$/, '')

function isCompanion(file: string, pattern: string): boolean {
  if (!isTest(file)) return false
  const stem = testStem(file)
  const owned = ownedPlace(pattern)
  const named = owned.glob
    ? stem === owned.name || stem.startsWith(`${owned.name}-`)
    : stem === owned.name || stem.endsWith(`-${owned.name}`)
  return owned.name !== '' && named && placedFor(path.posix.dirname(file), owned.dir)
}

/** The dir an owns entry covers and the name a companion must carry: a file's stem, or a glob's last literal dir. */
function ownedPlace(pattern: string): { dir: string; name: string; glob: boolean } {
  const glob = pattern.endsWith('/') || pattern.includes('*')
  if (!glob) {
    const name = path.posix.basename(pattern).replace(/\.[^.]+$/, '')
    return { dir: path.posix.dirname(pattern), name, glob }
  }
  const segments = pattern.split('/').filter(s => s !== '')
  const literal = segments.slice(0, firstWild(segments))
  return { dir: literal.join('/') || '.', name: literal.at(-1) ?? '', glob }
}

const firstWild = (segments: string[]): number => {
  const at = segments.findIndex(s => s.includes('*'))
  return at === -1 ? segments.length : at
}

/** Beside the owned dir, or in a test dir whose parent is that dir or one of its ancestors. */
function placedFor(testDir: string, ownedDir: string): boolean {
  if (testDir === ownedDir) return true
  if (!TEST_DIRS.has(path.posix.basename(testDir))) return false
  const parent = path.posix.dirname(testDir)
  return parent === '.' || ownedDir === parent || ownedDir.startsWith(`${parent}/`)
}
