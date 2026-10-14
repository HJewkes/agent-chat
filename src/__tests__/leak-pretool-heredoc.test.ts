import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseTerms } from '@titan-design/egress-scan'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

/**
 * The guard denies a push hidden in an unquoted heredoc body (CC-1341), and real shells with a fake
 * `git` first on PATH confirm the property: whenever the guard allows, no shell ran git.
 */

const ctx = (): GuardContext => ({
  terms: { kind: 'ok', rules: parseTerms('zq7privateseat\n') },
  cwd: '/work',
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
})

const PUSH = 'git push --no-verify'

const LIVE = [
  `cat <<E\n$(${PUSH})\nE`,
  `cat <<E\n\`${PUSH}\`\nE`,
  `cat <<E\n\${ ${PUSH};}\nE`,
  `cat <<E\n\${|${PUSH};}\nE`,
  `cat <<-E\n\t$(${PUSH})\n\tE`,
  `cat 3<<E\n$(${PUSH})\nE`,
  `<<E\n$(${PUSH})\nE`,
  `cat <<E\n$(git pu\\\nsh --no-verify)\nE`,
  `cat <<E\n\\\\$(${PUSH})\nE`,
]

const LITERAL = [
  `cat <<'E'\n$(${PUSH})\nE`,
  `cat <<"E"\n$(${PUSH})\nE`,
  `cat <<\\E\n$(${PUSH})\nE`,
  `cat <<E''\n$(${PUSH})\nE`,
  `cat <<E\n\\$(${PUSH})\nE`,
  `cat <<E\n\\\`${PUSH}\\\`\nE`,
  'cat <<E\n$(date)\nE',
  'cat <<E\nhello $HOME\nE',
]

// bash joins a body line ending in a backslash before it compares the delimiter; see the plan's risks.
const JOINED_DELIMITER = `cat <<E\nx\\\nE\n$(${PUSH})\nE`
const DEFAULT_VALUE = `cat <<E\n\${X:-$(${PUSH})}\nE`

describe('checkCommand on unquoted heredoc bodies', () => {
  it.each(LIVE)('denies %j', src => {
    expect(checkCommand(src, ctx())).toBe(REASONS.noVerify)
  })

  it('denies a push inside a default-value expansion in the body', () => {
    expect(checkCommand(DEFAULT_VALUE, ctx())).toBeDefined()
  })

  it.each(LITERAL)('allows %j', src => {
    expect(checkCommand(src, ctx())).toBeUndefined()
  })
})

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-pretool-heredoc-')))
const BIN = path.join(ROOT, 'bin')
const RECORD = path.join(ROOT, 'git-calls')
const ENV = { PATH: `${BIN}:/usr/bin:/bin`, HOME: ROOT, RECORD }

fs.mkdirSync(BIN)
fs.writeFileSync(path.join(BIN, 'git'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RECORD"\n', { mode: 0o755 })

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const SHELLS: [string, string[]][] = (
  [
    ['/bin/bash', ['--noprofile', '--norc']],
    ['/bin/zsh', ['-f']],
  ] satisfies [string, string[]][]
).filter(([shell]) => fs.existsSync(shell))

const bashVersion = (): [number, number] => {
  try {
    const v = execFileSync('/bin/bash', ['-c', 'echo ${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}'], {
      encoding: 'utf8',
    })
    const [major = 0, minor = 0] = v.trim().split(' ').map(Number)
    return [major, minor]
  } catch {
    return [0, 0]
  }
}
const [major, minor] = bashVersion()
const bashRunsFunsub = major > 5 || (major === 5 && minor >= 3)
// bash before 5.3 has no funsubs, so it prints those bodies as text.
const BASH_LIVE = LIVE.filter(src => bashRunsFunsub || !src.includes('${'))

/** Whether `shell` ran the fake git for `src`, fed on stdin as a script. */
function runsGit(shell: string, args: string[], src: string): boolean {
  fs.rmSync(RECORD, { force: true })
  try {
    execFileSync(shell, args, { input: `${src}\n`, env: ENV, cwd: ROOT, stdio: ['pipe', 'ignore', 'ignore'] })
  } catch {
    // A shell that rejects the line, as zsh does a funsub, still counts by what it ran.
  }
  return fs.existsSync(RECORD)
}

describe('real shells agree with the guard on heredoc bodies', () => {
  it('finds the fake git first on PATH', () => {
    expect(execFileSync('/bin/sh', ['-c', 'command -v git'], { env: ENV }).toString().trim()).toBe(
      path.join(BIN, 'git'),
    )
  })

  it.each(BASH_LIVE)('bash runs the push in %j', src => {
    expect(runsGit('/bin/bash', ['--noprofile', '--norc'], src)).toBe(true)
  })

  it.each([...LIVE, ...LITERAL, DEFAULT_VALUE, JOINED_DELIMITER])(
    'no shell runs git where the guard allows %j',
    src => {
      const allowed = checkCommand(src, ctx()) === undefined
      const ran = SHELLS.filter(([shell, args]) => runsGit(shell, args, src)).map(([shell]) => shell)

      expect(allowed && ran.length > 0 ? ran : []).toEqual([])
    },
  )

  it.each(LITERAL)('no shell runs git for %j', src => {
    expect(SHELLS.filter(([shell, args]) => runsGit(shell, args, src))).toEqual([])
  })
})
