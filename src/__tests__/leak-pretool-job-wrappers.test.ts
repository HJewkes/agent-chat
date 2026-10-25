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
  [`flock ~/${F} -c '${P}'`, 'flock'],
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
  // An operand the shell expands may be no word or several, so the command may start after it.
  [`flock ~/${F} ${P}`, 'flock', /option this guard does not know/],
  [`flock "$HOME/${F}" bash -c '${P}'`, 'flock', /option this guard does not know/],
  [`flock "$HOME/${F}" ${P}`, 'flock', /option this guard does not know/],
  [`flock /tmp/$USER.lock ${P}`, 'flock', /option this guard does not know/],
  [`flock ~/${F} bash -c '${P}'`, 'flock', /option this guard does not know/],
  [`echo '${P}' | flock ~/${F} bash`, 'flock', /option this guard does not know/],
  [`F=${F}; flock $F --command '${P}'`, 'flock', /option this guard does not know/],
  // A quoted lock file may expand to an option or `--`, and the word after it to -c.
  [`F=${F}; flock "$F" -c '${P}'`, 'flock', /option this guard does not know/],
  [`flock "$HOME/${F}" -c '${P}'`, 'flock', /option this guard does not know/],
  [`F=${F}; flock "\${F}" -c '${P}'`, 'flock', /option this guard does not know/],
  [`flock "$PWD/${F}" -c '${P}'`, 'flock', /option this guard does not know/],
  [`X=--; flock "$X" -c ${P}`, 'flock', /option this guard does not know/],
  [`X=-c; flock ${F} "$X" '${P}'`, 'flock', /option this guard does not know/],
  [`X=--command; flock ${F} $X '${P}'`, 'flock', /option this guard does not know/],
  // The word after -- places the command as much as any word before it.
  [`X='bash -c'; setsid -- $X '${P}'`, 'setsid', /option this guard does not know/],
  [`X='bash -c'; unshare -- $X '${P}'`, 'unshare', /option this guard does not know/],
]

// An unquoted operand splits, so flock sees no -c where it is written and runs the operand's words: line, git's argv.
const SPLIT_OPERAND: [string, string][] = [
  [
    `F='lock git'; flock $F -c core.hooksPath=/dev/null push origin HEAD:main`,
    '-c core.hooksPath=/dev/null push origin HEAD:main',
  ],
  [
    `F='lock git push --no-verify -o'; flock $F -c origin HEAD:main`,
    'push --no-verify -o -c origin HEAD:main',
  ],
  [
    `F='lock git push --no-verify -o'; flock $F --command origin HEAD:main`,
    'push --no-verify -o --command origin HEAD:main',
  ],
  [
    `F='lock git'; flock -- $F -c core.hooksPath=/dev/null push origin HEAD:main`,
    '-c core.hooksPath=/dev/null push origin HEAD:main',
  ],
  [
    `F='lock git push --no-verify -o'; flock -- $F -c origin HEAD:main`,
    'push --no-verify -o -c origin HEAD:main',
  ],
  [
    `F='lock git'; flock -x -- $F -c core.hooksPath=/dev/null push origin HEAD:main`,
    '-c core.hooksPath=/dev/null push origin HEAD:main',
  ],
  [
    `A=(lock git); flock -- "\${A[@]}" -c core.hooksPath=/dev/null push origin HEAD:main`,
    '-c core.hooksPath=/dev/null push origin HEAD:main',
  ],
  [
    `flock -- $(echo lock git) -c core.hooksPath=/dev/null push origin HEAD:main`,
    '-c core.hooksPath=/dev/null push origin HEAD:main',
  ],
  [
    `flock -- {lock,git} -c core.hooksPath=/dev/null push origin HEAD:main`,
    '-c core.hooksPath=/dev/null push origin HEAD:main',
  ],
  [
    `F='lock git'; flock -- $F --command core.hooksPath=/dev/null push origin HEAD:main`,
    '--command core.hooksPath=/dev/null push origin HEAD:main',
  ],
]

