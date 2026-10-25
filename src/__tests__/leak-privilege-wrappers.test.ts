import { describe, expect, it } from 'vitest'
import { dropPrivilegeOptions, PRIVILEGE_OPTIONS } from '../leak-guard/privilege-wrappers.js'
import { LIVE } from '../leak-guard/shell-words.js'

/** Parses `words` as the wrapper in words[0] would, its options starting at words[1]. */
const run = (...words: string[]) => dropPrivilegeOptions(words[0] as string, words, 1)

/** A word the shell expands, as the guard marks it. */
const live = (text: string) => text.replace('$', `${LIVE}$`)

/** Each wrapper's options as its own help or getopt string lists them, written out apart from the tables. */
const SPEC = {
  doas: { value: ['-a', '-C', '-u'], flag: ['-L', '-n'] },
  run0: {
    value: [
      ...['-u', '-g', '-D', '--machine', '--unit', '--property', '--description', '--slice', '--user'],
      ...['--group', '--nice', '--chdir', '--setenv', '--background', '--shell-prompt-prefix'],
      ...['--lightweight', '--area'],
    ],
    flag: [
      ...['-h', '-V', '--no-ask-password', '--slice-inherit', '--pty', '--pty-late', '--pipe'],
      ...['--empower', '--help', '--version'],
    ],
  },
  pkexec: { value: ['--user'], flag: ['--keep-cwd', '--disable-internal-agent', '--help', '--version'] },
  su: {
    value: [
      ...['-c', '-g', '-G', '-s', '-w', '--command', '--session-command', '--shell', '--group'],
      ...['--supp-group', '--whitelist-environment'],
    ],
    flag: [
      ...['-l', '-f', '-m', '-p', '-P', '-T', '-h', '-V', '--login', '--fast', '--preserve-environment'],
      ...['--pty', '--no-pty', '--help', '--version'],
    ],
  },
  'systemd-run': {
    value: [
      ...['-H', '-M', '-E', '-p', '-u', '--host', '--machine', '--unit', '--property', '--description'],
      ...['--slice', '--expand-environment', '--service-type', '--uid', '--gid', '--nice'],
      ...['--working-directory', '--root-directory', '--setenv', '--json', '--job-mode', '--background'],
      ...['--path-property', '--socket-property', '--timer-property', '--on-active', '--on-boot'],
      ...['--on-startup', '--on-unit-active', '--on-unit-inactive', '--on-calendar'],
    ],
    flag: [
      ...['-h', '-r', '-t', '-T', '-P', '-q', '-v', '-G', '-d', '-R', '--help', '--version'],
      ...['--no-ask-password', '--user', '--system', '--scope', '--slice-inherit', '--no-block'],
      ...['--remain-after-exit', '--wait', '--send-sighup', '--same-dir', '--same-root-dir', '--pty'],
      ...['--pty-late', '--pipe', '--quiet', '--verbose', '--collect', '--ignore-failure', '--no-pager'],
      ...['--on-timezone-change', '--on-clock-change'],
    ],
  },
  runuser: {
    value: [
      ...['-c', '-g', '-G', '-s', '-u', '-w', '--command', '--session-command', '--shell', '--group'],
      ...['--supp-group', '--whitelist-environment', '--user'],
    ],
    flag: [
      ...['-l', '-f', '-m', '-p', '-P', '-T', '-h', '-V', '--login', '--fast', '--preserve-environment'],
      ...['--pty', '--no-pty', '--help', '--version'],
    ],
  },
  setpriv: {
    value: [
      ...['--ambient-caps', '--inh-caps', '--bounding-set', '--ruid', '--euid', '--rgid', '--egid'],
      ...['--reuid', '--regid', '--groups', '--securebits', '--pdeathsig', '--ptracer', '--selinux-label'],
      ...['--apparmor-profile', '--landlock-access', '--landlock-rule', '--seccomp-filter'],
    ],
    flag: [
      ...['-d', '-h', '-V', '--dump', '--nnp', '--no-new-privs', '--clear-groups', '--keep-groups'],
      ...['--init-groups', '--reset-env', '--help', '--version'],
    ],
  },
  machinectl: {
    value: [
      ...['-p', '-s', '-H', '-M', '-n', '-o', '-E', '--property', '--signal', '--kill-whom', '--host'],
      ...['--machine', '--lines', '--output', '--setenv', '--uid', '--format', '--max-addresses', '--verify'],
    ],
    flag: [
      ...['-h', '-a', '-l', '-q', '-V', '--help', '--version', '--no-pager', '--no-legend'],
      ...['--no-ask-password', '--value', '--all', '--full', '--quiet', '--read-only', '--mkdir'],
      ...['--force', '--now'],
    ],
  },
} as const

