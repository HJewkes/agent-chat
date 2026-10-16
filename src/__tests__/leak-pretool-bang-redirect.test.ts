import { parseTerms } from '@titan-design/egress-scan'
import { describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import { expansionRisk, parseReadings } from '../leak-guard/shell-words.js'

const ctx: GuardContext = {
  terms: { kind: 'ok', rules: parseTerms('zq7privateseat\n') },
  cwd: '/work',
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
}

// zsh 5.9 reads `>!` (and `>>!`, `>&!`, `&>!`, `&>>!`, `>>&!`) as one clobbering operator; bash 5.2
// reads `>` and a target that starts with `!`. `printf '%s|' >! s A B` writes `A|B|` to s in zsh and
// `s|A|B|` to `!` in bash. Each line below runs `git push --no-verify` in one shell or both (CC-1340).
const BANGS = ['>!', '>>!', '>&!', '&>!', '&>>!', '>>&!']

describe('a zsh clobbering redirect that bash reads differently', () => {
  it.each(
    BANGS.flatMap(op => [
      `git ${op} s push --no-verify`,
      `git ${op}s push --no-verify`,
      `${op} s git push --no-verify`,
      `${op}s git push --no-verify`,
      `git push ${op} s --no-verify`,
      `echo $(git ${op} s push --no-verify)`,
    ]),
  )('denies %j, which zsh runs as git push --no-verify', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.noVerify)
  })

  it.each(['>! git push --no-verify', '>>! git push --no-verify', '&>! git push --no-verify'])(
    'denies %j, which only bash runs as git push --no-verify',
    command => {
      expect(checkCommand(command, ctx)).toBe(REASONS.noVerify)
    },
  )

  // Both shells read the `!` after `>|` and `<>` as the start of the target.
  it.each(['>|! git push --no-verify', '<>! git push --no-verify'])('denies %j', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.noVerify)
  })

  it.each(['echo hi >! out.txt', 'git status >! out.txt', 'git >! s status'])('allows %j', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})

describe('the bash reading of a line', () => {
  it('is a second reading only where the shells disagree', () => {
    expect(parseReadings('git >! s push').map(cmds => cmds.map(cmd => cmd.words))).toEqual([
      [['git', 'push']],
      [['git', 's', 'push']],
    ])
    expect(parseReadings('git >| s push')).toHaveLength(1)
  })

  it('reads the line unreadable when the forks are spent before it', () => {
    const groups = Array.from({ length: 70 }, () => '(a)').join(' ')
    expect(expansionRisk(`echo ${groups} > s`)).toBeUndefined()
    expect(expansionRisk(`echo ${groups} >! s`)).toBe('unreadable')
    expect(expansionRisk(`echo (a) >! s`)).toBeUndefined()
  })
})
