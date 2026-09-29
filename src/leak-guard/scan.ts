import { createHash } from 'node:crypto'
import type { Category, Denylist } from './denylist.js'

/** `home` is the running user's home, passed in so tests can use a synthetic one. */
export interface ScanContext {
  list: Denylist
  home: string
}

export type Site = 'content' | 'path' | 'message'

/**
 * Carries no matched text: `file` has every matched span replaced, so no consumer
 * of a finding can echo a secret. `fingerprint` is the later override key.
 */
export interface Finding {
  site: Site
  file: string
  line: number
  category: Category
  entry: number
  fingerprint: string
}

interface Matcher {
  category: Category
  entry: number
  re: RegExp
}

interface Span {
  category: Category
  entry: number
  start: number
  end: number
}

export const REDACTED = '[redacted]'

const ACTIVE_WORK_ROOT_TILDE = '~/Library/Application Support/active-work'

const WORD = String.raw`\p{L}\p{N}_`

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

const re = (source: string): RegExp => new RegExp(source, 'giu')

function homeMatchers(home: string): Matcher[] {
  const trimmed = home.replace(/\/+$/, '')
  const roots = trimmed === '' ? [ACTIVE_WORK_ROOT_TILDE] : [trimmed, ACTIVE_WORK_ROOT_TILDE]
  return roots.map((root, entry) => ({
    category: 'home-path',
    entry,
    re: re(`${escapeRe(root)}(?![${WORD}-])`),
  }))
}

export function buildMatchers(ctx: ScanContext): Matcher[] {
  const { ownerEmails, privateNames, privatePaths } = ctx.list
  return [
    ...homeMatchers(ctx.home),
    ...ownerEmails.map((e, entry): Matcher => ({
      category: 'owner-email',
      entry,
      re: re(`(?<![${WORD}.+-])${escapeRe(e)}(?![${WORD}-])`),
    })),
    ...privateNames.map((n, entry): Matcher => ({
      category: 'private-name',
      entry,
      re: re(`(?<![${WORD}])${escapeRe(n)}(?![${WORD}])`),
    })),
    ...privatePaths.map((p, entry): Matcher => ({ category: 'private-path', entry, re: re(escapeRe(p)) })),
  ]
}

/** Synthetic fixture forms that pass even when a deny-list entry overlaps them. */
const ALLOWED: readonly RegExp[] = [
  re(`/(?:Users|home)/example(?![${WORD}-])`),
  re(`/Users/test[${WORD}-]*`),
  re(
    `[${WORD}.+-]+@(?:[${WORD}-]+\\.)*(?:example\\.(?:com|org)|[${WORD}-]+\\.(?:test|invalid))(?![${WORD}-])`,
  ),
]

/** Bounds the allow-list regexes to a window, so a multi-megabyte line cannot go quadratic. */
const ALLOW_WINDOW = 256

function isAllowed(text: string, span: Span): boolean {
  const from = Math.max(0, span.start - ALLOW_WINDOW)
  const window = text.slice(from, Math.min(text.length, span.end + ALLOW_WINDOW))
  return ALLOWED.some(allow =>
    [...window.matchAll(allow)].some(
      m => from + m.index <= span.start && span.end <= from + m.index + m[0].length,
    ),
  )
}

function findSpans(text: string, matchers: readonly Matcher[]): Span[] {
  const spans: Span[] = []
  for (const { category, entry, re: pattern } of matchers)
    for (const m of text.matchAll(pattern)) {
      if (m[0].length === 0) continue
      const span = { category, entry, start: m.index, end: m.index + m[0].length }
      if (!isAllowed(text, span)) spans.push(span)
    }
  return spans
}

function redact(text: string, spans: readonly Span[]): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  let out = ''
  let at = 0
  for (const s of sorted) {
    if (s.end <= at) continue
    out += text.slice(at, Math.max(at, s.start)) + REDACTED
    at = s.end
  }
  return out + text.slice(at)
}

/** The display form of a path: itself when clean, otherwise with every match redacted. */
export function redactText(text: string, matchers: readonly Matcher[]): string {
  const spans = findSpans(text, matchers)
  return spans.length === 0 ? text : redact(text, spans)
}

