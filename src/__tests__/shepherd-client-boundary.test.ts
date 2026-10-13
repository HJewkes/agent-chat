import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// CC-1216: burndown is being ported into the factory and then deleted (CC-1197), so the
// broker, teleport, isolation and seats must reach Shepherd and exec through src/.
const SRC = path.resolve(import.meta.dirname, '..')
const GUARDED_DIRS = ['broker', 'agents/seats', 'agents/isolation']
const GUARDED_FILES = ['agents/teleport.ts']
const BURNDOWN_CLIENT_IMPORT = /burndown\/(shepherd|exec)\.js['"]/

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('.ts'))
    .map(name => path.join(dir, name))
}

function guardedFiles(): string[] {
  return [
    ...GUARDED_DIRS.flatMap(dir => tsFilesUnder(path.join(SRC, dir))),
    ...GUARDED_FILES.map(file => path.join(SRC, file)),
  ]
}

describe('shepherd client boundary', () => {
  it('finds the broker, seats, isolation and teleport sources to check', () => {
    expect(guardedFiles().length).toBeGreaterThan(20)
  })

  it('keeps those sources off the burndown shepherd and exec modules', () => {
    const offenders = guardedFiles()
      .filter(file => BURNDOWN_CLIENT_IMPORT.test(readFileSync(file, 'utf8')))
      .map(file => path.relative(path.dirname(SRC), file))

    expect(offenders).toEqual([])
  })
})
