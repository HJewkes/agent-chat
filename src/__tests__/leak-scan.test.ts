import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { EMPTY_DENYLIST, loadDenylist, type Denylist } from '../leak-guard/denylist.js'
import { renderDenylistProblem, renderFindings, renderJson } from '../leak-guard/render.js'
import { scanDiff, scanText, type ScanContext } from '../leak-guard/scan.js'
import { denylistPath } from '../paths.js'

const execFileAsync = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-leak-'))

afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

// Every fixture is synthetic: a made-up home, a made-up TLD and made-up names.
const HOME = '/Users/zq7-probe-home'
const EMAIL = 'owner.zq7@leakprobe.zq7'
const NAME = 'zq7privateseat'
const PRIVATE_PATH = 'zq7-seat-files/'

const LIST: Denylist = { ownerEmails: [EMAIL], privateNames: [NAME], privatePaths: [PRIVATE_PATH] }
const CTX: ScanContext = { list: LIST, home: HOME }
const ENTRIES = [HOME, EMAIL, NAME, PRIVATE_PATH]

const expectNoEntry = (output: string): void => {
  for (const entry of ENTRIES) expect(output.toLowerCase()).not.toContain(entry.toLowerCase())
}

const diffOf = (file: string, added: string[], removed: string[] = []): string =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map(l => `-${l}`),
    ...added.map(l => `+${l}`),
  ].join('\n')

