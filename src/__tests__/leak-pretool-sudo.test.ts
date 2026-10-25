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

const SUDO_PUSHES: readonly (readonly [string, string])[] = [
  ['sudo git push --no-verify', 'git push --no-verify'],
  ['/usr/bin/sudo git push --no-verify', 'git push --no-verify'],
  ['sudo -u root git push --no-verify', 'git push --no-verify'],
  ['sudo -uroot git push --no-verify', 'git push --no-verify'],
  ['sudo -nE git push --no-verify', 'git push --no-verify'],
  ['sudo -nu root git push --no-verify', 'git push --no-verify'],
  ['sudo --user=root git push --no-verify', 'git push --no-verify'],
  ['sudo --user root git push --no-verify', 'git push --no-verify'],
  ['sudo -D /tmp git push --no-verify', 'git push --no-verify'],
  ['sudo -g wheel git push --no-verify', 'git push --no-verify'],
  ['sudo -hhost git push --no-verify', 'git push --no-verify'],
  ['sudo --preserve-env=PATH git push --no-verify', 'git push --no-verify'],
  ['sudo --preserve-env git push --no-verify', 'git push --no-verify'],
  ['sudo -- git push --no-verify', 'git push --no-verify'],
  ['sudo nice git push --no-verify', 'git push --no-verify'],
  ['nice sudo git push --no-verify', 'git push --no-verify'],
]

const SUDO_XARGS: readonly (readonly [string, string])[] = [
  ['sudo xargs git push --no-verify', 'xargs git push --no-verify'],
  ['echo origin | sudo xargs -n 1 git push --no-verify', 'echo origin | xargs -n 1 git push --no-verify'],
  ['echo origin | xargs sudo git push --no-verify', 'echo origin | xargs git push --no-verify'],
]

describe('the bypass guard reads the command behind sudo', () => {
  it.each(SUDO_PUSHES)('denies %s as skipping the pre-push hook', line => {
    expect(checkCommand(line, ctx())).toBe(REASONS.noVerify)
  })

  it.each([...SUDO_PUSHES, ...SUDO_XARGS])('gives %s the same reason as %s', (withSudo, without) => {
    const bare = checkCommand(without, ctx())
    expect(bare).toBeDefined()
    expect(checkCommand(withSudo, ctx())).toBe(bare)
  })

  it.each([
    ['sudo GIT_CONFIG_COUNT=0 git push', REASONS.gitConfigEnv],
    ['sudo -u root GIT_CONFIG_COUNT=0 git push', REASONS.gitConfigEnv],
    ['sudo git -c core.hooksPath=/dev/null push', REASONS.gitConfig],
    ['sudo env -i git push', REASONS.envClear],
    ['sudo git push origin main', REASONS.privilegedPush],
    ['sudo -u root git push origin main', REASONS.privilegedPush],
  ])('denies %s for what runs behind sudo', (line, reason) => {
    expect(reason).toBeDefined()
    expect(checkCommand(line, ctx())).toBe(reason)
  })
})

describe('the bypass guard fails closed on a sudo option it cannot read', () => {
  it.each([
    'sudo --frobnicate git push --no-verify',
    'sudo --us root git push --no-verify',
    'sudo -$opts git push --no-verify',
    'sudo --user=$u git push',
    'sudo -h host git push --no-verify',
    'sudo -Eh host git push --no-verify',
  ])('denies %s', line => {
    expect(checkCommand(line, ctx())).toBe(REASONS.sudoOption)
  })

  // CC-1291. An empty or split $U as an option value shifts the command word,
  // so sudo -u $U echo git push runs git as the user echo.
  it.each([
    'sudo -u $U echo git push --no-verify',
    'sudo-rs -u $U echo git push --no-verify',
    'sudo -g $G git push --no-verify',
    'sudo --user $U git push',
    'sudo -D $D git push --no-verify',
    'sudo -nu $U git push',
    'sudo -u "$U" git push --no-verify',
    'echo x | xargs -I{} sudo -u {} git push',
    'sudo -u $U apt-get update',
  ])('denies %s, whose option value the shell expands', line => {
    expect(checkCommand(line, ctx())).toBe(REASONS.sudoOption)
  })

  it.each([
    ['sudo -n $X status', undefined],
    ['sudo -u root $CMD', undefined],
    ['sudo -u root git push', REASONS.privilegedPush],
  ])('reads %s past a flag or a literal value', (line, reason) => {
    expect(checkCommand(line, ctx())).toBe(reason)
  })
})

