import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

/**
 * A push hidden in a nested escaped backtick is denied (CC-1350), and real shells with a fake
 * `git` first on PATH confirm the property: whenever the guard allows, no shell ran git.
 */

const ctx = (): GuardContext => ({
  terms: { kind: 'ok', rules: [] },
  cwd: '/work',
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
})

const PUSH = 'git push --no-verify'

// On main every row here was allowed. Reverting backtick() to until('`') allows them all again.
const LIVE = [
  `echo \`\\\`${PUSH}\\\`\``,
  `echo \`echo \\\`${PUSH}\\\`\``,
  `echo "\`\\\`${PUSH}\\\`\`"`,
  `x=\`\\\`git push origin main --no-verify\\\`\``,
  // Fails when backtickBody unescapes only the backtick and not `\\`.
  `echo \`echo \\\`echo \\\\\\\`${PUSH}\\\\\\\`\\\`\``,
  `echo $(( \`echo \\\`${PUSH}\\\`\` ))`,
  `echo "\`echo \\"\\\`${PUSH}\\\`\\"\`"`,
  `echo \`echo \\x\\\`${PUSH}\\\`\``,
  `cat <<E\n\`echo \\\`${PUSH}\\\`\`\nE`,
]

// Fails when backtickEnd stops at an escaped backtick: the body is then cut and unescaped wrongly.
const LITERAL = [`echo \`echo \\\\\\\`${PUSH}\\\\\\\`\``, `echo \`echo '\\\`${PUSH}\\\`'\``]

describe('checkCommand on nested escaped backticks', () => {
  it.each(LIVE)('denies %j', src => {
    expect(checkCommand(src, ctx())).toBe(REASONS.noVerify)
  })

  it.each(LITERAL)('allows %j', src => {
    expect(checkCommand(src, ctx())).toBeUndefined()
  })
})

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-pretool-backtick-')))
const BIN = path.join(ROOT, 'bin')
const RECORD = path.join(ROOT, 'git-calls')
const ENV = { PATH: `${BIN}:/usr/bin:/bin`, HOME: ROOT, RECORD }

fs.mkdirSync(BIN)
fs.writeFileSync(path.join(BIN, 'git'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RECORD"\n', { mode: 0o755 })

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const SHELLS: [string, string[]][] = (
  [
    ['/bin/bash', ['--noprofile', '--norc']],
    ['/bin/zsh', ['-f']],
  ] satisfies [string, string[]][]
).filter(([shell]) => fs.existsSync(shell))

/** Whether `shell -c src` ran the fake git. */
function runsGit(shell: string, args: string[], src: string): boolean {
  fs.rmSync(RECORD, { force: true })
  try {
    execFileSync(shell, [...args, '-c', src], { env: ENV, cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] })
  } catch {
    // A failing line still counts by what it ran.
  }
  return fs.existsSync(RECORD)
}

describe.skipIf(SHELLS.length === 0)('real shells agree with the guard on nested backticks', () => {
  it('finds the fake git first on PATH', () => {
    expect(execFileSync('/bin/sh', ['-c', 'command -v git'], { env: ENV }).toString().trim()).toBe(
      path.join(BIN, 'git'),
    )
  })

  it.each(LIVE)('every shell runs the push in %j', src => {
    expect(SHELLS.filter(([shell, args]) => !runsGit(shell, args, src)).map(([shell]) => shell)).toEqual([])
  })

  it.each(LITERAL)('no shell runs git for %j', src => {
    expect(SHELLS.filter(([shell, args]) => runsGit(shell, args, src)).map(([shell]) => shell)).toEqual([])
  })

  it.each([...LIVE, ...LITERAL])('no shell runs git where the guard allows %j', src => {
    const allowed = checkCommand(src, ctx()) === undefined
    const ran = SHELLS.filter(([shell, args]) => runsGit(shell, args, src)).map(([shell]) => shell)

    expect(allowed && ran.length > 0 ? ran : []).toEqual([])
  })
})