describe('scanDiff', () => {
  it('reports file, line and category for each kind of added leak', () => {
    const diff = diffOf('notes.md', [
      'clean line',
      `see ${HOME}/scratch`,
      `mail ${EMAIL.toUpperCase()}`,
      `the ${NAME} seat`,
      `under ${PRIVATE_PATH}x.md`,
    ])

    const found = scanDiff(diff, CTX).map(f => `${f.file}:${f.line} ${f.category}`)

    expect(found).toEqual([
      'notes.md:2 home-path',
      'notes.md:3 owner-email',
      'notes.md:4 private-name',
      'notes.md:5 private-path',
    ])
  })

  it('ignores a leak that the range removes', () => {
    const diff = diffOf('notes.md', ['clean'], [`${HOME}/old`, EMAIL])

    expect(scanDiff(diff, CTX)).toEqual([])
  })

  it('passes synthetic fixtures even when a deny-list entry overlaps them', () => {
    const ctx = { list: { ...LIST, privateNames: ['example'], privatePaths: ['/Users/'] }, home: HOME }
    const diff = diffOf('fixtures.ts', [
      '/Users/example/project',
      'someone@example.com',
      '/Users/test-runner/x',
    ])

    expect(scanDiff(diff, ctx)).toEqual([])
    expect(scanText(`/Users/example and ${HOME}`, ctx, 'x').map(f => f.category)).toEqual([
      'home-path',
      'private-path',
    ])
  })

  it('matches names as whole words and the home as a whole path segment', () => {
    const lines = [`${NAME}x`, `x${NAME}`, `${HOME}2/other`, `Zq7PrivateSeat.`, `${HOME}`]

    const found = scanText(lines.join('\n'), CTX, 'x').map(f => `${f.line} ${f.category}`)

    expect(found).toEqual(['4 private-name', '5 home-path'])
  })

  it('treats an added line that looks like a diff header as content', () => {
    const diff = diffOf('a.txt', [`++ b/${NAME}`, `diff --git ${EMAIL}`])

    expect(scanDiff(diff, CTX).map(f => f.line)).toEqual([1, 2])
  })

  it('names a leaky file path with the match redacted', () => {
    const [finding] = scanDiff(diffOf(`${PRIVATE_PATH}${NAME}.md`, [HOME]), CTX)

    expect(finding?.file).toBe('[redacted][redacted].md')
    expectNoEntry(JSON.stringify(finding))
  })

  it('survives binary bytes and a multi-megabyte line quickly', () => {
    const binary = '\0\x01\xff�'.repeat(10_000)
    const long = `${'a@'.repeat(2_500_000)}${EMAIL}`
    const started = Date.now()

    const found = scanDiff(diffOf('blob.bin', [binary, long]), CTX)

    expect(found.map(f => `${f.line} ${f.category}`)).toEqual(['2 owner-email'])
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('checks only the home prefix when there is no deny-list', () => {
    const found = scanText(`${EMAIL} ${HOME}`, { list: EMPTY_DENYLIST, home: HOME }, 'x')

    expect(found.map(f => f.category)).toEqual(['home-path'])
  })
})

const writeList = (content: string): string => {
  const file = path.join(fs.mkdtempSync(path.join(SCRATCH, 'list-')), 'private-denylist.json')
  fs.writeFileSync(file, content, { mode: 0o600 })
  return file
}

describe('loadDenylist', () => {
  it('reads the three categories', () => {
    const file = writeList(JSON.stringify({ 'owner-email': [EMAIL], 'private-name': [NAME] }))

    expect(loadDenylist(file)).toEqual({
      kind: 'ok',
      list: { ownerEmails: [EMAIL], privateNames: [NAME], privatePaths: [] },
    })
  })

  it('tells a missing file from an unreadable one', () => {
    expect(loadDenylist(path.join(SCRATCH, 'absent.json'))).toEqual({ kind: 'missing' })
    expect(loadDenylist(writeList(`{"private-name": ["${NAME}",]`)).kind).toBe('unreadable')
  })

  it('refuses an unknown key or an empty entry rather than dropping it', () => {
    expect(loadDenylist(writeList(JSON.stringify({ 'private-names': [NAME] }))).kind).toBe('unreadable')
    expect(loadDenylist(writeList(JSON.stringify({ 'private-name': [' '] }))).kind).toBe('unreadable')
  })

  it.skipIf(process.getuid?.() === 0)('reports a permission error as unreadable', () => {
    const file = writeList('{}')
    fs.chmodSync(file, 0o000)

    expect(loadDenylist(file)).toEqual({ kind: 'unreadable', reason: 'permission denied' })
  })

  it('resolves the deny-list path under AGENT_CHAT_HOME', () => {
    const previous = process.env.AGENT_CHAT_HOME
    process.env.AGENT_CHAT_HOME = SCRATCH
    try {
      expect(denylistPath()).toBe(path.join(SCRATCH, 'private-denylist.json'))
    } finally {
      if (previous === undefined) delete process.env.AGENT_CHAT_HOME
      else process.env.AGENT_CHAT_HOME = previous
    }
  })
})

describe('renderers', () => {
  it('never print a deny-list entry, whatever they are given', () => {
    const leakyFile = `${PRIVATE_PATH}${NAME}/${EMAIL}.md`
    const findings = [
      ...scanDiff(
        diffOf(
          leakyFile,
          ENTRIES.map(e => `x ${e} y`),
        ),
        CTX,
      ),
      ...scanText(ENTRIES.join(' '), CTX, `commit ${NAME}`, 'message'),
      ...scanText(leakyFile, CTX, leakyFile, 'path'),
    ]
    const malformed = loadDenylist(writeList(`["${EMAIL}", "${NAME}"`))

    const output = [
      ...renderFindings(findings),
      renderJson(findings, 'ok'),
      renderDenylistProblem(malformed, '~/.agent-chat/private-denylist.json'),
      renderDenylistProblem({ kind: 'missing' }, '~/.agent-chat/private-denylist.json'),
    ].join('\n')

    expect(findings).toHaveLength(ENTRIES.length * 2 + 3)
    expectNoEntry(output)
  })
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim()

function syntheticRepo(): {
  dir: string
  commit: (files: Record<string, string>, message?: string) => string
} {
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'repo-'))
  git(dir, 'init', '-q', '-b', 'main')
  const commit = (files: Record<string, string>, message = 'change'): string => {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
      fs.writeFileSync(path.join(dir, name), content)
    }
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '--allow-empty', '-m', message)
    return git(dir, 'rev-parse', 'HEAD')
  }
  return { dir, commit }
}

interface CliRun {
  code: number
  stdout: string
  stderr: string
}

async function leakScanCli(cwd: string, chatHome: string, ...args: string[]): Promise<CliRun> {
  const env = { ...process.env, HOME, AGENT_CHAT_HOME: chatHome, GIT_CONFIG_GLOBAL: '/dev/null' }
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, 'leak-scan', ...args], {
      cwd,
      env,
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string }
    return { code: e.code, stdout: e.stdout, stderr: e.stderr }
  }
}

