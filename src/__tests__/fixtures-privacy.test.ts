import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** CC-235: this repo is public, so committed fixtures must hold no home-directory paths, email addresses or real seat names. */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const HOME_PATH = /\/Users\/[^/\s"']*/
const REAL_SEATS = ['hjewkes-surplus', 'titan-coord', 'voltras-coord', 'self-improve', 'tp450-herald']
const SEAT_TASK_NAME = /\b(hs|tc|vc|si)-(cc|tp|vw|r)-[0-9]+/i
const HOME_SLUG = /(?<![A-Za-z0-9])-(?:Users|home)-([A-Za-z0-9_]+)-/gi
const SYNTHETIC_HOME_NAMES = ['alice', 'someone']
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.json', '.snap', '.txt']
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/
const LEAK_ADVICE = 'use synthetic names such as seat-a; see fixtures-privacy.test.ts for the banned list'

function leaks(text: string): string[] {
  return text.split('\n').flatMap((line, i) => {
    const name = line.match(HOME_PATH)?.[0] ?? line.match(EMAIL)?.[0] ?? leakedName(line)
    return name === undefined ? [] : [`line ${i + 1}: ${name}`]
  })
}

/** The first banned token in `text`, in its original case so the report can be grepped for. */
function leakedName(text: string): string | undefined {
  return text.match(SEAT_TASK_NAME)?.[0] ?? realSeat(text) ?? leakedSlug(text)
}

function realSeat(text: string): string | undefined {
  const lower = text.toLowerCase()
  const at = REAL_SEATS.map(n => [lower.indexOf(n), n.length]).find(([i]) => i >= 0)
  return at === undefined ? undefined : text.slice(at[0], at[0] + at[1])
}

function leakedSlug(text: string): string | undefined {
  return [...text.matchAll(HOME_SLUG)].find(
    m => !SYNTHETIC_HOME_NAMES.includes((m[1] ?? '').toLowerCase()),
  )?.[0]
}

function sourceLeaks(dir: string, skip: (file: string) => boolean): string[] {
  return walk(dir)
    .filter(f => SCANNED_EXTENSIONS.some(ext => f.endsWith(ext)) && !skip(f))
    .flatMap(f => {
      const name = leakedName(fs.readFileSync(f, 'utf8'))
      return name === undefined ? [] : [`${path.relative(dir, f)}: ${name}`]
    })
}

function leakMessage(found: string[]): string {
  return `privacy leak: ${found.join('; ')} (${LEAK_ADVICE})`
}

function walk(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
}

describe('fixture privacy guard', () => {
  it.each([
    ['a home-directory path', 'cwd: /Users/someone/projects', '/Users/someone'],
    ['an email address', 'author: someone@example.com', 'someone@example.com'],
    ['a real seat name', '{"actor":"titan-coord"}', 'titan-coord'],
    ['a seat-prefixed task-ID name', 'name: hs-cc-123-foo', 'hs-cc-123'],
    ['a mixed-case seat-prefixed task-ID name', 'name: Hs-CC-123-foo', 'Hs-CC-123'],
    ['a mixed-case real seat name', '{"actor":"Titan-Coord"}', 'Titan-Coord'],
    ['a home path in slug form', 'dir: ~/.claude/projects/-Users-bob-projects-x', '-Users-bob-'],
    ['a linux home path in slug form', 'dir: -home-bob-projects-x', '-home-bob-'],
  ])('flags %s, naming the token', (_name, text, token) => {
    expect(leaks(`ok\n${text}`)).toEqual([`line 2: ${token}`])
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
    expect(found, leakMessage(found)).toEqual([])
  })
})

describe('test source privacy guard', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const self = fileURLToPath(import.meta.url)

  it('finds no leak in any scanned file under src/__tests__ outside fixtures', () => {
    const found = sourceLeaks(dir, f => f === self || f.startsWith(FIXTURES))
    expect(found, leakMessage(found)).toEqual([])
  })

  it.each([
    ['a real seat name', 'planted.ts', "const actor = 'titan-coord'", 'titan-coord'],
    ['a mixed-case task-ID name', 'planted.ts', 'const n = "Hs-Cc-1-x"', 'Hs-Cc-1'],
    [
      'a name in a JSON fixture',
      path.join('__snapshots__', 'planted.json'),
      '{"agent":"tc-tp-2-y"}',
      'tc-tp-2',
    ],
    ['a real home segment in slug form', 'planted.snap', '-Users-bob-projects-x', '-Users-bob-'],
  ])('fails on %s, naming the file and the name', (_name, file, text, name) => {
    expect(plantedLeaks(file, text)).toEqual([`${file}: ${name}`])
  })

  it('passes a planted file holding only synthetic names', () => {
    expect(plantedLeaks('planted.ts', "const seats = ['seat-a', 'bd-cc-900']")).toEqual([])
  })

  it('reports leaks behind a stable privacy leak marker', () => {
    expect(leakMessage(['a.ts: x', 'b.ts: y'])).toMatch(/^privacy leak: a\.ts: x; b\.ts: y \(/)
  })
})

function plantedLeaks(file: string, text: string): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-guard-'))
  try {
    fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true })
    fs.writeFileSync(path.join(tmp, file), text)
    return sourceLeaks(tmp, () => false)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
