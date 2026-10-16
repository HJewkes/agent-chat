import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

/**
 * Text piped or fed into a shell is a script (CC-1393). Real shells with a fake `git` first on
 * PATH confirm each bypass row runs the push, and that each benign row runs no git or only what
 * the guard read.
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

const PUSH = 'git push --no-verify'

// Each row: the line, the reason the guard gives, and the mutation in src/leak-guard that the row catches.
const BYPASSES: [string, string][] = [
  // Drop the fed-text check in checkShell: every row read through the pipe allows.
  [`echo "${PUSH}" | bash`, REASONS.noVerify],
  [`echo "${PUSH}" | sh`, REASONS.noVerify],
  [`echo "${PUSH}" | sh -s`, REASONS.noVerify],
  [`echo "${PUSH}" | zsh -f`, REASONS.noVerify],
  [`printf '${PUSH}\\n' | bash`, REASONS.noVerify],
  [`echo "${PUSH}" |& bash`, REASONS.noVerify],
  [`echo "${PUSH}" | sudo -n bash`, REASONS.noVerify],
  // Make passesThrough false: cat and tee hand on unknown text, and these deny as pipedScript.
  [`echo "${PUSH}" | cat | sh`, REASONS.noVerify],
  [`echo "${PUSH}" | tee /dev/null | bash`, REASONS.noVerify],
  [`cat <<'EOF' | bash\n${PUSH}\nEOF`, REASONS.noVerify],
  // Pass the -c string `{ ...scope }` instead of `stdin: fed`: the inner shell reads nothing.
  [`echo "${PUSH}" | bash -c 'cat | bash'`, REASONS.noVerify],
  // Feed a group only its first command (feeds returns scope.stdin): bash inside the group allows.
  [`echo "${PUSH}" | { true; bash; }`, REASONS.noVerify],
  [`echo "${PUSH}" | (true; bash)`, REASONS.pipedScript],
  // Drop `prev.nested` in pipeFeed: the guard reads only `echo hi` from the subshell.
  [`(echo "${PUSH}"; echo hi) | bash`, REASONS.pipedScript],
  // Drop echo's backslash refusal: zsh's echo decodes \x79, so zsh's pipe carries --no-verify.
  [`echo 'git push --no-verif\\x79' | bash`, REASONS.pipedScript],
  [`printf '%s\\n' "${PUSH}" | bash`, REASONS.pipedScript],
  // Here-strings and heredocs, denied before CC-1393 too.
  [`bash <<< '${PUSH}'`, REASONS.noVerify],
  [`zsh -f <<< '${PUSH}'`, REASONS.noVerify],
]

// Each row's mutation: make an unknown pipe deny for every script source, or deny any pipe into a non-shell.
const BENIGN: [string, RegExp][] = [
  [`echo "${PUSH}" | grep -c push`, /^$/],
  [`echo "${PUSH}" | wc -l`, /^$/],
  [`printf '${PUSH}\\n' | tr a-z A-Z`, /^$/],
  [`echo 'git status' | bash`, /^status$/],
  [`git diff --name-only | bash -c 'while read f; do echo "$f"; done'`, /^diff --name-only$/],
  [`git log --oneline | head -3`, /^log --oneline$/],
]

describe('checkCommand on text a shell reads as a script', () => {
  it.each(BYPASSES)('denies %j', (src, reason) => {
    expect(checkCommand(src, ctx())).toBe(reason)
  })

  it.each(BENIGN)('allows %j', src => {
    expect(checkCommand(src, ctx())).toBeUndefined()
  })
})

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-pretool-piped-')))
const BIN = path.join(ROOT, 'bin')
const RECORD = path.join(ROOT, 'git-calls')
const ENV = { PATH: `${BIN}:/usr/bin:/bin`, HOME: ROOT, RECORD }

fs.mkdirSync(BIN)
fs.writeFileSync(path.join(BIN, 'git'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RECORD"\n', { mode: 0o755 })
// sudo must not prompt or escalate here: the fake runs its command as the test user.
fs.writeFileSync(path.join(BIN, 'sudo'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 })

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const SHELLS: [string, string[]][] = (
  [
    ['/bin/bash', ['--noprofile', '--norc']],
    ['/bin/zsh', ['-f']],
  ] satisfies [string, string[]][]
).filter(([shell]) => fs.existsSync(shell))
const HAS_ZSH = SHELLS.some(([shell]) => shell.endsWith('zsh'))

/** The git calls `shell -c src` made, one per line. */
function gitCalls(shell: string, args: string[], src: string): string {
  fs.rmSync(RECORD, { force: true })
  try {
    execFileSync(shell, [...args, '-c', src], { env: ENV, cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] })
  } catch {
    // A failing pipeline still counts by what it ran.
  }
  return fs.existsSync(RECORD) ? fs.readFileSync(RECORD, 'utf8').trim() : ''
}

const needsZsh = (src: string): boolean => src.includes('zsh') || src.includes('\\x79')

describe.skipIf(SHELLS.length === 0)('real shells run what the guard reads from a pipe', () => {
  it('finds the fake git first on PATH', () => {
    expect(execFileSync('/bin/sh', ['-c', 'command -v git'], { env: ENV }).toString().trim()).toBe(
      path.join(BIN, 'git'),
    )
  })

  it.each(BYPASSES.filter(([src]) => HAS_ZSH || !needsZsh(src)))('a shell pushes for %j', src => {
    const pushed = SHELLS.filter(([shell, args]) => gitCalls(shell, args, src) === 'push --no-verify')

    expect(pushed.length).toBeGreaterThan(0)
  })

  it.each(BENIGN)('every shell runs only what the guard read for %j', (src, calls) => {
    for (const [shell, args] of SHELLS) expect(gitCalls(shell, args, src)).toMatch(calls)
  })
})