function chatHomeWith(content: string | undefined): string {
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'home-'))
  if (content !== undefined)
    fs.writeFileSync(path.join(dir, 'private-denylist.json'), content, { mode: 0o600 })
  return dir
}

const LIST_JSON = JSON.stringify({
  'owner-email': [EMAIL],
  'private-name': [NAME],
  'private-path': [PRIVATE_PATH],
})

describe('agent-chat leak-scan --range', () => {
  const repo = syntheticRepo()
  const base = repo.commit({ 'old.md': `${HOME}/gone\n` })
  const leaky = repo.commit(
    { 'notes.md': `ok\n${HOME}/x\n${EMAIL}\nthe ${NAME} seat\n`, 'old.md': 'clean\n' },
    `Add notes\n\nfrom ${NAME}`,
  )
  const clean = repo.commit({ 'fixtures.md': '/Users/example/project\nsomeone@example.com\n' })
  const chatHome = chatHomeWith(LIST_JSON)

  it('exits 1 with file:line and category, and echoes no entry on any stream', async () => {
    const run = await leakScanCli(repo.dir, chatHome, '--range', `${base}..${leaky}`)

    expect(run.code).toBe(1)
    expect(run.stdout).toContain('notes.md:2  home-path')
    expect(run.stdout).toContain('notes.md:3  owner-email')
    expect(run.stdout).toContain('notes.md:4  private-name')
    expect(run.stdout).toMatch(/commit [0-9a-f]{12}:3 {2}\(commit message\) {2}private-name/)
    expectNoEntry(run.stdout + run.stderr)
  })

  it('keeps entries out of --json output too', async () => {
    const run = await leakScanCli(repo.dir, chatHome, '--range', `${base}..${leaky}`, '--json')

    expect(run.code).toBe(1)
    expect(JSON.parse(run.stdout).findings).toHaveLength(4)
    expectNoEntry(run.stdout + run.stderr)
  })

  it('exits 0 for example fixtures and for a range that only removes a leak', async () => {
    const removal = syntheticRepo()
    const before = removal.commit({ 'a.md': `${EMAIL}\n` })
    const after = removal.commit({ 'a.md': 'clean\n' })

    expect((await leakScanCli(repo.dir, chatHome, '--range', `${leaky}..${clean}`)).code).toBe(0)
    expect((await leakScanCli(removal.dir, chatHome, '--range', `${before}..${after}`)).code).toBe(0)
  })

  it('exits 2 with a clear message and no entry when the deny-list is unreadable', async () => {
    const broken = chatHomeWith(`{"private-name": ["${NAME}", "${EMAIL}"`)

    const run = await leakScanCli(repo.dir, broken, '--range', `${leaky}..${clean}`)

    expect(run.code).toBe(2)
    expect(run.stderr).toContain('private-denylist.json is not valid JSON')
    expectNoEntry(run.stdout + run.stderr)
  })

  it('exits 2 when the deny-list is missing, and 1 if the home check still finds a leak', async () => {
    const missing = chatHomeWith(undefined)

    const cleanRun = await leakScanCli(repo.dir, missing, '--range', `${leaky}..${clean}`)
    const leakRun = await leakScanCli(repo.dir, missing, '--range', `${base}..${leaky}`)

    expect(cleanRun.code).toBe(2)
    expect(cleanRun.stderr).toContain('no deny-list at')
    expect(leakRun.code).toBe(1)
    expect(leakRun.stdout).toContain('notes.md:2  home-path')
  })

  it('exits 2 on a bad range or a missing flag', async () => {
    expect((await leakScanCli(repo.dir, chatHome, '--range', 'nope..HEAD')).code).toBe(2)
    expect((await leakScanCli(repo.dir, chatHome, '--range', '--output=x')).code).toBe(2)
    expect((await leakScanCli(repo.dir, chatHome)).code).toBe(2)
    expect((await leakScanCli(repo.dir, chatHome, '--bogus')).code).toBe(2)
  })

  it('scans a text file such as a PR body', async () => {
    const body = path.join(SCRATCH, 'body.md')
    fs.writeFileSync(body, `Summary\n\nfixed for ${NAME}\n`)

    const run = await leakScanCli(repo.dir, chatHome, '--text-file', body)

    expect(run.code).toBe(1)
    expect(run.stdout).toContain('<text>:3  private-name')
    expectNoEntry(run.stdout + run.stderr)
  })
})
