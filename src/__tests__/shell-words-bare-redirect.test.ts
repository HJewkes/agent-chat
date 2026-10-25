import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseTerms } from '@titan-design/egress-scan'
import { describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import { parseShell, unmark } from '../leak-guard/shell-words.js'

const HOOKS = '.agent-chat/git-hooks'

const ctx: GuardContext = {
  terms: { kind: 'ok', rules: parseTerms('zq7privateseat\n') },
  cwd: '/work',
  env: { PATH: '/usr/bin:/bin' },
  protectedPaths: [HOOKS],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
}

const segments = (line: string) =>
  parseShell(line).map(({ words, writes }) => ({ words, writes: writes.map(unmark) }))

describe('a redirect-only command writes where it stands (TP-4250)', () => {
  it.each([
    ['< /tmp/rc >> ~/.zshenv', [{ words: [')'], writes: ['~/.zshenv'] }]],
    [
      'echo hi; < /tmp/rc >> ~/.zshenv',
      [
        { words: ['echo', 'hi'], writes: [] },
        { words: [')'], writes: ['~/.zshenv'] },
      ],
    ],
    ['>> ~/.zshenv < /tmp/rc', [{ words: [')'], writes: ['~/.zshenv'] }]],
    [`< /tmp/x > ~/${HOOKS}/pre-push`, [{ words: [')'], writes: [`~/${HOOKS}/pre-push`] }]],
    [
      'true; < f >> x; git status',
      [
        { words: ['true'], writes: [] },
        { words: [')'], writes: ['x'] },
        { words: ['git', 'status'], writes: [] },
      ],
    ],
  ])('reads %j with the write on its own segment', (line, expected) => {
    expect(segments(line)).toEqual(expected)
  })

  it('denies a bare redirect into the hooks dir', () => {
    expect(checkCommand(`< /tmp/x > ~/${HOOKS}/pre-push`, ctx)).toBe(REASONS.protectedPath)
  })

  it.each([
    'P=/w/b.md; : $(< /tmp/rc > "$P"); gh pr create -t x --body-file /w/b.md',
    'P=/w/b.md; echo `< /tmp/rc > "$P"`; gh pr create -t x --body-file /w/b.md',
  ])('denies a body file a bare redirect in a substitution writes: %s', line => {
    expect(checkCommand(line, ctx)).toBe(REASONS.writtenBody)
  })
})

const REAL_SHELLS = [
  ['zsh', '/bin/zsh', ['-f']],
  ['bash', '/bin/bash', ['--noprofile', '--norc']],
] as const

/** The text the shell leaves in `x` after running `line` in a scratch dir holding `f`, where git is a no-op. */
function writtenX(shell: string, flags: readonly string[], line: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp4250-'))
  try {
    fs.writeFileSync(path.join(dir, 'f'), 'synthetic rc\n')
    const env = { PATH: '/usr/bin:/bin' }
    execFileSync(shell, [...flags, '-c', `git(){ :; }\n${line}`], { cwd: dir, env, stdio: 'ignore' })
    return fs.readFileSync(path.join(dir, 'x'), 'utf8')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('a redirect-only command against real shells (TP-4250)', () => {
  const ZSH_COPIES = { zsh: 'synthetic rc\n', bash: '' }
  for (const [name, shell, flags] of REAL_SHELLS) {
    it.skipIf(!fs.existsSync(shell)).each(['< f >> x', 'true; < f >> x; git status', '>> x < f'])(
      `${name} writes x from the bare redirect itself: %s`,
      line => {
        expect(writtenX(shell, flags, line)).toBe(ZSH_COPIES[name])
        expect(segments(line).find(cmd => cmd.writes.includes('x'))?.words).toEqual([')'])
      },
    )
  }
})
