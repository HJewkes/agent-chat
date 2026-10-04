import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as realSleep } from 'node:timers/promises'
import { parseTerms } from '@titan-design/egress-scan'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runGh, runGhWrite } from '../cli/gh-write.js'
import { defaultTermsFile, scanDeps, scanGhArgs, SCAN_REASONS, type ScanDeps } from '../gh-write/scan.js'
import type { ThrottleDeps } from '../gh-write/throttle.js'
import { aliasReader } from '../leak-guard/git-alias.js'
import { includedHooksPathReader } from '../leak-guard/git-include.js'
import { checkCommand, readText, REASONS, type GuardContext, type TermsLoad } from '../leak-guard/pretool.js'

const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')

// Synthetic only: a made-up private term.
const TERM = 'zq7privateseat'
const LIST: TermsLoad = { kind: 'ok', rules: parseTerms(`${TERM}\n`) }
const CLEAN = 'A clean body.\nSecond line, with ünïcode and "quotes" and a trailing newline.\n'

let dir: string
let savedPath: string | undefined
const calls = (): string => path.join(dir, 'calls')
const bodies = (): string => path.join(dir, 'bodies')
const file = (name: string): string => path.join(dir, name)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ghw-scan-'))
  fs.mkdirSync(file('bin'))
  // A fake gh that logs its arguments and copies out every file gh-write handed it.
  fs.writeFileSync(
    file('bin/gh'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "${calls()}"`,
      'for a in "$@"; do f=${a##*[=@]}; case "$f" in */gh-write-*/source-*) cat "$f" >> "' +
        bodies() +
        '";; esac; done',
      `[ -n "$GH_SLEEP" ] && { echo $$ > "${file('gh.pid.tmp')}"; mv "${file('gh.pid.tmp')}" "${file('gh.pid')}"; exec sleep "$GH_SLEEP"; }`,
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  savedPath = process.env.PATH
  process.env.PATH = `${file('bin')}:${process.env.PATH}`
})

afterEach(() => {
  process.env.PATH = savedPath
  fs.rmSync(dir, { recursive: true, force: true })
})

const throttle = (over: Partial<ThrottleDeps> = {}): ThrottleDeps => ({
  now: Date.now,
  sleep: ms => realSleep(ms),
  runGh,
  coreRemaining: () => Promise.resolve(undefined),
  notice: () => undefined,
  lockDir: file('lock'),
  stampPath: file('stamp'),
  gapMs: 0,
  ...over,
})

const deps = (over: { terms?: TermsLoad; stdin?: string } = {}): ScanDeps => ({
  terms: () => over.terms ?? LIST,
  readFile: readText,
  readStdin: () => Promise.resolve(over.stdin),
})

const ghStarted = (): boolean => fs.existsSync(calls())

describe('gh-write refuses a finding in every input channel before gh starts', () => {
  const posted = (name: string, text: string): string => {
    fs.writeFileSync(file(name), text)
    return file(name)
  }
  const rows: [string, (term: string) => string[], string?][] = [
    ['pr create --title', t => ['pr', 'create', '--title', `Fix ${t}`, '--body', 'ok']],
    ['pr create -t', t => ['pr', 'create', '-t', t, '-b', 'ok']],
    ['pr create --body=', t => ['pr', 'create', '-t', 'x', `--body=${t}`]],
    ['issue create -b', t => ['issue', 'create', '-t', 'x', '-b', t]],
    ['pr edit --body', t => ['pr', 'edit', '3', '--body', t]],
    ['pr comment --body', t => ['pr', 'comment', '3', '--body', t]],
    ['issue comment -R', t => ['issue', 'comment', '-R', 'o/r', '4', '--body', t]],
    ['pr review --body', t => ['pr', 'review', '3', '--approve', '--body', t]],
    ['pr merge --subject', t => ['pr', 'merge', '3', '--subject', t]],
    ['pr merge --body', t => ['pr', 'merge', '3', '--squash', '--body', t]],
    ['pr create --body-file', t => ['pr', 'create', '-t', 'x', '--body-file', posted('b.md', t)]],
    ['pr create --body-file=', t => ['pr', 'create', '-t', 'x', `--body-file=${posted('b.md', t)}`]],
    ['pr comment -F', t => ['pr', 'comment', '3', '-F', posted('b.md', `ok\n${t}\n`)]],
    ['pr create --body-file -', () => ['pr', 'create', '-t', 'x', '--body-file', '-'], `ok\n${TERM}\n`],
    ['api -f', t => ['api', '-X', 'POST', 'repos/o/r/issues', '-f', `body=${t}`]],
    ['api --raw-field=', t => ['api', 'repos/o/r/issues', `--raw-field=body=${t}`]],
    ['api -F k=v', t => ['api', 'repos/o/r/issues', '-F', `title=${t}`]],
    ['api --field k=@file', t => ['api', 'repos/o/r/issues', '--field', `body=@${posted('f.md', t)}`]],
    ['api -F k=@-', () => ['api', 'repos/o/r/issues', '-F', 'body=@-'], TERM],
    ['api --input file', t => ['api', 'repos/o/r/issues', '--input', posted('in.json', `{"body":"${t}"}`)]],
    ['api --input -', () => ['api', 'repos/o/r/issues', '--input', '-'], `{"body":"${TERM}"}`],
  ]

  it.each(rows)('%s', async (_name, args, stdin) => {
    const result = await runGhWrite(
      args(TERM),
      deps({ ...(stdin === undefined ? {} : { stdin }) }),
      throttle(),
    )

    expect(result.code).toBe(1)
    expect(result.stderr.toString()).toMatch(/private-term #1/)
    expect(result.stderr.toString()).not.toContain(TERM)
    expect(ghStarted()).toBe(false)
  })

  it('refuses an unreadable body file, a directory and stdin read twice without starting gh', async () => {
    const cases = [
      ['pr', 'create', '-t', 'x', '--body-file', file('absent.md')],
      ['pr', 'create', '-t', 'x', '--body-file', dir],
      ['api', 'repos/o/r/issues', '--input', '-', '-F', 'body=@-'],
    ]
    const reasons = await Promise.all(cases.map(args => runGhWrite(args, deps({ stdin: 'ok' }), throttle())))

    expect(reasons.map(r => [r.code, r.stderr.toString().trim()])).toEqual([
      [1, SCAN_REASONS.unreadableSource],
      [1, SCAN_REASONS.unreadableSource],
      [1, SCAN_REASONS.stdinTwice],
    ])
    expect(ghStarted()).toBe(false)
  })
})

describe('gh-write refuses a command whose text it cannot place, before gh starts', () => {
  const dirty = (): string => {
    fs.writeFileSync(file('dirty.md'), `${TERM}\n`)
    return file('dirty.md')
  }
  const rows: [string, () => string[], string, TermsLoad?][] = [
    ['a body flag before the verb', () => ['pr', '--body', TERM, 'comment', '1'], SCAN_REASONS.flagFirst],
    [
      'a body file before the verb',
      () => ['pr', '--body-file', dirty(), 'comment', '1'],
      SCAN_REASONS.flagFirst,
    ],
    ['a body flag before the group', () => ['--body', TERM, 'pr', 'comment', '1'], SCAN_REASONS.flagFirst],
    [
      'an input file before api',
      () => ['--input', dirty(), 'api', 'repos/o/r/issues'],
      SCAN_REASONS.flagFirst,
    ],
    ['-R before the group', () => ['-R', 'o/r', 'pr', 'comment', '1', '--body', TERM], 'private-term #1'],
    [
      '--repo= between group and verb',
      () => ['pr', '--repo=o/r', 'comment', '1', '-b', TERM],
      'private-term #1',
    ],
    ['pr create --recover', () => ['pr', 'create', '--recover', dirty()], SCAN_REASONS.unscannedCreate],
    [
      'issue create --recover=',
      () => ['issue', 'create', `--recover=${dirty()}`],
      SCAN_REASONS.unscannedCreate,
    ],
    ['pr create --template', () => ['pr', 'create', '--template', dirty()], SCAN_REASONS.unscannedCreate],
    ['issue create -T', () => ['issue', 'create', '-T', 'Bug'], SCAN_REASONS.unscannedCreate],
    ['pr create --fill', () => ['pr', 'create', '--fill'], SCAN_REASONS.unscannedCreate],
    ['pr create --fill-first', () => ['pr', 'create', '--fill-first'], SCAN_REASONS.unscannedCreate],
    [
      'pr create --fill-verbose',
      () => ['pr', 'create', '--fill-verbose', '-t', 'x'],
      SCAN_REASONS.unscannedCreate,
    ],
    ['pr create -df', () => ['pr', 'create', '-df'], SCAN_REASONS.unscannedCreate],
    ['an empty verb word', () => ['pr', '', 'comment', '--body', TERM], SCAN_REASONS.unknownCommand],
    ['an empty group word', () => ['', 'pr', 'comment', '--body', TERM], SCAN_REASONS.unknownCommand],
    ['an empty word before edit', () => ['pr', '', 'edit', '--body', TERM], SCAN_REASONS.unknownCommand],
    [
      'an empty word before api',
      () => ['', 'api', 'repos/o/r/issues', '-f', `body=${TERM}`],
      SCAN_REASONS.unknownCommand,
    ],
    [
      'a blank word after api',
      () => ['api', ' ', 'repos/o/r/issues', '-f', `body=${TERM}`],
      SCAN_REASONS.unknownCommand,
    ],
    ['a whitespace verb word', () => ['pr', ' \t', 'comment', '--body', TERM], SCAN_REASONS.unknownCommand],
    [
      'a whitespace group word',
      () => [' ', 'issue', 'comment', '1', '-b', TERM],
      SCAN_REASONS.unknownCommand,
    ],
    ['a config alias', () => ['co', '12', '--body', TERM], SCAN_REASONS.unknownCommand],
    ['an extension', () => ['my-ext', 'post', '--body', TERM], SCAN_REASONS.unknownCommand],
    ['an unknown pr verb', () => ['pr', 'comment2', '1', '--body', TERM], SCAN_REASONS.unknownCommand],
    ['an other-kind command with --body', () => ['pr', 'list', '--body', TERM], SCAN_REASONS.otherText],
    ['pr close --comment', () => ['pr', 'close', '3', '--comment', TERM], SCAN_REASONS.otherText],
    ['issue close -c', () => ['issue', 'close', '3', '-c', TERM], SCAN_REASONS.otherText],
    ['release create --notes=', () => ['release', 'create', 'v1', `--notes=${TERM}`], SCAN_REASONS.otherText],
    ['workflow run -f', () => ['workflow', 'run', 'ci.yml', '-f', `note=${TERM}`], SCAN_REASONS.otherText],
    [
      'a merge path behind a flag cluster, missing list',
      () => ['api', '-ip', '-X', 'repos/o/r/issues', '-ip', 'repos/o/r/pulls/7/merge', '-f', 'body=x'],
      REASONS.missingTerms,
      { kind: 'missing' },
    ],
    [
      'a merge with a field, missing list',
      () => ['api', '-X', 'PUT', 'repos/o/r/pulls/7/merge', '-f', 'merge_method=squash'],
      REASONS.missingTerms,
      { kind: 'missing' },
    ],
    [
      'a merge with a second endpoint, missing list',
      () => ['api', '-X', 'PUT', 'repos/o/r/pulls/7/merge', 'repos/o/r/issues', '--input', file('in.json')],
      REASONS.missingTerms,
      { kind: 'missing' },
    ],
  ]

  it.each(rows)('%s', async (_name, args, reason, terms) => {
    fs.writeFileSync(file('in.json'), '{}')

    const result = await runGhWrite(args(), deps(terms === undefined ? {} : { terms }), throttle())

    expect(result.code).toBe(1)
    expect(result.stderr.toString()).toContain(reason)
    expect(result.stderr.toString()).not.toContain(TERM)
    expect(ghStarted()).toBe(false)
  })

  it.each([
    [['pr', 'view', '3']],
    [['pr', 'checks', '3', '--watch']],
    [['pr', 'list', '--state', 'open', '--search', 'is:draft', '-L', '5']],
    [['issue', 'view', '4', '--comments']],
    [['api', 'repos/o/r/pulls', '--jq', '.[].number']],
    [['run', 'list', '-L', '5']],
  ])('runs the read %j', async args => {
    const result = await runGhWrite(args, deps({ terms: { kind: 'missing' } }), throttle())

    expect(result.code).toBe(0)
    expect(fs.readFileSync(calls(), 'utf8')).toBe(`${args.join(' ')}\n`)
  })

  it('runs a clean post with -R before the group', async () => {
    const result = await runGhWrite(['-R', 'o/r', 'pr', 'comment', '1', '--body', 'ok'], deps(), throttle())

    expect(result.code).toBe(0)
    expect(fs.readFileSync(calls(), 'utf8')).toBe('-R o/r pr comment 1 --body ok\n')
  })
})

describe('gh gets the bytes gh-write scanned', () => {
  it('hands a clean body file to gh byte for byte, through a copy', async () => {
    fs.writeFileSync(file('b.md'), CLEAN)

    const result = await runGhWrite(
      ['pr', 'create', '-t', 'T', '--body-file', file('b.md')],
      deps(),
      throttle(),
    )

    expect(result.code).toBe(0)
    expect(fs.readFileSync(bodies(), 'utf8')).toBe(CLEAN)
    expect(fs.readFileSync(calls(), 'utf8')).not.toContain(file('b.md'))
  })

  it('hands stdin from --body-file - to gh byte for byte', async () => {
    const result = await runGhWrite(
      ['pr', 'comment', '12', '--body-file', '-'],
      deps({ stdin: CLEAN }),
      throttle(),
    )

    expect(result.code).toBe(0)
    expect(fs.readFileSync(bodies(), 'utf8')).toBe(CLEAN)
  })

  it('gives each of several file sources its own copy', async () => {
    fs.writeFileSync(file('a.md'), 'first\n')
    const args = ['api', 'repos/o/r/issues', '-F', `title=@${file('a.md')}`, '--input', '-']

    const result = await runGhWrite(args, deps({ stdin: 'second\n' }), throttle())

    expect(result.code).toBe(0)
    expect(fs.readFileSync(bodies(), 'utf8')).toBe('first\nsecond\n')
  })

  it('posts the scanned text when the body file changes after the scan', async () => {
    fs.writeFileSync(file('b.md'), CLEAN)
    const swapping: ThrottleDeps['runGh'] = args => {
      fs.writeFileSync(file('b.md'), `${TERM}\n`)
      return runGh(args)
    }

    const result = await runGhWrite(
      ['pr', 'create', '-t', 'T', '--body-file', file('b.md')],
      deps(),
      throttle({ runGh: swapping }),
    )

    expect(result.code).toBe(0)
    expect(fs.readFileSync(bodies(), 'utf8')).toBe(CLEAN)
  })

  it('removes its copies once gh has run', async () => {
    const result = await runGhWrite(
      ['pr', 'comment', '1', '--body-file', '-'],
      deps({ stdin: CLEAN }),
      throttle(),
    )

    const copy = /(\S*gh-write-[^/\s]*)\/source-0/.exec(fs.readFileSync(calls(), 'utf8'))?.[1]
    expect(result.code).toBe(0)
    expect(copy).toBeDefined()
    expect(fs.existsSync(copy as string)).toBe(false)
  })
})

describe('gh-write and the term list', () => {
  const merge = ['api', '-X', 'PUT', 'repos/o/r/pulls/7/merge', '--input', '-']
  const MERGE_BODY = '{"merge_method":"squash"}\n'

  it('refuses PR text while the list is missing, but lets a merge through', async () => {
    const missing = deps({ terms: { kind: 'missing' }, stdin: MERGE_BODY })

    const refused = await runGhWrite(['pr', 'create', '-t', 'x', '-b', 'y'], missing, throttle())
    expect([refused.code, refused.stderr.toString().trim()]).toEqual([1, REASONS.missingTerms])
    expect(ghStarted()).toBe(false)

    const merged = await runGhWrite(merge, missing, throttle())
    expect(merged.code).toBe(0)
    expect(ghStarted()).toBe(true)
  })

  it('refuses everything that posts text, merge included, while the list is unreadable', async () => {
    const unreadable = deps({ terms: { kind: 'unreadable' }, stdin: MERGE_BODY })

    const results = await Promise.all([
      runGhWrite(['pr', 'create', '-t', 'x', '-b', 'y'], unreadable, throttle()),
      runGhWrite(merge, unreadable, throttle()),
    ])

    expect(results.map(r => [r.code, r.stderr.toString().trim()])).toEqual([
      [1, REASONS.unreadableTerms],
      [1, REASONS.unreadableTerms],
    ])
    expect(ghStarted()).toBe(false)
  })

  it('reads the list from the passwd home whatever the environment says', async () => {
    const before = defaultTermsFile()
    fs.writeFileSync(file('terms'), `${TERM}\n`)
    fs.writeFileSync(file('empty'), '')
    const vars = [
      ...['HOME', 'NAME', 'PROFILE', 'TAGS', 'TOOLS', 'PLUGIN', 'SURFACE', 'GH_SHIM_OFF', 'GH_SHIM_DIR'].map(
        name => `AGENT_CHAT_${name}`,
      ),
      'TITAN_EGRESS_TERMS',
      'HOME',
      'XDG_CONFIG_HOME',
    ]
    const saved = vars.map(name => [name, process.env[name]] as const)
    for (const name of vars) process.env[name] = name === 'TITAN_EGRESS_TERMS' ? file('empty') : dir
    try {
      const result = await runGhWrite(['pr', 'create', '-t', TERM], scanDeps(file('terms')), throttle())

      expect(defaultTermsFile()).toBe(before)
      expect(defaultTermsFile()).toBe(path.join(os.userInfo().homedir, '.config/titan-egress/private-terms'))
      expect(result.code).toBe(1)
      expect(ghStarted()).toBe(false)
    } finally {
      for (const [name, value] of saved)
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
    }
  })
})

describe('gh-write scan parity with the PreToolUse guard', () => {
  const quote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`
  const guard = (terms: TermsLoad): GuardContext => ({
    terms,
    cwd: dir,
    env: {},
    protectedPaths: [],
    readFile: readText,
    readAlias: aliasReader({}),
    readIncludedHooksPath: includedHooksPathReader({}),
  })

  type Row = { args: string[]; stdin?: string; terms?: TermsLoad }
  const rows = (): Row[] => {
    fs.writeFileSync(file('dirty.md'), `line one\n${TERM}\n`)
    fs.writeFileSync(file('clean.md'), CLEAN)
    return [
      { args: ['pr', 'create', '--title', `Fix ${TERM}`, '--body', 'ok'] },
      { args: ['pr', 'create', '-t', 'ok', '-b', `a\nb ${TERM}`] },
      { args: ['pr', 'create', '-t', TERM, '--body-file', file('dirty.md')] },
      { args: ['pr', 'edit', '3', `--body-file=${file('clean.md')}`] },
      { args: ['pr', 'comment', '3', '-F', file('dirty.md')] },
      { args: ['pr', 'comment', '3', '--body-file', '-'], stdin: `ok\n${TERM}\n` },
      { args: ['pr', 'review', '3', '-b', 'fine'] },
      { args: ['pr', 'merge', '3', '--subject', TERM, '--body', TERM] },
      { args: ['issue', 'create', '-t', 'ok', '-F', file('clean.md')] },
      { args: ['issue', 'list', '--search', TERM] },
      {
        args: [
          'api',
          '-X',
          'POST',
          'repos/o/r/issues',
          '-f',
          `title=${TERM}`,
          '-F',
          `body=@${file('dirty.md')}`,
        ],
      },
      { args: ['api', 'repos/o/r/issues', '--input', file('clean.md')] },
      { args: ['api', 'repos/o/r/issues', '--input', '-'], stdin: TERM },
      { args: ['api', 'repos/o/r/pulls/7/merge', '-X', 'PUT'], terms: { kind: 'missing' } },
      {
        args: ['api', '-X', 'PUT', 'repos/o/r/pulls/7/merge', '--input', '-'],
        stdin: '{}',
        terms: { kind: 'missing' },
      },
      { args: ['pr', 'create', '-t', 'x', '-b', 'y'], terms: { kind: 'missing' } },
      { args: ['pr', 'create', '-t', 'x', '-b', 'y'], terms: { kind: 'unreadable' } },
      { args: ['pr', 'view', '3'], terms: { kind: 'unreadable' } },
    ]
  }

  it('reaches the same decision as checkCommand on every row', async () => {
    for (const { args, stdin, terms = LIST } of rows()) {
      const heredoc = stdin === undefined ? '' : ` <<'EOF'\n${stdin}\nEOF`
      const line = `agent-chat gh-write -- ${args.map(quote).join(' ')}${heredoc}`
      const scan = await scanGhArgs(
        args,
        deps({ terms, ...(stdin === undefined ? {} : { stdin: `${stdin}\n` }) }),
      )

      expect('reason' in scan ? scan.reason : undefined, line).toBe(checkCommand(line, guard(terms)))
    }
  })
})