// util-linux 2.41's chrt, unlike taskset and flock, skips one -- after the priority; 2.39's runs a command named --.
const CHRT_DASHES = [`chrt -o 0 -- ${P}`, `chrt -o 0 -- bash -c '${P}'`]

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
  it.each([...BYPASSES.map(([line]) => line), ...CHRT_DASHES, ...UNCONFIRMED])('denies %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.noVerify)
  })

  it.each(UNREAD)('denies %s, which it cannot read', (line, _, reason) => {
    expect(checkCommand(line, ctx)).toMatch(reason)
  })

  it.each(SPLIT_OPERAND)('denies %s, whose operand may split', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.jobOption)
  })

  it.each([`script -qc 'git status' /dev/null`, `script -qc 'echo hi' /dev/null`])(
    'denies %s when the hook runs a $SHELL that is no shell it reads (CC-1631)',
    line => {
      expect(checkCommand(line, { ...ctx, env: { SHELL: '/usr/bin/fish' } })).toBe(REASONS.foreignShell)
    },
  )

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

  // Real bash cannot push with these: $TMPDIR is unset, a path is no CPU mask or priority, gh is not faked,
  // with a split lock file real git refuses the --command it is handed, and flock runs no "$X"'P' or empty word.
  it.each([
    `F='lock git'; flock $F --command core.hooksPath=/dev/null push origin HEAD:main`,
    `F='l git'; flock $F --command=x push origin HEAD:main`,
    `X=--command=; flock ${F} "$X"'${P}'`,
    `flock ${F} "$X" '${P}'`,
    `flock "$TMPDIR/x" ${P}`,
    `flock ~/${F} gh pr create --body x`,
    `taskset "$HOME" ${P}`,
    `chrt -o "$HOME" ${P}`,
  ])('fails closed on an expanded operand, on a line that may reach git or gh: %s', line => {
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
    `flock ~/${F} make`,
    `flock "$HOME/${F}" make`,
    'flock /tmp/l make',
    'taskset -c 0 make',
    'taskset -p 1234',
    'chrt -p 1234',
    `flock /tmp/l -c 'echo hi'`,
    `flock "$HOME/l" -c 'echo hi'`,
    'script -qc ls /dev/null',
    'flock /tmp/l git status',
    'taskset -c 0 git status',
    'flock -n /tmp/x.lock git pull --ff-only',
    'chrt -i 0 git gc',
    'setsid -f npm run dev',
    // Real taskset and flock exec a command named --, and chrt skips only one, so none of these runs git.
    `taskset 1 -- ${P}`,
    `flock ${F} -- ${P}`,
    `chrt -o 0 -- -- ${P}`,
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

const PUSHED = 'push --no-verify origin HEAD:main'
// An option value or timeout duration the shell may split moves the command word (CC-1421): line, wrapper.
const SPLIT_VALUE: [string, string][] = [
  [`N='5 git'; nice -n $N ${PUSHED}`, 'nice'],
  [`N='5 git'; nice --adjustment $N ${PUSHED}`, 'nice'],
  [`C='3 git'; ionice -c $C ${PUSHED}`, 'ionice'],
  [`C='3 git'; ionice -c3 -n $C ${PUSHED}`, 'ionice'],
  [`C='3 git'; ionice --class $C ${PUSHED}`, 'ionice'],
  [`T='5 git'; timeout $T ${PUSHED}`, 'timeout'],
  [`K='1 5 git'; timeout -k $K ${PUSHED}`, 'timeout'],
  [`S='TERM 5 git'; timeout -s $S ${PUSHED}`, 'timeout'],
  [`nice -n {5,git} ${PUSHED}`, 'nice'],
  [`timeout {5,git} ${PUSHED}`, 'timeout'],
  [`ionice -c {3,git} ${PUSHED}`, 'ionice'],
  [`nice -n $EMPTY 5 ${P}`, 'nice'],
  [`timeout $EMPTY 5 ${P}`, 'timeout'],
  [`nice -n $(echo 5 git) ${PUSHED}`, 'nice'],
  [`timeout $(echo 5 git) ${PUSHED}`, 'timeout'],
  [`A=(5 git); nice -n "\${A[@]}" ${PUSHED}`, 'nice'],
  [`A=(5 git); timeout "\${A[@]}" ${PUSHED}`, 'timeout'],
  [`M='L git'; stdbuf -o $M ${PUSHED}`, 'stdbuf'],
  [`M='L git'; stdbuf --output $M ${PUSHED}`, 'stdbuf'],
  [`N='x git'; exec -a $N ${PUSHED}`, 'exec'],
  // An option word the shell expands may become an option that takes a value.
  [`N='5 git'; nice -$N ${PUSHED}`, 'nice'],
  [`X=n; nice "-$X" 5 ${P}`, 'nice'],
  // A quoted duration stays one word, but it may be an option that takes the next word as its value.
  [`T=-k; timeout "$T" 1 5 ${P}`, 'timeout'],
]

// Long options and glued values that take a value, which nice and timeout read as getopt_long does.
const LONG_VALUE: [string, string][] = [
  [`nice --adjustment 5 ${P}`, 'nice'],
  [`nice --adj 5 ${P}`, 'nice'],
  [`timeout --signal TERM 5 ${P}`, 'timeout'],
  [`timeout --sig TERM 5 ${P}`, 'timeout'],
  [`timeout --kill-after 1 5 ${P}`, 'timeout'],
  [`timeout -sTERM 5 ${P}`, 'timeout'],
  [`timeout -vk 1 5 ${P}`, 'timeout'],
]

describe('nice, ionice, timeout, stdbuf and exec read a value the shell may split (CC-1421)', () => {
  it.each(SPLIT_VALUE)('denies %s, whose command word may move', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.wrapperValue)
  })

  it.each(LONG_VALUE)('denies %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.noVerify)
  })

  it.each([
    'nice -n 5 git status',
    `N='5 git'; nice -n "$N" git status`,
    'timeout 5 git fetch',
    `timeout "$T" make`,
    'ionice -c3 make',
    `nice -n $N make`,
    'timeout -s TERM 5 git fetch',
    `M=L; stdbuf -o "$M" git status`,
    `N=x; exec -a "$N" git status`,
  ])('allows %s', line => {
    expect(checkCommand(line, ctx)).toBeUndefined()
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
// Many hosts and CI runners refuse an unprivileged user namespace; then the unshare -r premise is unconfirmed.
const userNamespaces = installed('unshare') && pushes('unshare -r git ns') === 'ns'
const chrtSkipsDashes = installed('chrt') && pushes('chrt -o 0 -- git ns') === 'ns'

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

  it.skipIf(!installed('flock')).each(SPLIT_OPERAND)('%s runs git %s', (line, call) => {
    expect(pushes(line)).toBe(call)
  })

  it.each([...SPLIT_VALUE, ...LONG_VALUE].filter(([, wrapper]) => wrapper === 'exec' || installed(wrapper)))(
    '%s pushes',
    line => {
      expect(pushes(line)).toBe(PUSHED)
    },
  )

  it('a quoted value that does not split runs no git', () => {
    expect(pushes(`N='5 git'; nice -n "$N" git status`)).toBe('')
  })

  it.skipIf(!installed('setsid'))('setsid -f pushes from its forked child', () => {
    expect(pushes(`setsid -f ${P}`)).toBe(PUSHED)
  })

  it.skipIf(!chrtSkipsDashes).each(CHRT_DASHES)('%s pushes where chrt skips --', line => {
    expect(pushes(line)).toBe(PUSHED)
  })

  it.skipIf(!userNamespaces)('unshare -r pushes inside a user namespace', () => {
    expect(pushes(`unshare -r ${P}`)).toBe(PUSHED)
  })
})
