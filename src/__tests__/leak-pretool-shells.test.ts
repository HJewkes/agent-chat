import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseTerms } from '@titan-design/egress-scan'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkCommand, readText, type GuardContext } from '../leak-guard/pretool.js'

/**
 * Runs each command through the guard and then through real shells with a fake `gh` that
 * records what it is given. The property: whenever the guard allows, no shell posts the term.
 * No real gh can run: PATH holds the fake first, and the suite aborts unless each shell finds it.
 */

// Synthetic only.
const TERM = 'zebraquark'
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-pretool-shells-')))
const BIN = path.join(ROOT, 'bin')
const WORK = path.join(ROOT, 'work')
const RECORD = path.join(ROOT, 'posted')
const ENV = {
  PATH: `${BIN}:/usr/bin:/bin`,
  HOME: path.join(ROOT, 'home'),
  TMPDIR: WORK,
  GH_HOST: 'gh.invalid',
  GH_TOKEN: 'invalid',
  GH_CONFIG_DIR: path.join(ROOT, 'home'),
  RECORD,
}

const FAKE_GH = `#!/bin/sh
# Records what gh would be given: its arguments, its stdin and every file an argument names.
{
  printf '%s\\n' "$@"
  cat
  for arg in "$@"; do
    value=\${arg#*=}
    for file in "$arg" "$value" "\${value#@}"; do
      if [ -f "$file" ]; then cat "$file"; fi
    done
  done
} >> "$RECORD"
`
const FAKE_AGENT_CHAT = `#!/bin/sh
shift
if [ "$1" = "--" ]; then shift; fi
exec gh "$@"
`

const SHELLS: [string, string[]][] = (
  [
    ['/bin/zsh', ['-f']],
    ['/bin/bash', ['--noprofile', '--norc']],
  ] satisfies [string, string[]][]
).filter(([shell]) => fs.existsSync(shell))

const inShell = (shell: string, flags: string[], command: string): string => {
  try {
    return execFileSync(shell, [...flags, '-c', command], {
      cwd: WORK,
      env: ENV,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 10_000,
    })
  } catch {
    return ''
  }
}

/** What each shell's fake gh recorded for one command. */
function posted(command: string): string[] {
  return SHELLS.map(([shell, flags]) => {
    fs.writeFileSync(RECORD, '')
    inShell(shell, flags, command)
    return fs.readFileSync(RECORD, 'utf8')
  })
}

const guard = (): GuardContext => ({
  terms: { kind: 'ok', rules: parseTerms(`${TERM}\n`) },
  cwd: WORK,
  env: ENV,
  protectedPaths: [],
  readFile: readText,
})

beforeAll(() => {
  for (const dir of [BIN, WORK, ENV.HOME, path.join(ROOT, 'evil')]) fs.mkdirSync(dir)
  fs.writeFileSync(path.join(BIN, 'gh'), FAKE_GH, { mode: 0o755 })
  fs.writeFileSync(path.join(BIN, 'agent-chat'), FAKE_AGENT_CHAT, { mode: 0o755 })
  fs.writeFileSync(path.join(ROOT, 'evil', 'pr.md'), `${TERM}\n`)
  fs.writeFileSync(path.join(WORK, 'pr.md'), 'clean file\n')
  fs.writeFileSync(path.join(WORK, 'ab.md'), 'clean file\n')
  fs.writeFileSync(path.join(WORK, 'a\x01b.md'), `${TERM}\n`)
  for (const [shell, flags] of SHELLS) {
    const found = inShell(shell, flags, 'command -v gh').trim()
    if (found !== path.join(BIN, 'gh')) throw new Error(`${shell} resolves gh to ${found}, not the fake`)
  }
})

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const EVIL = 'cat ../evil/pr.md'
const CREATE = 'gh pr create -t x -F -'
const HEREDOC = "<<'EOF'\nclean\nEOF"
const FROM_FILE = 'pr create -t x --body-file ../evil/pr.md'

