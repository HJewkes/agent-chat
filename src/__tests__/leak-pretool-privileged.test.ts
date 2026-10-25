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

const PUSH_DENY = /^leak-guard: git push under sudo/
const GH_DENY = /^leak-guard: gh or agent-chat gh-write under sudo/

// CC-1218: sudo's env_reset and secure_path drop the hooks path and the shims, so any push skips the scan.
describe('the bypass guard denies git push under sudo outright', () => {
  it.each([
    'sudo git push',
    'sudo git push origin main',
    'sudo git push -n',
    'sudo -E git push',
    '/usr/bin/sudo git push',
    'sudo -u root git -C /w push',
    "sudo sh -c 'git push'",
    `sudo bash -c "eval 'git push origin'"`,
    'sudo -s git push',
    'echo o | sudo xargs git push origin --',
    'sudo env A=1 git push',
    String.raw`sudo find . -maxdepth 0 -exec true \; -exec git push \;`,
  ])('denies %s', line => {
    expect(checkCommand(line, ctx())).toMatch(PUSH_DENY)
  })

  it.each([
    ['sudo git push --no-verify', REASONS.noVerify],
    ['sudo GIT_CONFIG_COUNT=0 git push', REASONS.gitConfigEnv],
  ])('keeps the stronger reason for %s', (line, reason) => {
    expect(checkCommand(line, ctx())).toBe(reason)
  })
})

describe('the bypass guard denies gh under sudo outright', () => {
  it.each([
    'sudo gh pr create --title t --body b',
    'sudo gh pr list',
    'sudo gh api repos/o/r',
    'sudo agent-chat gh-write -- pr comment 1 --body x',
    "sudo sh -c 'gh issue create -t t -b b'",
  ])('denies %s', line => {
    expect(checkCommand(line, ctx())).toMatch(GH_DENY)
  })
})

const PRIVILEGED_HIDDEN = REASONS.privilegedHidden

const deny = (line: string, reason: string | undefined): void => {
  expect(reason).toBeDefined()
  expect(checkCommand(line, ctx())).toBe(reason)
}

// Under sudo nothing catches a hidden git or gh at run time, so a word the guard cannot read denies.
describe('the bypass guard denies an expanded command word under sudo', () => {
  it.each([
    'sudo $(echo git push)',
    'sudo `echo git` push',
    "CMD='git push'; sudo $CMD",
    "CMD='git push'; sudo $CMD origin main",
    "G='git -C /x push'; sudo -E $G",
    'sudo $G push',
    'sudo -u root $(echo gh pr list)',
    `CMD='gh pr create --title t --body ${TERM}'; sudo $CMD`,
    "sudo sh -c '$(echo git push)'",
    'sudo env A=1 $(echo git push)',
    'sudo nice $(echo git push)',
  ])('denies %s', line => {
    deny(line, PRIVILEGED_HIDDEN)
  })

  // An unread -c value is a config bypass in its own right, so that reason fires first.
  it('keeps the config reason for an unread -c under sudo', () => {
    deny('sudo git -c "$X" push', REASONS.gitConfigUnresolved)
  })

  it.each(['sudo git $X', 'sudo git "$X"', 'sudo git -C /x $X'])(
    'denies a git under sudo whose subcommand it cannot read: %s',
    line => {
      deny(line, REASONS.privilegedPush)
    },
  )
})

describe('the bypass guard leaves commands beside or without sudo alone', () => {
  it.each([
    'sudo apt-get update',
    'sudo git status',
    'sudo git log -1',
    'git push origin main',
    'sudo ls; git push origin main',
    'sudo ls && gh pr list',
    'echo "sudo git push"',
    'sudo $EDITOR /etc/hosts',
    'sudo git --version',
    'sudo git',
    "echo 'sudo $(echo git push)'",
  ])('allows %s', line => {
    expect(checkCommand(line, ctx())).toBeUndefined()
  })
})
