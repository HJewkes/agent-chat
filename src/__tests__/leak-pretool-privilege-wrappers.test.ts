import { parseTerms } from '@titan-design/egress-scan'
import { describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

// Synthetic only: a made-up private term.
const TERM = 'zq7privateseat'
const ctx = (): GuardContext => ({
  terms: { kind: 'ok', rules: parseTerms(`${TERM}\n`) },
  cwd: '/work',
  env: {},
  protectedPaths: ['/cfg/titan-egress/private-terms', '.agent-chat/git-hooks'],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
})

const deny = (line: string, reason: string | undefined): void => {
  expect(reason).toBeDefined()
  expect(checkCommand(line, ctx())).toBe(reason)
}

// CC-1218: each wrapper's command, and the push and gh rows it must deny.
const WRAPPERS = [
  {
    name: 'doas',
    pushes: [
      'doas -u root git push origin main',
      'doas -n git push origin main',
      '/usr/bin/doas git push origin main',
    ],
    gh: ['doas gh pr list', 'doas gh pr create --title t --body b'],
    noVerify: 'doas -u root git push --no-verify',
  },
  {
    name: 'run0',
    pushes: [
      'run0 --user=root git push origin main',
      'run0 -D /tmp git push origin main',
      '/usr/bin/run0 git push origin main',
      'run0 -i git push origin main',
    ],
    gh: ['run0 gh api repos/o/r', 'run0 --user root agent-chat gh-write -- pr comment 1 --body x'],
    noVerify: 'run0 --no-ask-password git push --no-verify',
  },
  {
    name: 'pkexec',
    pushes: [
      'pkexec --user root git push origin main',
      'pkexec --keep-cwd git push origin main',
      '/usr/bin/pkexec git push origin main',
    ],
    gh: ['pkexec gh pr list', 'pkexec gh issue create -t t -b b'],
    noVerify: 'pkexec git push --no-verify',
  },
  {
    name: 'su',
    pushes: [
      "su -c 'git push origin main'",
      "su root -c 'git push'",
      "su - root -c 'git push'",
      "su - root --command='git push origin main'",
      "/usr/bin/su -c 'git push origin main'",
    ],
    gh: ["su -c 'gh pr list'", "su root -c 'gh pr create --title t --body b'"],
    noVerify: "su -c 'git push --no-verify'",
  },
  {
    name: 'systemd-run, the binary run0 links to',
    pushes: [
      'systemd-run --user -t git push origin main',
      'systemd-run --uid=root -t git push',
      "systemd-run --user -t sh -c 'git push'",
      'systemd-run -p Nice=5 --scope git push',
      '/usr/bin/systemd-run -P git push',
    ],
    gh: ['systemd-run -t gh pr list', 'systemd-run --user -E A=b gh pr create --title t --body b'],
    noVerify: 'systemd-run --user -t git push --no-verify',
  },
  {
    name: 'runuser',
    pushes: [
      "runuser -l root -c 'git push'",
      'runuser -u root git push origin main',
      'runuser -u root -- git push origin main',
      "runuser root -c 'git push'",
    ],
    gh: ['runuser -u root gh pr list', "runuser - root -c 'gh pr list'"],
    noVerify: 'runuser -u root -- git push --no-verify',
  },
  {
    name: 'setpriv',
    pushes: ['setpriv --reuid=0 git push', 'setpriv --reuid 0 --regid 0 --init-groups git push origin main'],
    gh: ['setpriv --reuid=0 gh pr list', 'setpriv --reset-env --reuid 0 gh api repos/o/r'],
    noVerify: 'setpriv --reuid=0 git push --no-verify',
  },
  {
    name: 'machinectl shell',
    pushes: [
      'machinectl shell root@ /usr/bin/git push',
      'machinectl --uid=root shell .host git push origin main',
      'machinectl shell -q root@.host git push',
    ],
    gh: ['machinectl shell root@ /usr/bin/gh pr list', 'machinectl shell .host gh api repos/o/r'],
    noVerify: 'machinectl shell root@ /usr/bin/git push --no-verify',
  },
  {
    name: 'sudo-rs, sudo.ws and su-rs, the other names of sudo and su',
    pushes: ['sudo-rs git push origin main', 'sudo.ws -u root git push', "su-rs -c 'git push'"],
    gh: ['sudo-rs gh pr list', "su-rs root -c 'gh pr list'"],
    noVerify: 'sudo-rs git push --no-verify',
  },
]

describe.each(WRAPPERS)('the bypass guard reads the command behind $name', ({ pushes, gh, noVerify }) => {
  it.each(pushes)('denies %s as a privileged push', line => {
    deny(line, REASONS.privilegedPush)
  })

  it.each(gh)('denies %s as a privileged gh', line => {
    deny(line, REASONS.privilegedGh)
  })

  it('keeps the no-verify reason for a push that skips the hook', () => {
    deny(noVerify, REASONS.noVerify)
  })
})

const PY = 'import os;os.system("git push --no-verify origin HEAD:main")'

describe('the bypass guard reads doas -s, run0 -i and su as the shell they run', () => {
  it.each([
    "doas -s <<< 'git push origin main'",
    'run0 --via-shell <<< "git push"',
    "su <<< 'git push'",
    "systemd-run -t -S <<< 'git push'",
    "runuser -u root <<< 'git push'",
    "machinectl shell root@ <<< 'git push'",
  ])('denies %s', line => {
    deny(line, REASONS.privilegedPush)
  })

  it.each([`echo '${PY}' | SHELL=/usr/bin/python3 doas -s`, `echo '${PY}' | SHELL=/usr/bin/python3 su -m`])(
    'denies %s, whose $SHELL the line sets',
    line => {
      expect(checkCommand(line, ctx())).toMatch(/\$SHELL names/)
    },
  )
})

describe('the bypass guard fails closed on a privilege wrapper it cannot read', () => {
  it.each([
    'doas -X git push',
    'run0 --frob git push',
    'pkexec -u root git push',
    "su --frob -c 'git push'",
    'su -c "$CMD"',
    'run0 --user=$U git push',
    'su -s /usr/bin/git root -c push',
    'echo x | xargs su -c',
    "systemd-run --user -E P=push git '$P'",
    "systemd-run --user git '${P}'",
    "systemd-run -p 'ExecStartPre=/usr/bin/git push' true",
    "run0 --property='ExecStartPost=/usr/bin/git push' true",
    'systemd-run --frob git push',
    "runuser -u root -c 'git push'",
    'setpriv --frob git push',
    'machinectl --frob shell root@ git push',
    'machinectl shell $HOST git push',
  ])('denies %s', line => {
    deny(line, REASONS.privilegeOption)
  })

  it.each(['echo x | xargs su', 'echo x | xargs doas -s'])('denies %s, fed by xargs', line => {
    deny(line, REASONS.hiddenCommand)
  })

  it('denies a privilege wrapper after a hidden command word', () => {
    deny('$X doas git push', REASONS.privilegedPush)
  })
})

describe('the bypass guard allows privilege-wrapped lines that skip no hook', () => {
  it.each([
    'doas apt update',
    'run0 systemctl status',
    'pkexec true',
    "su -c 'ls' root",
    'echo su',
    'doas git status',
    'doas ls; git push origin main',
    'systemd-run --user -t ls',
    'runuser -u nobody -- ls',
    'setpriv --reuid=1000 ls',
    'machinectl list',
    'machinectl shell root@ /usr/bin/ls',
    'sudo-rs apt update',
  ])('allows %s', line => {
    expect(checkCommand(line, ctx())).toBeUndefined()
  })
})

describe('the bypass guard reads the -c script of sg and capsh (CC-1602)', () => {
  it.each([
    "sg wheel -c 'git push --no-verify'",
    "capsh -- -c 'git push --no-verify'",
    "sg wheel 'git push --no-verify'",
    "capsh --user=bob --shell=/bin/sh -- -c 'git push --no-verify'",
  ])('denies %s', line => {
    deny(line, REASONS.noVerify)
  })

  it.each([
    "sg wheel -c 'git push origin main'",
    "/usr/bin/sg wheel -c 'git push'",
    "capsh -- -c 'git push origin main'",
    "sg wheel <<< 'git push'",
    "capsh -- <<< 'git push'",
  ])('denies %s as a privileged push', line => {
    deny(line, REASONS.privilegedPush)
  })

  it.each(["sg wheel -c 'gh pr list'", "capsh -- -c 'gh pr create --title t --body b'"])(
    'denies %s as a privileged gh',
    line => {
      deny(line, REASONS.privilegedGh)
    },
  )

  it.each([
    'sg wheel -c "$CMD"',
    "sg wheel ls -c 'git push'",
    "capsh --frob -- -c 'git push'",
    'capsh --shell=/usr/bin/git -- push',
    'capsh -- -c "$CMD"',
    // zsh expands a word that starts with `=`, so `==` is a word the guard cannot read.
    "capsh == -- -c 'git push'",
  ])('denies %s as an option the wrapper reader refuses', line => {
    deny(line, REASONS.privilegeOption)
  })

  it.each(['sg wheel -c ls', "sg wheel -c 'git status'", 'capsh --print', 'capsh -- -c ls'])(
    'allows %s',
    line => {
      expect(checkCommand(line, ctx())).toBeUndefined()
    },
  )
})

describe('the bypass guard reads newgrp, the binary sg links to (CC-1602)', () => {
  it.each([
    "newgrp wheel <<< 'git push --no-verify'",
    "printf 'git push --no-verify' | newgrp wheel",
    "newgrp - wheel <<< 'git push --no-verify'",
    "newgrp wheel -c 'git push --no-verify'",
  ])('denies %s', line => {
    deny(line, REASONS.noVerify)
  })

  it.each(["newgrp wheel <<< 'git push'", "/usr/bin/newgrp wheel -c 'gh pr list'"])(
    'denies %s as privileged',
    line => {
      expect([REASONS.privilegedPush, REASONS.privilegedGh]).toContain(checkCommand(line, ctx()))
    },
  )

  it.each(['newgrp $G <<< ls', "newgrp --frob wheel <<< 'git push'"])('denies %s as unreadable', line => {
    deny(line, REASONS.privilegeOption)
  })

  it.each(['newgrp wheel -c ls', 'newgrp wheel <<< ls'])('allows %s', line => {
    expect(checkCommand(line, ctx())).toBeUndefined()
  })
})

const PRIVILEGED_HIDDEN = REASONS.privilegedHidden

describe('the bypass guard denies an expanded command word behind every privilege wrapper', () => {
  it.each([
    'doas $(echo git push)',
    "CMD='git push'; doas $CMD",
    "CMD='git push'; doas $CMD origin main",
    'run0 $(echo git push)',
    "G='git -C /x push'; run0 $G",
    `CMD='gh pr create --title t --body ${TERM}'; run0 $CMD`,
    "CMD='git push'; pkexec $CMD",
    'pkexec --user root $(echo gh pr list)',
    'setpriv --reuid=0 $(echo git push)',
    'machinectl shell .host $(echo gh pr list)',
    'sudo-rs $(echo git push)',
    'sudo.ws $(echo git push)',
    'sudo $(echo git push)',
    "doas sh -c '$(echo git push)'",
    '$X doas $(echo git push)',
  ])('denies %s', line => {
    deny(line, PRIVILEGED_HIDDEN)
  })

  // systemd-run expands $ itself, so its reader refuses any word holding one before the command is read.
  it.each([
    'su -c "$(echo git push)"',
    'su-rs -c "$CMD"',
    'runuser -u root -- $(echo git push)',
    'doas -s -- $(echo git push)',
    'systemd-run --user -t $(echo git push)',
  ])('denies %s as an option the wrapper reader refuses', line => {
    deny(line, REASONS.privilegeOption)
  })

  it.each([
    "systemd-run -p 'StandardInputText=git push --no-verify' sh",
    'systemd-run -p StandardInputData=Z2l0IHB1c2gK sh',
    'systemd-run --user --property=StandardInputText=gh\\ pr\\ list bash',
    "run0 --property='StandardInputText=git push' sh",
    'run0 -p StandardInput=file:/tmp/s sh',
  ])('denies %s, a unit property that feeds the shell', line => {
    deny(line, REASONS.privilegeOption)
  })

  it.each([
    'doas $EDITOR /etc/hosts',
    'run0 systemctl status',
    'systemd-run --user -p MemoryMax=1G make',
    'pkexec true',
    "su -c 'ls' root",
  ])('allows %s', line => {
    expect(checkCommand(line, ctx())).toBeUndefined()
  })
})
