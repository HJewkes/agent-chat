import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTerms } from '@titan-design/egress-scan'
import { describe, expect, it } from 'vitest'
import { checkCommand, type GuardContext, REASONS } from '../leak-guard/pretool.js'

// bash 5.3 runs `${ cmd;}` and `${|cmd;}` as commands in the current shell (CC-1327).
const ctx = (): GuardContext => ({
  terms: { kind: 'ok', rules: parseTerms('zq7privateseat\n') },
  cwd: '/work',
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
})

const G = 'git push --no-verify'

const bashVersion = (): [number, number] => {
  try {
    const v = execFileSync('bash', ['-c', 'echo ${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}'], {
      encoding: 'utf8',
    })
    const [major = 0, minor = 0] = v.trim().split(' ').map(Number)
    return [major, minor]
  } catch {
    return [0, 0]
  }
}
const [major, minor] = bashVersion()
const bashRunsFunsub = major > 5 || (major === 5 && minor >= 3)

describe('a funsub that pushes with --no-verify', () => {
  it.each([
    `echo \${ ${G};}`,
    `echo \${|${G};}`,
    `echo "\${ ${G};}"`,
    `echo "\${|${G};}"`,
    `echo \${\t${G};}`,
    `echo \${\n${G};}`,
    `echo "\${\t${G};}"`,
    `x=\${ ${G};}`,
    `x=\${|${G};}`,
    `bash -c 'echo \${ ${G};}'`,
    `bash -c 'echo "\${|${G};}"'`,
    `zsh -c 'echo \${ ${G};}'`,
    `zsh -c 'echo \${|${G};}'`,
    `echo $(echo \${ ${G};})`,
    `echo \${ cd /elsewhere;}; ${G}`,
  ])('is refused as a no-verify push: %j', line => {
    expect(checkCommand(line, ctx())).toBe(REASONS.noVerify)
  })
})

describe('a funsub the guard cannot close', () => {
  it.each(['echo ${ git push', 'echo ${ git push origin main', 'echo ${ echo }; git push origin main; }'])(
    'is denied as unreadable: %j',
    line => {
      expect(checkCommand(line, ctx())).toBe(REASONS.operatorExpansion)
    },
  )
})

describe('a funsub without git', () => {
  it.each(['echo ${ date;}', 'echo "${|REPLY=x;}"', "git commit -m 'uses ${ cmd;}'"])(
    'is allowed: %j',
    line => {
      expect(checkCommand(line, ctx())).toBeUndefined()
    },
  )
})

describe.skipIf(!bashRunsFunsub)('bash 5.3', () => {
  it('runs the body of a funsub as a command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'funsub-'))
    try {
      execFileSync('bash', ['-c', 'echo ${ touch M;} >/dev/null'], { cwd: dir })
      expect(existsSync(join(dir, 'M'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
