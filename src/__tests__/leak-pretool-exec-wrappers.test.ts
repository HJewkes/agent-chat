import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import { fakeGitShells } from './helpers/fake-git-shells.js'

/**
 * prlimit, GNU time, numactl, nsenter, chroot, setarch and its names, enosys, uclampset, coresched,
 * busybox setsid and scriptlive run the command they are given (CC-1424). Real bash with a fake
 * `git` first on PATH confirms each deny row runs the push, where the host lets the wrapper run.
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
const USERNS = 'unshare -U sleep 5 & nsenter -t $! -U --preserve-credentials'

// A line each wrapper runs `git probe` with, where the host lets it run unprivileged.
const PROBES: Record<string, string> = {
  prlimit: 'prlimit -n git probe',
  time: '/usr/bin/time -o /dev/null git probe',
  numactl: 'numactl -l git probe',
  setarch: 'setarch linux64 git probe',
  x86_64: 'x86_64 git probe',
  enosys: 'enosys -s kcmp git probe',
  uclampset: 'uclampset -m 0 git probe',
  coresched: 'coresched new -- git probe',
  busybox: 'busybox setsid git probe',
  scriptlive: `scriptlive -c 'git probe' -t tm -I in`,
  userns: `${USERNS} git probe; kill $!`,
}

// Each row: the line, and the probe its premise needs.
const BYPASSES: [string, string][] = [
  [`prlimit ${P}`, 'prlimit'],
  [`prlimit -n ${P}`, 'prlimit'],
  [`prlimit -n1024 --nofile=1024 ${P}`, 'prlimit'],
  [`prlimit -o RESOURCE ${P}`, 'prlimit'],
  [`prlimit bash -c '${P}'`, 'prlimit'],
  [`echo '${P}' | prlimit bash`, 'prlimit'],
  [`/usr/bin/time ${P}`, 'time'],
  [`/usr/bin/time -o /dev/null ${P}`, 'time'],
  [`/usr/bin/time -qf %e -o /dev/null ${P}`, 'time'],
  [`/usr/bin/time --output=/dev/null ${P}`, 'time'],
  [`command time -o /dev/null ${P}`, 'time'],
  [`numactl -l ${P}`, 'numactl'],
  [`numactl --localalloc -- ${P}`, 'numactl'],
  [`numactl -C 0 ${P}`, 'numactl'],
  [`numactl --physcpubind=0 bash -c '${P}'`, 'numactl'],
  [`setarch linux64 ${P}`, 'setarch'],
  [`setarch linux64 -R ${P}`, 'setarch'],
  [`setarch -R ${P}`, 'setarch'],
  [`setarch --addr-no-randomize ${P}`, 'setarch'],
  [`linux64 ${P}`, 'setarch'],
  [`linux32 -R ${P}`, 'setarch'],
  [`echo '${P}' | linux64`, 'setarch'],
  [`setarch x86_64 ${P}`, 'x86_64'],
  // An arch with no setarch name of its own, so the guard must skip it to find the command.
  [`setarch i686 -R ${P}`, 'x86_64'],
  [`x86_64 -R ${P}`, 'x86_64'],
  [`i386 ${P}`, 'x86_64'],
  [`echo '${P}' | setarch x86_64 bash`, 'x86_64'],
  [`enosys ${P}`, 'enosys'],
  [`enosys -s kcmp ${P}`, 'enosys'],
  [`enosys --syscall=kcmp -- ${P}`, 'enosys'],
  [`echo '${P}' | enosys bash`, 'enosys'],
  [`uclampset -m 0 ${P}`, 'uclampset'],
  [`uclampset -m 0 -R ${P}`, 'uclampset'],
  [`coresched new -- ${P}`, 'coresched'],
  [`coresched -- new ${P}`, 'coresched'],
  [`coresched new -t pid -- ${P}`, 'coresched'],
  [`coresched copy -- bash -c '${P}'`, 'coresched'],
  [`busybox setsid ${P}`, 'busybox'],
  [`busybox setsid -- ${P}`, 'busybox'],
  [`echo '${P}' | busybox setsid bash`, 'busybox'],
]

// Rows that need root or a tty: chroot, nsenter into a namespace this user does not own, busybox setsid -c.
const UNVERIFIED = [
  `chroot / ${P}`,
  `chroot --userspec=0:0 / ${P}`,
  `chroot --skip-chdir / bash -c '${P}'`,
  `echo '${P}' | chroot /`,
  `nsenter -t 1 -a ${P}`,
  `nsenter --target=1 --mount --uts ${P}`,
  `nsenter -t 1 -m -S 0 ${P}`,
  `nsenter -t 1 -r -w/tmp ${P}`,
  `echo '${P}' | nsenter -t 1 -a`,
  `uname26 ${P}`,
  `busybox setsid -c ${P}`,
]

// Lines it cannot read, each of which still pushes: line, probe.
const UNREAD: [string, string][] = [
  [`scriptlive -c '${P}' -t tm -I in`, 'scriptlive'],
  [`busybox sh -c '${P}'`, 'busybox'],
  [`${USERNS} ${P}; kill $!`, 'userns'],
  [`X=-o; /usr/bin/time $X /dev/null ${P}`, 'time'],
  [`A='linux64 git'; setarch $A ${PUSHED}`, 'setarch'],
  [`N='0 git'; numactl -C $N ${PUSHED}`, 'numactl'],
]

describe('exec wrappers run the command after their options (CC-1424)', () => {
  it.each([...BYPASSES.map(([line]) => line), ...UNVERIFIED])('denies %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.noVerify)
  })

  it.each(UNREAD)('denies %s, which it cannot read', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.jobOption)
  })

  it.each([
    'prlimit --bogus git push',
    'time -x git push',
    'numactl -x git push',
    'nsenter --frob git push',
    'chroot / --userspec=0:0 git push',
    'setarch -Q git push',
    'enosys -z git push',
    'uclampset --frob git push',
    'coresched new git -v push',
    'busybox env git push',
    'scriptlive t ts && git status',
  ])('fails closed on a line that may reach git: %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.jobOption)
  })

  it.each([
    'prlimit -n make',
    '/usr/bin/time -o t.txt make',
    'numactl -l ls',
    'setarch x86_64 -R make',
    'linux64 git status',
    'enosys -s kcmp git status',
    'coresched new -- git status',
    'busybox setsid git fetch',
    'busybox ls',
    'scriptlive t ts',
    'time make',
    'time -p git status',
    'chroot /srv/root ls',
    'nsenter -t 1 -a git status',
  ])('allows %s', line => {
    expect(checkCommand(line, ctx)).toBeUndefined()
  })

  it.each([`time -p ${P}`, `time -- ${P}`, `setsid ${P}`])('still denies the control %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.noVerify)
  })
})

const real = fakeGitShells('agent-chat-exec-wrappers-', P)
afterAll(real.cleanup)
fs.writeFileSync(path.join(real.root, 'tm'), 'I 0.01 5\n')
fs.writeFileSync(path.join(real.root, 'in'), 'exit\n')
const BASH = real.shells.find(([shell]) => shell.endsWith('bash'))
const pushes = (line: string): string => (BASH === undefined ? '' : real.gitCalls(BASH[0], BASH[1], line))
const runs = new Map(Object.entries(PROBES).map(([probe, line]) => [probe, pushes(line) === 'probe']))

describe.skipIf(BASH === undefined)('real bash runs the push behind each wrapper', () => {
  it.each([...BYPASSES, ...UNREAD].filter(([, probe]) => runs.get(probe) === true))('%s pushes', line => {
    expect(pushes(line)).toBe(PUSHED)
  })
})