const SHELL_OPTIONS = {
  doas: ['-s'],
  run0: ['-i', '--via-shell'],
  pkexec: [],
  su: [],
  'systemd-run': ['-S', '--shell'],
  runuser: [],
  setpriv: [],
  machinectl: [],
} as const

type Wrapper = keyof typeof SPEC
const WRAPPERS = Object.keys(SPEC) as Wrapper[]
const isLong = (option: string) => option.startsWith('--')
const tableOptions = (name: Wrapper, kind: 'Value' | 'Flag' | 'Shell') => {
  const t = PRIVILEGE_OPTIONS.get(name)!
  return [...[...t[`short${kind}`]].map(c => `-${c}`), ...t[`long${kind}`]].sort()
}

/** su and runuser read their words alike: a `-c` value runs in a shell, wherever it sits. */
const SU_LIKE: readonly Wrapper[] = ['su', 'runuser']
/** The words after the option under test, and what the wrapper runs from them. */
const tail = (w: Wrapper) => (SU_LIKE.includes(w) ? ['-c', 'git push'] : ['git', 'push'])
const expected = (w: Wrapper, at: number) =>
  SU_LIKE.includes(w) ? { shell: ['sh', '-c', 'git push'] } : { at }

/**
 * Rows for every option the spec lists. su's -s takes a shell, so its decoy cannot look like an option;
 * runuser's -u clashes with -c; machinectl's -s is a signal and takes the decoy like any value.
 */
const decoyless = (w: Wrapper, o: string) =>
  (SU_LIKE.includes(w) && ['-s', '--shell'].includes(o)) || (w === 'runuser' && ['-u', '--user'].includes(o))
const valueRows = WRAPPERS.flatMap(w => SPEC[w].value.filter(o => !decoyless(w, o)).map(o => [w, o] as const))
const flagRows = WRAPPERS.flatMap(w => SPEC[w].flag.map(o => [w, o] as const))
const gluedRows = valueRows.filter(([w]) => w !== 'pkexec')

describe('the option tables', () => {
  it.each(WRAPPERS)('%s lists exactly the spec options', w => {
    expect(tableOptions(w, 'Value')).toEqual([...SPEC[w].value].sort())
    expect(tableOptions(w, 'Flag')).toEqual([...SPEC[w].flag].sort())
    expect(tableOptions(w, 'Shell')).toEqual([...SHELL_OPTIONS[w]].sort())
  })
})

describe('a value option takes the next word even when it looks like an option', () => {
  it.each(valueRows)('%s %s -c', (w, o) => {
    expect(run(w, o, '-c', ...tail(w))).toEqual(expected(w, 3))
  })

  it.each(gluedRows)('%s %s glued to -c', (w, o) => {
    const glued = isLong(o) ? `${o}=-c` : `${o}-c`
    expect(run(w, glued, ...tail(w))).toEqual(expected(w, 2))
  })

  it('su -s and --shell take the shell path', () => {
    expect(run('su', '-s', '/bin/bash', 'root', '-c', 'git push')).toEqual({
      shell: ['sh', '-c', 'git push'],
    })
    expect(run('su', '--shell', '/bin/zsh', 'root', '-c', 'git push')).toEqual({
      shell: ['sh', '-c', 'git push'],
    })
  })

  it('su -g keeps the earlier -c: the decoy -c is its group and echo is the user', () => {
    expect(run('su', '-c', 'git push', '-g', '-c', 'echo')).toEqual({ shell: ['sh', '-c', 'git push'] })
  })
})