describe('agent-chat gh-write from a shell', () => {
  // A merge, so each run is the same with or without a term list in this machine's real home.
  const MERGE = ['gh-write', '--', 'api', '-X', 'PUT', 'repos/o/r/pulls/7/merge', '--input', '-']
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    AGENT_CHAT_HOME: file('home'),
    ...extra,
  })

  /** The sleeping fake gh outlives a SIGTERM to gh-write; only its recorded pid is killed. */
  const killFakeGh = (): void => {
    if (!fs.existsSync(file('gh.pid'))) return
    try {
      process.kill(Number(fs.readFileSync(file('gh.pid'), 'utf8')), 'SIGKILL')
    } catch {
      // Already gone.
    }
  }

  const until = async (done: () => boolean): Promise<void> => {
    for (let waited = 0; !done(); waited += 50) {
      if (waited > 10_000) throw new Error('timed out')
      await realSleep(50)
    }
  }

  it('reads --input - from a heredoc and hands gh exactly that text', () => {
    const script = `"${process.execPath}" "${CLI}" ${MERGE.join(' ')} <<'EOF'\n{"merge_method":"squash"}\nEOF\n`

    execFileSync('/bin/sh', ['-c', script], { env: env() })

    expect(fs.readFileSync(bodies(), 'utf8')).toBe('{"merge_method":"squash"}\n')
    expect(fs.existsSync(file('home/gh-write.stamp.json'))).toBe(true)
  })

  it.each(['SIGTERM', 'SIGQUIT'] as const)('removes its copy when %s ends it while gh runs', async signal => {
    const child = spawn(process.execPath, [CLI, ...MERGE], {
      env: env({ GH_SLEEP: '30' }),
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    const exited = new Promise(resolve => child.on('exit', (_code, signal) => resolve(signal)))
    child.stdin.end('{}\n')
    try {
      await until(() => fs.existsSync(file('gh.pid')))
      const copy = /(\S*gh-write-[^/\s]*)\/source-0/.exec(fs.readFileSync(calls(), 'utf8'))?.[1] as string
      expect(fs.existsSync(copy)).toBe(true)

      child.kill(signal)

      expect(await exited).toBe(signal)
      expect(fs.existsSync(copy)).toBe(false)
    } finally {
      child.kill('SIGKILL')
      killFakeGh()
    }
  })
})
