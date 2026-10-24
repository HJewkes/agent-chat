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
    pushes: ['doas -u root git push origin main', 'doas -n git push origin main', '/usr/bin/doas git push origin main'],
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
  it.each(["doas -s <<< 'git push origin main'", 'run0 --via-shell <<< "git push"', "su <<< 'git push'"])(
    'denies %s',
    line => {
      deny(line, REASONS.privilegedPush)
    },
  )

  it.each([
    `echo '${PY}' | SHELL=/usr/bin/python3 doas -s`,
    `echo '${PY}' | SHELL=/usr/bin/python3 su -m`,
  ])('denies %s, whose $SHELL the line sets', line => {
    expect(checkCommand(line, ctx())).toMatch(/\$SHELL names/)
  })
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
  ])('denies %s', line => {
    deny(line, REASONS.privilegeOption)
  })

  it.each(['echo x | xargs su', 'echo x | xargs doas -s'])('denies %s, fed by xargs', line => {
    deny(line, REASONS.hiddenCommand)
  })

  it('denies a privilege wrapper after a hidden command word', () => {
    expect(checkCommand('$X doas git push', ctx())).toBeDefined()
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
  ])('allows %s', line => {
    expect(checkCommand(line, ctx())).toBeUndefined()
  })
})
