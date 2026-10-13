import { parseTerms } from '@titan-design/egress-scan'
import { describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

// Synthetic only: a made-up private term.
const ctx = (): GuardContext => ({
  terms: { kind: 'ok', rules: parseTerms('zq7privateseat\n') },
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
  ])('denies %s for what runs behind sudo', (line, reason) => {
    expect(checkCommand(line, ctx())).toBe(reason)
  })
})

describe('the bypass guard fails closed on a sudo option it cannot read', () => {
  it.each([
    'sudo --frobnicate git push --no-verify',
    'sudo --us root git push --no-verify',
    'sudo -$opts git push --no-verify',
    'sudo --user=$u git push',
  ])('denies %s', line => {
    expect(checkCommand(line, ctx())).toBe(REASONS.sudoOption)
  })
})

describe('the bypass guard allows sudo lines that skip no hook', () => {
  it.each([
    'sudo apt-get update',
    "sudo -u postgres psql -c 'select 1'",
    'sudo git status',
    'sudo git push origin main',
    'sudo -u root git push origin main',
    'sudo ls | xargs -n 1 echo',
    'echo "sudo git push --no-verify is denied"',
  ])('allows %s', line => {
    expect(checkCommand(line, ctx())).toBeUndefined()
  })
})
