import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** CC-235: this repo is public, so committed fixtures must hold no home-directory paths, email addresses or real seat names. */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const HOME_PATH = /\/Users\//
const REAL_SEATS = ['hjewkes-surplus', 'titan-coord', 'voltras-coord', 'self-improve', 'tp450-herald']
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/

function leaks(text: string): string[] {
  return text
    .split('\n')
    .flatMap((line, i) =>
      HOME_PATH.test(line) || EMAIL.test(line) || REAL_SEATS.some(n => line.includes(n))
        ? [`line ${i + 1}`]
        : [],
    )
}

function walk(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
}

describe('fixture privacy guard', () => {
  it.each([
    ['a home-directory path', 'cwd: /Users/someone/projects'],
    ['an email address', 'author: someone@example.com'],
    ['a real seat name', '{"actor":"titan-coord"}'],
  ])('flags %s', (_name, text) => {
    expect(leaks(`ok\n${text}`)).toEqual(['line 2'])
  })

  it.each([
    ['a temp path', 'config_dir: /tmp/pool-x'],
    ['a scoped npm package', '"@titan-design/registry"'],
  ])('passes %s', (_name, text) => {
    expect(leaks(text)).toEqual([])
  })

  it('finds no leak in any file under src/__tests__/fixtures', () => {
    const found = walk(FIXTURES).flatMap(file =>
      leaks(fs.readFileSync(file, 'utf8')).map(where => `${path.relative(FIXTURES, file)} ${where}`),
    )
    expect(found).toEqual([])
  })
})