const DENIED = [
  `${EVIL} | ${CREATE} ${HEREDOC}`,
  `${EVIL} | ${CREATE} <<< clean`,
  `${EVIL} | gh api -X POST repos/o/r/issues/1/comments --input - ${HEREDOC}`,
  `${EVIL} | gh api -X POST repos/o/r/issues/1/comments -F body=@- ${HEREDOC}`,
  `${EVIL} | agent-chat gh-write -- pr create -t x -F - ${HEREDOC}`,
  `${EVIL} | command ${CREATE} ${HEREDOC}`,
  `${EVIL} | { ${CREATE} ${HEREDOC}\n}`,
  `${EVIL} | (${CREATE} ${HEREDOC}\n)`,
  `${EVIL} | ${CREATE} 0${HEREDOC}`,
  `${EVIL} | ${CREATE} 3${HEREDOC}`,
  `${EVIL} | ${CREATE} 3<<< clean`,
  `${CREATE} <<EOF\nzebra\\\nquark\nEOF`,
  `gh pr create -t x -b "$(cat <<EOF\nzebra\\\nquark\nEOF\n)"`,
  `${CREATE} <<'A' <<'B'\n${TERM}\nA\ns\nB`,
  `${CREATE} <<'A' <<< s\n${TERM}\nA`,
  'gh pr create -t x --body-file a\x01b.md',
  `G=gh; $G ${FROM_FILE}`,
  `$(command -v gh) ${FROM_FILE}`,
  `C='gh ${FROM_FILE}'; eval "$C"`,
  `noglob gh ${FROM_FILE}`,
  `export TMP""DIR=$HOME/../evil; gh pr create -t x --body-file "$TMPDIR/pr.md"`,
]

// The guard may allow these; the shells show whether what it read is what gh was given.
const NESTED = [
  `${EVIL} | { true && ${CREATE} ${HEREDOC}\n}`,
  `${EVIL} | while read -r line; do ${CREATE} ${HEREDOC}\ndone`,
  `${EVIL} | if true; then ${CREATE} ${HEREDOC}\nfi`,
  `${CREATE} <<'EOF' 3<<'E2'\nclean\nEOF\n${TERM}\nE2`,
  `exec 3< ../evil/pr.md; ${CREATE} ${HEREDOC}`,
]

const ALLOWED: [string, string][] = [
  [`${CREATE} <<'EOF'\nclean body\nEOF`, 'clean body'],
  [`${CREATE} 0<<'EOF'\nclean body\nEOF`, 'clean body'],
  [`${CREATE} <<EOF\nclean body\nEOF`, 'clean body'],
  ['gh pr create -t x --body-file pr.md', 'clean file'],
  ['gh pr create -t x --body-file "$TMPDIR/pr.md"', 'clean file'],
  [`gh pr create -t x -b "$(cat <<'EOF'\nclean body\nEOF\n)"`, 'clean body'],
  ['gh api -X POST repos/{owner}/{repo}/issues/1/comments -f body=hello', 'repos/{owner}/{repo}/issues/1'],
  ['agent-chat gh-write -- pr create -t x --body-file pr.md', 'clean file'],
]

describe.skipIf(SHELLS.length === 0)('the guard against real shells and a fake gh', () => {
  it.each(DENIED)('denies %j', command => {
    expect(checkCommand(command, guard())).toBeDefined()
  })

  it.each([...DENIED, ...NESTED])('never allows %j while a shell posts the term', command => {
    const allowed = checkCommand(command, guard()) === undefined
    const leaked = posted(command).some(text => text.includes(TERM))

    expect(allowed && leaked).toBe(false)
  })

  it('sees a leak when there is one: every shell posts a pipe that a descriptor-3 heredoc does not replace', () => {
    for (const record of posted(`${EVIL} | ${CREATE} 3${HEREDOC}`)) expect(record).toContain(TERM)
  })

  it.each(ALLOWED)('allows %j and every shell posts what the guard read', (command, text) => {
    expect(checkCommand(command, guard())).toBeUndefined()
    for (const record of posted(command)) expect(record).toContain(text)
  })
})
