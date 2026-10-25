import { execFileSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import { fakeGitShells } from './helpers/fake-git-shells.js'

/**
 * busybox runs the applet its first word names, by basename, and Alpine's /bin/ash is busybox's
 * shell (CC-1342). Its shells, env, timeout and xargs are checked as the command they run, so a push
 * behind them denies as the push itself does. Real busybox with a fake `git` first on PATH confirms
 * each deny row runs the push, where busybox is installed.
 */

const ctx: GuardContext = {
  terms: { kind: 'ok', rules: [] },
  cwd: '/work',
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
}

const P = 'git push --no-verify origin HEAD:main'
const PUSHED = 'push --no-verify origin HEAD:main'

const BUSYBOX_BYPASSES = [
  `busybox sh -c '${P}'`,
  `busybox ash -c '${P}'`,
  `busybox /bin/sh -c '${P}'`,
  `busybox ./sh -c '${P}'`,
  `env busybox sh -c '${P}'`,
  `nohup busybox sh -c '${P}'`,
  `busybox sh <<'EOF'\n${P}\nEOF`,
  `echo '${P}' | busybox ash`,
  `busybox env ${P}`,
  `busybox env -u X A=1 ${P}`,
  `busybox timeout 5 ${P}`,
  `busybox timeout -s KILL 5 ${P}`,
  `busybox xargs ${P} </dev/null`,
  // Options after -c come before the string it runs.
  `busybox sh -c -e '${P}'`,
  `busybox sh -c -x '${P}'`,
  `busybox sh -c -- '${P}'`,
  `busybox ash -oc errexit '${P}'`,
]

// The same option orders under a plain shell, which runs the string after them too.
const SHELL_BYPASSES = [
  `sh -c -e '${P}'`,
  `sh -c -- '${P}'`,
  `bash -oc pipefail '${P}'`,
  `dash -ec -- '${P}'`,
]

const runsBusybox = (() => {
  try {
    execFileSync('busybox', ['true'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe('a busybox applet is checked as the command it runs (CC-1342)', () => {
  it.each([
    ...BUSYBOX_BYPASSES,
    ...SHELL_BYPASSES,
    `/usr/bin/busybox sh -c '${P}'`,
    `ash -c '${P}'`,
    `/bin/ash -c '${P}'`,
  ])('denies %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.noVerify)
  })

  it.each([
    `busybox hush -c '${P}'`,
    `busybox watch ${P}`,
    `S=sh; busybox $S -c '${P}'`,
    'busybox SH -c "git push"',
  ])('fails closed on an applet it does not read: %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.jobOption)
  })

  it.each([
    'busybox --list',
    'busybox ls -la',
    `busybox sh -c 'echo hi'`,
    `busybox sh -c 'git status'`,
    'busybox env git status',
    'busybox timeout 5 git fetch',
    `ash -c 'echo hi'`,
  ])('allows %s', line => {
    expect(checkCommand(line, ctx)).toBeUndefined()
  })
})

// ksh has no observed grammar, so the guard reads none of its words and denies it on every line (CC-1631).
describe('a shell without an observed grammar denies (CC-1342)', () => {
  it.each([
    `ksh -T - -c '${P}'`,
    `ksh -T /dev/tty2 -c '${P}'`,
    `ksh -c 'git status'`,
    `ksh -T - -c 'echo hi'`,
    'ksh script.ksh',
  ])('denies %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.foreignShell)
  })
})

const real = fakeGitShells('agent-chat-busybox-', P)
afterAll(real.cleanup)
const SH = real.shells.find(([shell]) => shell.endsWith('bash'))

describe.skipIf(!runsBusybox || SH === undefined)('real busybox runs the push behind each applet', () => {
  it.each([...BUSYBOX_BYPASSES, ...SHELL_BYPASSES])('%s pushes', line => {
    const [shell, args] = SH as [string, string[]]
    expect(real.gitCalls(shell, args, line)).toBe(PUSHED)
  })
})
