import { parseTerms } from '@titan-design/egress-scan'
import { describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

const ctx: GuardContext = {
  terms: { kind: 'ok', rules: parseTerms('zq7privateseat\n') },
  cwd: '/work',
  env: {},
  protectedPaths: ['titan-egress/private-terms', '.agent-chat/git-hooks'],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
}

describe('ssh options that run a local program (TP-2376)', () => {
  it.each([
    "ssh -oProxyCommand='git push --no-verify' x",
    'command ssh -oProxyCommand=x h',
    '/usr/bin/ssh -F ./c h',
    'env ssh -o "$O" h',
    'scp -S ./p a h:b',
    'sftp -D /x h',
    'GIT_SSH_COMMAND="ssh -oProxyCommand=nc" git fetch',
    "git -c core.sshCommand='ssh -o ProxyCommand=nc' fetch",
    "bash -c 'ssh -oLocalCommand=x h'",
  ])('denies %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.sshProgram)
  })

  it.each([
    'ssh -J j h uptime',
    'ssh -F /dev/null h',
    'scp a h:b',
    "GIT_SSH_COMMAND='ssh -o BatchMode=yes' git fetch",
  ])('allows %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})

describe('shell startup, exec path and template env on a line that may reach git or gh (TP-2376)', () => {
  it.each([
    'BASH_ENV=/tmp/rc bash -c "gh zz"',
    'BASH_ENV=/tmp/rc bash -c "gh pr list"',
    'export BASH_ENV=/tmp/rc; git push',
    "ZDOTDIR=/tmp/z zsh -c 'git status'",
    "ENV=/tmp/e sh -c 'gh pr list'",
    'env BASH_ENV=/x git push',
    ': ${BASH_ENV:=/x}; git push',
    'env -S "BASH_ENV=/x git push"',
  ])('denies shellStartupEnv: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.shellStartupEnv)
  })

  it('denies gitExecPath for GIT_EXEC_PATH=/tmp/x git push', () => {
    expect(checkCommand('GIT_EXEC_PATH=/tmp/x git push', ctx)).toBe(REASONS.gitExecPath)
  })

  it('denies templateDir for an exported GIT_TEMPLATE_DIR before git init', () => {
    expect(checkCommand('export GIT_TEMPLATE_DIR=/t; git init r', ctx)).toBe(REASONS.templateDir)
  })

  it.each([
    'echo "$BASH_ENV"; git status',
    'unset BASH_ENV; git push',
    'BASH_ENV=/tmp/rc make',
    "git commit -m 'drop BASH_ENV'",
  ])('allows %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})
