import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import { fakeGitShells } from './helpers/fake-git-shells.js'

/**
 * setsid, flock, taskset, chrt, script and unshare run the command they are given (CC-1414).
 * Real bash with a fake `git` first on PATH confirms each deny row runs the push.
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
const F = 'f.lock'

// Each row: the line, and the wrapper bash needs installed to run it.
const BYPASSES: [string, string][] = [
  [`setsid ${P}`, 'setsid'],
  [`setsid -w ${P}`, 'setsid'],
  [`setsid --wait ${P}`, 'setsid'],
  [`/usr/bin/setsid -w ${P}`, 'setsid'],
  [`flock ${F} ${P}`, 'flock'],
  [`flock -n ${F} ${P}`, 'flock'],
  [`flock -w 5 ${F} ${P}`, 'flock'],
  [`flock --timeout=5 -x ${F} ${P}`, 'flock'],
  [`flock -E 3 ${F} ${P}`, 'flock'],
  [`flock -- ${F} ${P}`, 'flock'],
  [`flock ${F} -c '${P}'`, 'flock'],
  [`taskset 1 ${P}`, 'taskset'],
  [`taskset -c 0 ${P}`, 'taskset'],
  [`taskset --cpu-list 0 ${P}`, 'taskset'],
  [`taskset -ac 0 ${P}`, 'taskset'],
  [`chrt -o 0 ${P}`, 'chrt'],
  [`chrt --other 0 ${P}`, 'chrt'],
  [`chrt -b -v 0 ${P}`, 'chrt'],
  [`chrt -o +0 ${P}`, 'chrt'],
  [`chrt -o ' 0' ${P}`, 'chrt'],
  [`script -qc '${P}' /dev/null`, 'script'],
  [`script -q -c '${P}' /dev/null`, 'script'],
  [`script /dev/null -qc '${P}'`, 'script'],
  [`script --command='${P}' -q /dev/null`, 'script'],
  [`script -q -E never -c '${P}' /dev/null`, 'script'],
  [`unshare ${P}`, 'unshare'],
  [`setsid bash -c '${P}'`, 'setsid'],
  [`flock ${F} bash -c '${P}'`, 'flock'],
  [`taskset 1 sh -c '${P}'`, 'taskset'],
  [`setsid flock ${F} taskset 1 chrt -o 0 ${P}`, 'chrt'],
  [`echo '${P}' | setsid bash`, 'setsid'],
  [`echo '${P}' | flock ${F} bash`, 'flock'],
  [`echo '${P}' | taskset 1 bash`, 'taskset'],
  [`echo '${P}' | chrt -o 0 bash`, 'chrt'],
  [`echo '${P}' | flock ${F} -c bash`, 'flock'],
  [`echo '${P}' | script -qc bash /dev/null`, 'script'],
  // util-linux reads -p's pid from the last word, and pid 0 is the wrapper itself, which then runs the rest.
  [`taskset -p 1 bash -c '${P}' 0`, 'taskset'],
  [`taskset --pid 1 bash -c '${P}' 0`, 'taskset'],
  [`taskset -p 1 bash -c '${P}' 00`, 'taskset'],
  [`taskset -p 1 bash -c '${P}' +0`, 'taskset'],
  [`chrt -o -p 0 sh -c '${P}' 0`, 'chrt'],
  [`F=${F}; flock "$F" -c '${P}'`, 'flock'],
  [`flock "$HOME/${F}" -c '${P}'`, 'flock'],
  [`flock ~/${F} -c '${P}'`, 'flock'],
  [`F=${F}; flock $F --command '${P}'`, 'flock'],
  [`F=${F}; flock "\${F}" -c '${P}'`, 'flock'],
  [`flock "$PWD/${F}" -c '${P}'`, 'flock'],
]

const PY = `import os;os.system("${P}")`
// Words the shell expands where the wrapper may read an option or value, and a $SHELL that is no shell.
const UNREAD: [string, string, RegExp][] = [
  [`X=-c; script -q "$X" '${P}' /dev/null`, 'script', /option this guard does not know/],
  [`X=-c; script -q $X '${P}' /dev/null`, 'script', /option this guard does not know/],
  [
    `T='5 ${F} git'; flock -w $T push --no-verify origin HEAD:main`,
    'flock',
    /option this guard does not know/,
  ],
  [
    `T='5 ${F} git'; flock --timeout $T push --no-verify origin HEAD:main`,
    'flock',
    /option this guard does not know/,
  ],
  [`SHELL=/usr/bin/python3 script -qc '${PY}' /dev/null`, 'script', /\$SHELL names/],
  [`echo '${PY}' | SHELL=/usr/bin/python3 script -q /dev/null`, 'script', /\$SHELL names/],
  [`echo '${PY}' | SHELL=/usr/bin/python3 unshare`, 'unshare', /\$SHELL names/],
  [`export S''HELL=/usr/bin/python3; script -qc '${PY}' /dev/null`, 'script', /\$SHELL names/],
  [`env S''HELL=/usr/bin/python3 script -qc '${PY}' /dev/null`, 'script', /\$SHELL names/],
  // s.sh exports SHELL=/usr/bin/python3; the guard cannot read what a sourced file sets.
  [`. ./s.sh; script -qc '${PY}' /dev/null`, 'script', /\$SHELL names/],
  [`X='${P}'; flock ${F} -c "$X"`, 'flock', /option this guard does not know/],
]

// Rows real bash cannot run on every host: a forked child, a controlling tty, and a user namespace.
const UNCONFIRMED = [
  `setsid -c ${P}`,
  `setsid -f ${P}`,
  `setsid --fork ${P}`,
  `unshare -r ${P}`,
  `unshare --user --map-root-user ${P}`,
  `unshare -r -w /tmp ${P}`,
  `unshare --mount=/x -f ${P}`,
  `echo '${P}' | unshare -r`,
]

describe('job and namespace wrappers run the command after their options (CC-1414)', () => {
  it.each([...BYPASSES.map(([line]) => line), ...UNCONFIRMED])('denies %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.noVerify)
  })

  it.each(UNREAD)('denies %s, which it cannot read', (line, _, reason) => {
    expect(checkCommand(line, ctx)).toMatch(reason)
  })

  it('denies script when the hook runs a $SHELL that is no shell it reads', () => {
    expect(
      checkCommand(`script -qc 'git status' /dev/null`, { ...ctx, env: { SHELL: '/usr/bin/fish' } }),
    ).toBe(REASONS.jobShell)
  })

  it.each([
    'setsid --frob git push',
    `flock --bogus ${F} git push`,
    'taskset -z 1 git status',
    'chrt -x 0 git status',
    `script -Z -c 'git push' /dev/null`,
    'unshare --nope git status',
    'setsid -f"$O" git push',
    'chrt --ver"$X" 0 git push',
  ])('fails closed on an option it does not know, on a line that may reach git: %s', line => {
    expect(checkCommand(line, ctx)).toMatch(/option this guard does not know/)
  })

  it.each([
    'setsid sleep 1',
    `flock ${F} echo hi`,
    'taskset 1 ls',
    `script -qc 'echo hi' /dev/null`,
    'chrt -o 0 make',
    'unshare -r id',
    'setsid --frob make',
    'taskset -p 1 1234',
    `flock ${F} -c 'git status'`,
    'setsid -w git push origin HEAD:feature',
    `script -qc 'git status' /dev/null`,
  ])('allows %s', line => {
    expect(checkCommand(line, ctx)).toBeUndefined()
  })

  it.each([`ionice -c3 ${P}`, `env -- ${P}`, `nice -n 5 ${P}`])('still denies the control %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.noVerify)
  })
})

const real = fakeGitShells('agent-chat-job-wrappers-', P)
afterAll(real.cleanup)
fs.writeFileSync(path.join(real.root, 's.sh'), 'export SHELL=/usr/bin/python3\n')
const BASH = real.shells.find(([shell]) => shell.endsWith('bash'))
const installed = (name: string): boolean => {
  try {
    execFileSync('/bin/sh', ['-c', `command -v ${name}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
// A forked setsid child may log after bash exits, so the line waits for it.
const settled = (line: string): string =>
  `${line}; i=0; while [ ! -s git-calls ] && [ $i -lt 30 ]; do sleep 0.1; i=$((i+1)); done`
const pushes = (line: string): string =>
  BASH === undefined ? '' : real.gitCalls(BASH[0], BASH[1], settled(line))
const PUSHED = 'push --no-verify origin HEAD:main'
// Many hosts and CI runners refuse an unprivileged user namespace; then the unshare -r premise is unconfirmed.
const userNamespaces = installed('unshare') && pushes('unshare -r git ns') === 'ns'

describe.skipIf(BASH === undefined)('real bash runs the push behind each wrapper', () => {
  it.each(BYPASSES.filter(([, wrapper]) => installed(wrapper)))('%s pushes', line => {
    expect(pushes(line)).toBe(PUSHED)
  })

  it.each(
    UNREAD.filter(
      ([line, wrapper]) => installed(wrapper) && (!line.includes('python3') || installed('python3')),
    ),
  )('%s pushes', line => {
    expect(pushes(line)).toBe(PUSHED)
  })

  it.skipIf(!installed('setsid'))('setsid -f pushes from its forked child', () => {
    expect(pushes(`setsid -f ${P}`)).toBe(PUSHED)
  })

  it.skipIf(!userNamespaces)('unshare -r pushes inside a user namespace', () => {
    expect(pushes(`unshare -r ${P}`)).toBe(PUSHED)
  })
})