const fingerprintOf = (s: Span, file: string, text: string): string =>
  createHash('sha256').update(`${s.category}\0${s.entry}\0${file}\0${text}`).digest('hex').slice(0, 16)

interface Location {
  site: Site
  file: string
  display: string
  line: number
}

function scanLine(text: string, at: Location, matchers: readonly Matcher[]): Finding[] {
  const seen = new Set<string>()
  const findings: Finding[] = []
  for (const s of findSpans(text, matchers)) {
    const key = `${s.category}#${s.entry}`
    if (seen.has(key)) continue
    seen.add(key)
    findings.push({
      site: at.site,
      file: at.display,
      line: at.line,
      category: s.category,
      entry: s.entry,
      fingerprint: fingerprintOf(s, at.file, text),
    })
  }
  return findings
}

/** Every line of free text, such as a PR body or a commit message, counts as added. */
export function scanText(text: string, ctx: ScanContext, file: string, site: Site = 'content'): Finding[] {
  const matchers = buildMatchers(ctx)
  const display = redactText(file, matchers)
  return text.split('\n').flatMap((line, i) => scanLine(line, { site, file, display, line: i + 1 }, matchers))
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Consumes `git diff --unified=0` one line at a time and scans only added lines.
 * Hunk line counts, not line prefixes, decide what is content, so an added line
 * that itself begins `+++ ` or `diff --git` is never mistaken for a header.
 */
export class DiffScanner {
  readonly findings: Finding[] = []
  private readonly matchers: Matcher[]
  private file: { path: string; display: string } | null = null
  private oldLeft = 0
  private newLeft = 0
  private newLine = 0

  constructor(ctx: ScanContext) {
    this.matchers = buildMatchers(ctx)
  }

  push(line: string): void {
    if (this.oldLeft > 0 || this.newLeft > 0) return this.hunkLine(line)
    if (line.startsWith('diff --git ')) this.file = null
    else if (line.startsWith('+++ ')) this.setFile(line.slice(4))
    else this.startHunk(line)
  }

  private setFile(target: string): void {
    const path = target.replace(/\t$/, '')
    if (path === '/dev/null') return void (this.file = null)
    const bare = path.startsWith('b/') ? path.slice(2) : path
    this.file = { path: bare, display: redactText(bare, this.matchers) }
  }

  private startHunk(line: string): void {
    const m = HUNK.exec(line)
    if (!m) return
    this.oldLeft = m[1] === undefined ? 1 : Number(m[1])
    this.newLine = Number(m[2])
    this.newLeft = m[3] === undefined ? 1 : Number(m[3])
  }

  private hunkLine(line: string): void {
    const mark = line[0]
    if (mark === '\\') return
    if (mark === '-' || mark === ' ') this.oldLeft--
    if (mark === '+' || mark === ' ') this.newLeft--
    if (mark === '+' && this.file) {
      const { path, display } = this.file
      const at: Location = { site: 'content', file: path, display, line: this.newLine }
      this.findings.push(...scanLine(line.slice(1), at, this.matchers))
    }
    if (mark === '+' || mark === ' ') this.newLine++
  }
}

export function scanDiff(unifiedDiff: string, ctx: ScanContext): Finding[] {
  const scanner = new DiffScanner(ctx)
  for (const line of unifiedDiff.split('\n')) scanner.push(line)
  return scanner.findings
}

/** What `scanRange` reads from a repository; the CLI backs it with git. */
export interface RangeSource {
  diffLines(range: string): AsyncIterable<string>
  addedPaths(range: string): Promise<string[]>
  messages(range: string): Promise<{ sha: string; body: string }[]>
}

/** Added lines, added file paths and commit messages in `range`; removed text never counts. */
export async function scanRange(range: string, ctx: ScanContext, source: RangeSource): Promise<Finding[]> {
  const scanner = new DiffScanner(ctx)
  for await (const line of source.diffLines(range)) scanner.push(line)
  const paths = (await source.addedPaths(range)).flatMap(p => scanText(p, ctx, p, 'path'))
  const messages = (await source.messages(range)).flatMap(({ sha, body }) =>
    scanText(body, ctx, `commit ${sha.slice(0, 12)}`, 'message'),
  )
  return [...scanner.findings, ...paths, ...messages]
}
