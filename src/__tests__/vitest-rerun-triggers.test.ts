import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const picomatch = createRequire(import.meta.url)('picomatch') as (
  patterns: string[],
) => (file: string) => boolean

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// Loaded by URL because the config sits outside this project's rootDir.
const { default: config } = (await import(pathToFileURL(path.join(repoRoot, 'vitest.config.ts')).href)) as {
  default: { test?: { forceRerunTriggers?: string[] } }
}

describe('vitest forceRerunTriggers for test:affected', () => {
  const matches = picomatch(config.test?.forceRerunTriggers ?? [])

  it.each(['package.json', 'package-lock.json', 'vitest.config.ts', 'tsconfig.json', 'tsconfig.test.json'])(
    'matches %s in the repo root',
    name => {
      expect(matches(path.join(repoRoot, name))).toBe(true)
    },
  )

  it('matches when the checkout sits under a dot directory such as .worktrees', () => {
    const dotRoot = path.join(path.parse(repoRoot).root, 'srv', '.worktrees', 'repo')
    const triggers = config.test?.forceRerunTriggers ?? []
    const moved = triggers.map(t => t.replace(repoRoot, dotRoot))

    expect(picomatch(moved)(path.join(dotRoot, 'package.json'))).toBe(true)
  })

  it('does not match a source file', () => {
    expect(matches(path.join(repoRoot, 'src', 'config.ts'))).toBe(false)
  })
})
