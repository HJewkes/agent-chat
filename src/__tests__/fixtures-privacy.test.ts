import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** CC-235: this repo is public, so committed fixtures must hold no home-directory paths, email addresses or real seat names. */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const HOME_PATH = /\/Users\//
const REAL_SEATS = ['hjewkes-surplus', 'titan-coord', 'voltras-coord', 'self-improve', 'tp450-herald']
const SEAT_TASK_NAME = /\b(hs|tc|vc|si)-(cc|tp|vw|r)-[0-9]+/i
const HOME_SLUG = /(?<![A-Za-z0-9])-(?:Users|home)-([A-Za-z0-9_]+)-/gi
const SYNTHETIC_HOME_NAMES = ['alice', 'someone']
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.json', '.snap', '.txt']
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/

function leaks(text: string): string[] {
  return text
    .split('\n')
    .flatMap((line, i) =>
      HOME_PATH.test(line) || taskNameLeaks(line) || EMAIL.test(line) || slugLeaks(line) || hasRealSeat(line)
        ? [`line ${i + 1}`]
        : [],
    )
}

function taskNameLeaks(text: string): boolean {
  return SEAT_TASK_NAME.test(text)
}

function hasRealSeat(text: string): boolean {
  const lower = text.toLowerCase()
  return REAL_SEATS.some(n => lower.includes(n))
}

function slugLeaks(text: string): boolean {
  return [...text.matchAll(HOME_SLUG)].some(m => !SYNTHETIC_HOME_NAMES.includes((m[1] ?? '').toLowerCase()))
}

function sourceLeaks(dir: string, skip: (file: string) => boolean): string[] {
  return walk(dir)
    .filter(f => SCANNED_EXTENSIONS.some(ext => f.endsWith(ext)) && !skip(f))
    .filter(f => {
      const text = fs.readFileSync(f, 'utf8')
      return taskNameLeaks(text) || hasRealSeat(text) || slugLeaks(text)
    })
    .map(f => path.relative(dir, f))
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
    ['a seat-prefixed task-ID name', 'name: hs-cc-123-foo'],
    ['a mixed-case seat-prefixed task-ID name', 'name: Hs-CC-123-foo'],
    ['a mixed-case real seat name', '{"actor":"Titan-Coord"}'],
    ['a home path in slug form', 'dir: ~/.claude/projects/-Users-bob-projects-x'],
    ['a linux home path in slug form', 'dir: -home-bob-projects-x'],
  ])('flags %s', (_name, text) => {
    expect(leaks(`ok\n${text}`)).toEqual(['line 2'])
  })

  it.each([
    ['a temp path', 'config_dir: /tmp/pool-x'],
    ['a scoped npm package', '"@titan-design/registry"'],
    ['a synthetic home slug', 'dir: -Users-someone-projects-x'],
    ['a temp dir name containing home', 'agent-chat-test-home-run-'],
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

describe('test source privacy guard', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const self = fileURLToPath(import.meta.url)

  it('finds no leak in any scanned file under src/__tests__ outside fixtures', () => {
    const found = sourceLeaks(dir, f => f === self || f.startsWith(FIXTURES))
    expect(found).toEqual([])
  })

  it.each([
    ['a mixed-case task-ID name', 'planted.ts', 'const n = "Hs-Cc-1-x"'],
    ['a name in a JSON fixture', path.join('__snapshots__', 'planted.json'), '{"agent":"tc-tp-2-y"}'],
    ['a real home segment in slug form', 'planted.snap', '-Users-bob-projects-x'],
  ])('fails on %s', (_name, file, text) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-guard-'))
    fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true })
    fs.writeFileSync(path.join(tmp, file), text)
    try {
      expect(sourceLeaks(tmp, () => false)).toEqual([file])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
