import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * CC-235: this repo is public, so committed fixtures must hold no home-directory paths, email
 * addresses or real seat names. CC-1474: real names are never listed here; they are private terms
 * that `titan-egress-scan` loads from the owner's term list, which it skips when `CI` is set.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const FIXTURES = path.join(HERE, 'fixtures')
const SEAT_TESTDATA = path.join(ROOT, 'scripts', 'seat', 'testdata')
const SCANNER = path.join(ROOT, 'node_modules', '@titan-design', 'egress-scan', 'dist', 'bin.js')
const SEAT_TASK_NAME = /\b(hs|tc|vc|si)-(cc|tp|vw|r)-[0-9]+/i
const HOME_SLUG = /(?<![A-Za-z0-9])-(?:Users|home)-([A-Za-z0-9_]+)-/gi
const SYNTHETIC_HOME_NAMES = ['alice', 'someone']
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.json', '.snap', '.txt']
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
// RFC 2606 and 6761 names reach no one, so an address there is synthetic.
const RESERVED_DOMAIN = /[@.](example\.(com|org|net)|invalid|test|localhost)$/i
const NAME_RULES = ['private-term', 'credential-token']
const EGRESS_FINDING = /^(\d+):\d+ (\S+)/
const REPORT_TOTAL = /^egress-scan: (\d+) findings? \(/m
const TERMS_LOADED = /^private term list: loaded$/m
const LEAK_ADVICE = 'use synthetic names such as seat-a; real names live in the egress-scan private term list'

interface Doc {
  name: string
  text: string
}

/** Egress-scan rule hits per doc and line, from one `titan-egress-scan text` run over all docs. */
function egressHits(docs: Doc[], env: NodeJS.ProcessEnv = process.env, scanner = SCANNER): string[] {
  const split = docs.map(d => d.text.replace(/\r\n?/g, '\n').split('\n'))
  const starts = split.map((_, i) => split.slice(0, i).reduce((sum, lines) => sum + lines.length, 0))
  const input = split.map(lines => lines.join('\n')).join('\n')
  return findingRows(input, env, scanner).flatMap(row => {
    const m = EGRESS_FINDING.exec(row)
    const at = Number(m?.[1]) - 1
    const doc = starts.findLastIndex(start => start <= at)
    return [`${docs[doc]?.name} line ${at - (starts[doc] ?? 0) + 1}: ${m?.[2]}`]
  })
}

/**
 * The scanner's finding rows. Anything short of a complete report throws, so a scan that could not
 * run never reads as clean: outside CI the term list is required, and the footer must agree with
 * the exit code and the rows.
 */
function findingRows(input: string, env: NodeJS.ProcessEnv, scanner: string): string[] {
  const ci = isCi(env)
  const scanEnv = ci ? env : { ...env, TITAN_EGRESS_REQUIRE_TERMS: '1' }
  const run = spawnSync(process.execPath, [scanner, 'text'], { input, encoding: 'utf8', env: scanEnv })
  const report = run.stdout ?? ''
  const rows = report.split('\n').filter(row => EGRESS_FINDING.test(row))
  const total = REPORT_TOTAL.exec(report)?.[1]
  const complete =
    (run.status === 0 || run.status === 1) &&
    Number(total) === rows.length &&
    (run.status === 1) === rows.length > 0 &&
    (ci || TERMS_LOADED.test(report))
  if (!complete) throw new Error(`egress-scan gave no complete report (exit ${run.status}): ${run.stderr}`)
  return rows
}

/** The scanner's own reading of `CI`: set, and not empty, `false` or `0`. */
function isCi(env: NodeJS.ProcessEnv): boolean {
  return !['', 'false', '0'].includes((env.CI ?? '').toLowerCase())
}

/** Findings for files that must be clean of every rule: fixtures and seat-script test data. */
function dataLeaks(docs: Doc[], env?: NodeJS.ProcessEnv): string[] {
  const local = docs.flatMap(doc =>
    doc.text.split('\n').flatMap((line, i) => {
      const token =
        (line.includes('@') ? line.match(EMAIL) : null)?.find(e => !RESERVED_DOMAIN.test(e)) ??
        leakedPattern(line)
      return token === undefined ? [] : [`${doc.name} line ${i + 1}: ${token}`]
    }),
  )
  return [...local, ...egressHits(docs, env)]
}

/** Findings for test sources, which may hold placeholder home paths but no names. */
function sourceLeaks(docs: Doc[], env?: NodeJS.ProcessEnv): string[] {
  const local = docs.flatMap(doc => {
    const token = leakedPattern(doc.text)
    return token === undefined ? [] : [`${doc.name}: ${token}`]
  })
  const names = egressHits(docs, env).filter(hit => NAME_RULES.some(rule => hit.endsWith(`: ${rule}`)))
  return [...local, ...names]
}

/** The first seat-task or home-slug token in `text`, in its original case so the report can be grepped for. */
function leakedPattern(text: string): string | undefined {
  return (
    text.match(SEAT_TASK_NAME)?.[0] ??
    [...text.matchAll(HOME_SLUG)].find(m => !SYNTHETIC_HOME_NAMES.includes((m[1] ?? '').toLowerCase()))?.[0]
  )
}

function readDocs(dir: string, keep: (file: string) => boolean): Doc[] {
  return walk(dir)
    .filter(keep)
    .map(f => ({ name: path.relative(dir, f), text: fs.readFileSync(f, 'utf8') }))
}

function leakMessage(found: string[]): string {
  return `privacy leak: ${found.join('; ')} (${LEAK_ADVICE})`
}

function walk(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
}

/** A term list holding one synthetic term, required so the check runs the same way under `CI`. */
function withTerm<T>(term: string, use: (env: NodeJS.ProcessEnv) => T): T {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-terms-'))
  try {
    fs.writeFileSync(path.join(tmp, 'terms'), `${term}\n`, { mode: 0o600 })
    return use({
      ...process.env,
      TITAN_EGRESS_TERMS: path.join(tmp, 'terms'),
      TITAN_EGRESS_REQUIRE_TERMS: '1',
    })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

const doc = (text: string, name = 'planted.ts'): Doc[] => [{ name, text }]

describe('fixture privacy guard', () => {
  it.each([
    ['a home-directory path', 'cwd: /Users/someone/projects', 'home-path'],
    ['an email address', 'author: someone@users.noreply.github.com', 'someone@users.noreply.github.com'],
    ['a seat-prefixed task-ID name', 'name: hs-cc-123-foo', 'hs-cc-123'],
    ['a mixed-case seat-prefixed task-ID name', 'name: Hs-CC-123-foo', 'Hs-CC-123'],
    ['a home path in slug form', 'dir: ~/.claude/projects/-Users-bob-projects-x', '-Users-bob-'],
    ['a linux home path in slug form', 'dir: -home-bob-projects-x', '-home-bob-'],
  ])('flags %s, naming the line', (_name, text, token) => {
    expect(dataLeaks(doc(`ok\n${text}`, 'f.txt'))).toEqual([`f.txt line 2: ${token}`])
  })

  it('flags a private term from the egress-scan term list, naming the rule and not the term', () => {
    const found = withTerm('seat-zz', env => dataLeaks(doc('ok\n{"actor":"Seat-ZZ"}', 'f.json'), env))
    expect(found).toEqual(['f.json line 2: private-term'])
  })

  it('flags a name in a file holding a NUL byte rather than skipping the file', () => {
    expect(dataLeaks(doc('bin\0ary\nname: hs-cc-123-foo', 'f.bin'))).toEqual(['f.bin line 2: hs-cc-123'])
  })

  it('fails rather than passing name-blind when the term list is missing outside CI', () => {
    const missing = path.join(os.tmpdir(), 'privacy-terms-missing', 'terms')
    const env = { ...process.env, CI: '', TITAN_EGRESS_TERMS: missing, TITAN_EGRESS_REQUIRE_TERMS: '0' }
    expect(() => dataLeaks(doc('ok', 'f.txt'), env)).toThrow(/no complete report \(exit 2\)/)
  })

  it.each([
    ['exits 1 with no report', 'process.exit(1)'],
    ['exits 0 with no report', 'process.exit(0)'],
    [
      'exits 1 with a clean footer',
      'console.log("egress-scan: 0 findings (x)\\nprivate term list: loaded"); process.exit(1)',
    ],
  ])('fails when the scanner %s', (_name, body) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-scanner-'))
    try {
      fs.writeFileSync(path.join(tmp, 'bin.mjs'), body)
      expect(() => egressHits(doc('ok'), process.env, path.join(tmp, 'bin.mjs'))).toThrow(
        /no complete report/,
      )
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it.each([
    ['a temp path', 'config_dir: /tmp/pool-x'],
    ['a scoped npm package', '"@titan-design/registry"'],
    ['a synthetic home slug', 'dir: -Users-someone-projects-x'],
    ['a temp dir name containing home', 'agent-chat-test-home-run-'],
    ['an address at a reserved domain', 'author: t@example.com, ci@runner.invalid'],
  ])('passes %s', (_name, text) => {
    expect(dataLeaks(doc(text, 'f.txt'))).toEqual([])
  })

  it.each([
    ['src/__tests__/fixtures', FIXTURES],
    ['scripts/seat/testdata', SEAT_TESTDATA],
  ])('finds no leak in any file under %s', (_name, dir) => {
    const found = dataLeaks(readDocs(dir, () => true))
    expect(found, leakMessage(found)).toEqual([])
  })
})

describe('test source privacy guard', () => {
  const self = fileURLToPath(import.meta.url)
  const scanned = (f: string) =>
    SCANNED_EXTENSIONS.some(ext => f.endsWith(ext)) && f !== self && !f.startsWith(FIXTURES)

  it('finds no leak in any scanned file under src/__tests__ outside fixtures', () => {
    const found = sourceLeaks(readDocs(HERE, scanned))
    expect(found, leakMessage(found)).toEqual([])
  })

  it.each([
    ['a mixed-case task-ID name', 'planted.ts', 'const n = "Hs-Cc-1-x"', 'Hs-Cc-1'],
    [
      'a name in a JSON fixture',
      path.join('__snapshots__', 'planted.json'),
      '{"agent":"tc-tp-2-y"}',
      'tc-tp-2',
    ],
    ['a real home segment in slug form', 'planted.snap', '-Users-bob-projects-x', '-Users-bob-'],
  ])('fails on %s, naming the file and the name', (_name, file, text, name) => {
    expect(sourceLeaks(doc(text, file))).toEqual([`${file}: ${name}`])
  })

  it('fails on a private term, naming the file and the rule', () => {
    const found = withTerm('seat-zz', env => sourceLeaks(doc("const actor = 'seat-zz'"), env))
    expect(found).toEqual(['planted.ts line 1: private-term'])
  })

  it('passes a planted file holding only synthetic names and a placeholder home', () => {
    expect(sourceLeaks(doc("const seats = ['seat-a', 'bd-cc-900']\nconst cwd = '/Users/x/p'"))).toEqual([])
  })

  it('reports leaks behind a stable privacy leak marker', () => {
    expect(leakMessage(['a.ts: x', 'b.ts: y'])).toMatch(/^privacy leak: a\.ts: x; b\.ts: y \(/)
  })
})
