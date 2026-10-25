import { parseTerms } from '@titan-design/egress-scan'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')

const ctx: GuardContext = {
  terms: { kind: 'ok', rules: parseTerms('zq7privateseat\n') },
  cwd: '/work',
  env: {},
  protectedPaths: ['titan-egress/private-terms', '.agent-chat/git-hooks'],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
}

describe('git config writes that persist a program value a later git runs (TP-4240)', () => {
  it.each([
    "git config core.pager '$X'",
    "git config --global core.sshCommand 'ssh $X'",
    "git config core.editor '`x`'",
    "git config diff.external '$(x)'",
    "git config credential.helper '!$X'",
    "git config alias.p '!$X'",
    "git config set --global core.pager '$X'",
    "git -C /w config --add core.fsmonitor '${X}'",
    "git config --file f core.pager '$X'",
  ])('denies shellExpansion for %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.shellExpansion)
  })

  it.each([
    'git config core.pager "$X"',
    'git config alias.p "!$X"',
    'git config core.sshCommand "$(x)"',
    'git config rename-section user core',
  ])('denies configProgramWrite for %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.configProgramWrite)
  })

  it.each(['git config "$K" less', 'git config rename-section user "$S"'])(
    'keeps denying an unread key or section for %s',
    command => {
      expect(checkCommand(command, ctx)).toBe(REASONS.remoteUrlUnresolved)
    },
  )

  it.each([
    'git config user.name x',
    'git config user.name "$NAME"',
    'git config core.pager less',
    "git config core.pager 'less -R'",
    "git config alias.st 'status -s'",
    'git config --get core.pager',
    'git config --unset core.pager',
    'git config rename-section alias.a alias.b',
    'git config rename-section core core2',
  ])('allows %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })

  it('denies a stored alias that skips the hook, even with no use on the line', () => {
    expect(checkCommand(`git config alias.pnvw '!git push --no-ve""rify'`, ctx)).toBe(REASONS.noVerify)
  })

  it('denies a persisted pager with an expansion from the built CLI', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-config-programs-'))
    const input = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: "git config core.pager '$X'" },
      cwd: '/work',
      session_id: 's',
    })

    const out = execFileSync(process.execPath, [CLI, 'leak-guard', 'pretool'], {
      input,
      env: { PATH: process.env.PATH ?? '', HOME: scratch, XDG_CONFIG_HOME: path.join(scratch, 'none') },
      encoding: 'utf8',
    })
    fs.rmSync(scratch, { recursive: true })

    expect(JSON.parse(out).hookSpecificOutput.permissionDecisionReason).toBe(REASONS.shellExpansion)
  })
})