describe('a flag consumes nothing', () => {
  it.each(flagRows)('%s %s', (w, o) => {
    expect(run(w, o, ...tail(w))).toEqual(expected(w, 2))
  })

  it('su - is a flag', () => {
    expect(run('su', '-', 'root', '-c', 'git push')).toEqual({ shell: ['sh', '-c', 'git push'] })
  })
})

describe('doas', () => {
  it.each([
    [['doas', '-uroot', 'git'], 2],
    [['doas', '-n', '--', 'git'], 3],
    [['doas', '-nu', 'root', 'git'], 3],
    [['doas', 'git', 'push'], 1],
  ])('finds the command in %j at %i', (words, at) => {
    expect(run(...words)).toEqual({ at })
  })

  it('runs a shell for -s', () => {
    expect(run('doas', '-s')).toEqual({ shell: ['sh'] })
    expect(run('doas', '-u', 'root', '-s', 'git', 'push')).toEqual({ shell: ['sh', '-c', 'git push'] })
  })
})

describe('run0', () => {
  it('reads --setenv=A=1 as one word', () => {
    expect(run('run0', '--setenv=A=1', 'git')).toEqual({ at: 2 })
  })

  it('runs a shell for -i and --via-shell', () => {
    expect(run('run0', '-i', 'git', 'push')).toEqual({ shell: ['sh', '-c', 'git push'] })
    expect(run('run0', '--via-shell')).toEqual({ shell: ['sh'] })
    expect(run('run0', '--via-shell', 'echo', 'a b')).toEqual({ shell: ['sh', '-c', 'echo a\\ b'] })
  })
})

describe('systemd-run', () => {
  it('runs a shell for -S', () => {
    expect(run('systemd-run', '-t', '-S')).toEqual({ shell: ['sh'] })
  })

  it('fails closed on a $ it would expand, and on an Exec property', () => {
    expect(run('systemd-run', '-E', 'P=push', 'git', '$P')).toBeUndefined()
    expect(run('systemd-run', '-pExecStartPre=/usr/bin/git push', 'true')).toBeUndefined()
    expect(run('systemd-run', '--timer-property=ExecStart=x', 'true')).toBeUndefined()
    expect(run('run0', '--property', 'ExecStopPost=x', 'true')).toBeUndefined()
  })
})

describe('runuser', () => {
  it.each([
    [['runuser', '-u', 'root', 'git', 'push']],
    [['runuser', '-u', 'root', '--', 'git', 'push']],
    [['runuser', '--user=root', 'git', 'push']],
  ])('runs the words of %j with no shell', words => {
    expect(run(...words)).toEqual({ shell: ['sh', '-c', 'git push'] })
  })

  it('reads as su without -u, and fails closed on -c or -s with it', () => {
    expect(run('runuser', '-l', 'root', '-c', 'git push')).toEqual({ shell: ['sh', '-c', 'git push'] })
    expect(run('runuser', '-u', 'root', '-c', 'git push')).toBeUndefined()
    expect(run('runuser', '-u', 'root', '-s', '/bin/sh')).toBeUndefined()
  })
})

describe('machinectl', () => {
  it.each([
    [['machinectl', 'shell', 'root@', 'git', 'push'], 3],
    [['machinectl', '-q', 'shell', '--uid', 'root', '.host', 'git', '-c', 'x'], 6],
    [['machinectl', 'list', '-a'], 1],
    [['machinectl'], 1],
  ])('finds the command in %j at %i', (words, at) => {
    expect(run(...words)).toEqual({ at })
  })

  it('runs a shell for shell with no command', () => {
    expect(run('machinectl', 'shell')).toEqual({ shell: ['sh'] })
    expect(run('machinectl', 'shell', 'root@')).toEqual({ shell: ['sh'] })
  })

  it('fails closed on an expanded verb or machine name', () => {
    expect(run('machinectl', live('$V'), 'root@', 'git')).toBeUndefined()
    expect(run('machinectl', 'shell', live('$H'), 'git')).toBeUndefined()
  })
})

