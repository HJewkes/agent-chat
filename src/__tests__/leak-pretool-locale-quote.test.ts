import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

/**
 * bash reads `$"…"` (locale translation) as a double-quoted string, so `git push $"--no-verify"` runs
 * `git push --no-verify` (CC-1430). zsh reads a literal `$` and then the string. The guard reads the
 * bash form. Real shells with a fake `git` first on PATH confirm what each line runs.
 */

const ctx = (): GuardContext => ({
  terms: { kind: 'ok', rules: [] },
  cwd: '/work',
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
})

// On main every row here was allowed. Dropping the `$"` case from wordPart allows them again.
// Each line with what bash 5.3 passes git.
const DENIED: [string, string][] = [
  ['git push $"--no-verify" origin HEAD:main', 'push --no-verify origin HEAD:main'],
  ['git push $"--no-verif"{y,} origin HEAD:main', 'push --no-verify --no-verif origin HEAD:main'],
  ['git push {,}$"--no-verify" origin HEAD:main', 'push --no-verify --no-verify origin HEAD:main'],
  ['git push {x,$"--no-verify"} origin HEAD:main', 'push x --no-verify origin HEAD:main'],
  ['git push $"--no-""verify" origin HEAD:main', 'push --no-verify origin HEAD:main'],
  ['git push --no-$"veri"fy origin HEAD:main', 'push --no-verify origin HEAD:main'],
  ['git push --no-verif$"y" origin HEAD:main', 'push --no-verify origin HEAD:main'],
  ['git push $"--no-verify"$"" origin HEAD:main', 'push --no-verify origin HEAD:main'],
  ['bash -c \'git push $"--no-verify" origin HEAD:main\'', 'push --no-verify origin HEAD:main'],
]

// bash reads the delimiter `$"E"` as E and zsh as $E, so the shells end the body at different lines and each
// runs the git line the other keeps as text. Each line with the git calls bash 5.3 and zsh 5.9 make.
const PUSH = 'push --no-verify origin HEAD:main'
const HEREDOCS: [string, string[], string[]][] = [
  ['cat <<$"E"\n$E\ngit push --no-verify origin HEAD:main\nE', [], [PUSH]],
  ['cat <<$"E"\nE\ngit push --no-verify origin HEAD:main\n$E', [PUSH], []],
  ['cat <<-$"E"\n$E\ngit push --no-verify origin HEAD:main\nE', [], [PUSH]],
  ['cat <<-$"E"\nE\ngit push --no-verify origin HEAD:main\n$E', [PUSH], []],
  ['cat <<$"E"x\n$Ex\ngit push --no-verify origin HEAD:main\nEx', [], [PUSH]],
  ['cat <<$"E"x\nEx\ngit push --no-verify origin HEAD:main\n$Ex', [PUSH], []],
]

// n heredocs whose ends differ, then the one that hides a push from bash: the fork budget (64) must not run out open.
const chain = (n: number): string =>
  `${'cat <<$"E"\n$E\nE\n'.repeat(n)}cat <<$"E"\n$E\ngit push --no-verify origin HEAD:main\nE`
const CHAINS = [63, 64, 65, 130].map(n => chain(n))

// A `$"E"` delimiter is quoted in both shells, so neither runs a substitution in the body (a loosening against main).
const QUOTED_BODY = [
  'cat <<$"E"\n$(git push --no-verify origin HEAD:main)\nE',
  'cat <<$"E"\n`git push --no-verify origin HEAD:main`\nE',
]

const HEREDOCS_ALLOWED = [
  'cat <<EOF\nhi\nEOF',
  'cat <<"EOF"\nhi\nEOF',
  "cat <<'EOF'\nhi\nEOF",
  'git commit -F - <<EOF\nmsg\nEOF',
  'cat <<-EOF\nhi\nEOF',
  'cat <<$"EOF"\nhi\nEOF',
]

const ALLOWED: [string, string][] = [
  ['echo $"hello"', ''],
  ['git commit -m $"msg"', 'commit -m msg'],
  ['printf $"%s\\n" x', ''],
  ['git log --format=$"%H"', 'log --format=%H'],
  ['git push origin HEAD:feat/x', 'push origin HEAD:feat/x'],
  // `$"` inside quotes is text and changes nothing.
  ['git commit -m "$"--no-verify', 'commit -m $--no-verify'],
  ['git commit -m \'$"--no-verify"\'', 'commit -m $"--no-verify"'],
  ['git commit -m "cost $\\"--no-verify\\""', 'commit -m cost $"--no-verify"'],
]