const SHELL_FLAGS = ['-s', '-i', '-Es', '--shell', '--login', '-u root -s']

describe('the bypass guard reads sudo -s and -i as the shell script they run', () => {
  it.each(SHELL_FLAGS)('denies sudo %s with a private term in a gh body', flags => {
    expect(checkCommand(`sudo ${flags} gh pr comment 1 --body '${TERM}'`, ctx())).toBeDefined()
  })

  it.each(SHELL_FLAGS)('denies sudo %s with a push whose quoted $IFS the shell splits', flags => {
    expect(checkCommand(`sudo ${flags} git 'push$IFS--no-verify'`, ctx())).toBeDefined()
  })

  it.each(SHELL_FLAGS)('denies sudo %s reading a push from a herestring', flags => {
    expect(checkCommand(`sudo ${flags} <<< 'git push --no-verify'`, ctx())).toBe(REASONS.noVerify)
  })

  it.each(SHELL_FLAGS)('denies sudo %s with a plain no-verify push', flags => {
    expect(checkCommand(`sudo ${flags} git push --no-verify`, ctx())).toBe(REASONS.noVerify)
  })

  it.each(['sudo -s git push $ARGS', 'echo x | xargs sudo -s git push'])(
    'denies %s, whose words it cannot read',
    line => {
      expect(checkCommand(line, ctx())).toBe(REASONS.hiddenCommand)
    },
  )
})

describe('the bypass guard allows sudo lines that skip no hook', () => {
  it.each([
    'sudo apt-get update',
    "sudo -u postgres psql -c 'select 1'",
    'sudo git status',
    'sudo -u root git status',
    'sudo -s git status',
    'sudo -i',
    "sudo -s <<< 'git status'",
    'sudo ls | xargs -n 1 echo',
    'echo "sudo git push --no-verify is denied"',
  ])('allows %s', line => {
    expect(checkCommand(line, ctx())).toBeUndefined()
  })
})

// CC-1423. `sudo -s` runs $SHELL, so a SHELL set on the line decides what reads the text. Premise
// observed where passwordless sudo exists: `echo 'import sys;print(1)' | SHELL=/usr/bin/python3 sudo -s`
// ran python, while the same line under `sudo -i` ran sh (the passwd-entry shell).
const PUSH = 'git push --no-verify origin HEAD:main'
const PY = `import os;os.system("${PUSH}")`

describe('the bypass guard fails closed when sudo -s runs a $SHELL the line sets', () => {
  it.each([
    `echo '${PY}' | SHELL=/usr/bin/python3 sudo -s`,
    `SHELL=/usr/bin/python3 sudo -s <<< '${PY}'`,
    `export SHELL=/usr/bin/python3; echo '${PY}' | sudo -s`,
    `echo '${PY}' | env SHELL=/usr/bin/python3 sudo -s`,
    `echo '${PY}' | SHELL=/usr/bin/python3 sudo --shell`,
    `echo '${PY}' | SHELL=$X sudo -s`,
  ])('denies %s', line => {
    expect(checkCommand(line, ctx())).toMatch(/\$SHELL names/)
  })

  it.each([
    "echo 'echo hi' | sudo -s",
    "SHELL=/bin/bash sudo -s <<< 'echo hi'",
    "echo 'echo hi' | SHELL=/usr/bin/python3 sudo -i",
    'sudo -u bob ls',
    'sudo git status',
  ])('allows %s', line => {
    expect(checkCommand(line, ctx())).toBeUndefined()
  })
})