describe('with no command', () => {
  it.each([[['run0']], [['run0', '-u', 'root']], [['pkexec']], [['pkexec', '--user', 'root']]])(
    '%j runs a shell',
    words => {
      expect(run(...words)).toEqual({ shell: ['sh'] })
    },
  )
})

describe('su', () => {
  it.each([
    [['su', 'root', '-c', 'git push']],
    [['su', '-', 'root', '--command=git push']],
    [['su', '--session-command', 'git push', 'root']],
    [['su', '-lcgit push']],
  ])('runs the -c value in %j', words => {
    expect(run(...words)).toEqual({ shell: ['sh', '-c', 'git push'] })
  })

  it('passes words after the user to the shell', () => {
    expect(run('su', 'root', '-c', 'x', 'extra')).toEqual({ shell: ['sh', '-c', 'x', 'extra'] })
    expect(run('su', 'root', 'script.sh', 'a')).toEqual({ shell: ['sh', 'script.sh', 'a'] })
    expect(run('su', 'root', '--', '-c', 'x')).toEqual({ shell: ['sh', '-c', 'x'] })
  })

  it('runs a bare shell with no command', () => {
    expect(run('su')).toEqual({ shell: ['sh'] })
    expect(run('su', 'root')).toEqual({ shell: ['sh'] })
    expect(run('su', '-', 'root')).toEqual({ shell: ['sh'] })
  })

  it('fails closed when -s names a program that is not a shell', () => {
    expect(run('su', '-s', '/usr/bin/git', 'root', '-c', 'push')).toBeUndefined()
    expect(run('su', '--shell=git', '-c', 'push')).toBeUndefined()
  })

  it('fails closed on an expanded word anywhere, since su reads options past the user', () => {
    expect(run('su', live('$U'), '-c', 'ls')).toBeUndefined()
  })
})

describe('an expanded option value fails closed, since an empty one shifts the command', () => {
  it.each([
    [['doas', '-u', live('$U'), 'echo', 'git', 'push', '--no-verify']],
    [['doas', '-C', live('$F'), 'git']],
    [['run0', '-u', live('$U'), 'echo', 'git', 'push']],
    [['run0', '--user', live('$U'), 'git']],
    [['run0', '-D', live('"$D"'), 'git']],
    [['pkexec', '--user', live('$U'), 'echo', 'git', 'push']],
    [['su', '-c', live('$CMD'), 'root']],
    [['su', '-c', 'ls', '-g', live('$G'), 'git push']],
    [['su', '-s', live('$SH'), '-c', 'push']],
  ])('%j', words => {
    expect(run(...words)).toBeUndefined()
  })
})

describe('an expanded word in a returned shell argv fails closed, since it may split into options', () => {
  it.each([
    [['su', '--', live('$E')]],
    [['su', 'root', '--', live('$E'), '-c', 'x']],
    [['su', '-c', 'x', '--', 'root', live('$A')]],
    [['doas', '-s', live('$X')]],
    [['doas', '-s', '--', 'git', live('$X')]],
    [['run0', '-i', live('$X')]],
    [['run0', '--via-shell', 'git', live('$X')]],
  ])('%j', words => {
    expect(run(...words)).toBeUndefined()
  })
})

describe('fail closed', () => {
  it.each([
    [['doas', '-X', 'git']],
    [['doas', '--user', 'root', 'git']],
    [['doas', '-u']],
    [['run0', '--frob', 'git']],
    [['run0', '--pty=1', 'git']],
    [['run0', live('--user=$u'), 'git']],
    [['pkexec', '--frob', 'git']],
    [['pkexec', '-u', 'root', 'git']],
    [['pkexec', '--user=root', 'git']],
    [['su', '--frob', '-c', 'git push']],
    [['su', '-X']],
    [['su', live('-$o')]],
    [['su', '-c']],
    [['su', '--login=x']],
    [['ls', 'git']],
  ])('%j is undefined', words => {
    expect(run(...words)).toBeUndefined()
  })
})