describe('checkCommand on bash locale quoting (CC-1430)', () => {
  it.each(DENIED.map(([src]) => src))('denies %j', src => {
    expect(checkCommand(src, ctx())).toBe(REASONS.noVerify)
  })

  it.each(HEREDOCS.map(([src]) => src))('denies the heredoc %j', src => {
    expect(checkCommand(src, ctx())).toBe(REASONS.noVerify)
  })

  it.each(CHAINS)('denies a chain of heredocs ending in a hidden push (%#)', src => {
    expect(checkCommand(src, ctx())).toBeDefined()
  })

  it('allows 130 heredocs that hold no locale quote', () => {
    expect(checkCommand('cat <<"E"\nx\nE\n'.repeat(130), ctx())).toBeUndefined()
  })

  it('denies an unreadable line in the region only zsh runs', () => {
    expect(checkCommand('cat <<$"E"\n$E\necho a(b c)\nE\ngit status', ctx())).toBeDefined()
  })

  it.each(QUOTED_BODY)('allows the quoted-delimiter body %j', src => {
    expect(checkCommand(src, ctx())).toBeUndefined()
  })

  it.each(HEREDOCS_ALLOWED)('allows the heredoc %j', src => {
    expect(checkCommand(src, ctx())).toBeUndefined()
  })

  it.each(ALLOWED.map(([src]) => src))('allows %j', src => {
    expect(checkCommand(src, ctx())).toBeUndefined()
  })
})

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-pretool-locale-')))
const BIN = path.join(ROOT, 'bin')
const RECORD = path.join(ROOT, 'git-calls')
const ENV = { PATH: `${BIN}:/usr/bin:/bin`, HOME: ROOT, RECORD }

fs.mkdirSync(BIN)
fs.writeFileSync(path.join(BIN, 'git'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RECORD"\n', { mode: 0o755 })

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : undefined
const ZSH = fs.existsSync('/bin/zsh') ? '/bin/zsh' : undefined

/** The argument lines `shell -c src` passed the fake git. */
function gitCalls(shell: string, args: string[], src: string): string[] {
  fs.rmSync(RECORD, { force: true })
  // A heredoc line the shell runs as a command, such as `E`, exits non-zero.
  try {
    execFileSync(shell, [...args, '-c', src], { env: ENV, cwd: ROOT, stdio: 'ignore' })
  } catch {
    // only the calls the fake git recorded matter
  }
  return fs.existsSync(RECORD) ? fs.readFileSync(RECORD, 'utf8').trim().split('\n') : []
}

describe.skipIf(BASH === undefined)('bash runs $"…" as a double-quoted string (CC-1430)', () => {
  const bash = (src: string): string[] => gitCalls(BASH as string, ['--noprofile', '--norc'], src)

  it.each(DENIED.filter(([src]) => !src.startsWith('bash -c')))('runs %j as git %j', (src, call) => {
    expect(bash(src)).toEqual([call])
  })

  it.each(ALLOWED.filter(([src]) => src.startsWith('git ')))('runs %j as git %j', (src, call) => {
    expect(bash(src)).toEqual([call])
  })

  it.each(HEREDOCS)('runs %j as git calls %j', (src, calls) => {
    expect(bash(src)).toEqual(calls)
  })

  it.each(CHAINS)('runs a chain of heredocs (%#) without the push', src => {
    expect(bash(src)).toEqual([])
  })

  it.each(QUOTED_BODY)('runs %j without a git call', src => {
    expect(bash(src)).toEqual([])
  })
})

describe.skipIf(ZSH === undefined)('zsh reads $"…" as a literal $ and a string (CC-1430)', () => {
  it('passes git $--no-verify, which is no option', () => {
    expect(gitCalls(ZSH as string, ['-f'], 'git push $"--no-verify" origin HEAD:main')).toEqual([
      'push $--no-verify origin HEAD:main',
    ])
  })

  it.each(HEREDOCS)('runs %j as git calls %j', (src, _bash, calls) => {
    expect(gitCalls(ZSH as string, ['-f'], src)).toEqual(calls)
  })

  it.each(CHAINS)('runs a chain of heredocs (%#) ending in the push', src => {
    expect(gitCalls(ZSH as string, ['-f'], src)).toEqual([PUSH])
  })

  it.each(QUOTED_BODY)('runs %j without a git call', src => {
    expect(gitCalls(ZSH as string, ['-f'], src)).toEqual([])
  })
})
