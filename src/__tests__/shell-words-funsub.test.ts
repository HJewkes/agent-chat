import { describe, expect, it } from 'vitest'
import { expansionRisk, parseShell, type SimpleCommand } from '../leak-guard/shell-words.js'

// bash 5.3 runs `${ cmd;}` and `${|cmd;}` in the current shell (CC-1327).
const find = (src: string, head: string): SimpleCommand | undefined =>
  parseShell(src).find(cmd => cmd.words[0] === head)

describe('bash 5.3 funsub bodies read as commands', () => {
  it.each([
    'echo ${ git push --no-verify;}',
    'echo ${|git push --no-verify;}',
    'echo "${ git push --no-verify;}"',
    'echo "${|git push --no-verify;}"',
    'echo ${\tgit push --no-verify;}',
    'echo ${\ngit push --no-verify;}',
    'x=${ git push --no-verify;}',
    'echo ${ git push --no-verify;}x',
    'echo $(echo ${ git push --no-verify;})',
  ])('%j holds the push as a nested command', src => {
    const push = find(src, 'git')

    expect(push?.words).toEqual(['git', 'push', '--no-verify'])
    expect(push?.nested).toBe(true)
    expect(expansionRisk(src)).toBeUndefined()
  })

  it('closes only at a } in command position, and a bare } argument is unreadable', () => {
    const src = 'echo ${ echo }; git push --no-verify; }'

    expect(find(src, 'echo')?.words).toEqual(['echo', '}'])
    expect(find(src, 'git')?.words).toEqual(['git', 'push', '--no-verify'])
    expect(expansionRisk(src)).toBe('unreadable')
  })

  it('counts a nested { } group before closing', () => {
    const src = 'echo ${ { git status; }; git push --no-verify; }'

    expect(find(src, '{')?.words).toEqual(['{', 'git', 'status'])
    expect(find(src, 'git')?.words).toEqual(['git', 'push', '--no-verify'])
    expect(expansionRisk(src)).toBeUndefined()
  })

  it.each(['echo ${ git push --no-verify', 'echo ${ a ) ; }'])(
    '%j has no close, so it is unreadable',
    src => {
      expect(expansionRisk(src)).toBe('unreadable')
    },
  )

  it('goes on reading the outer command after the close', () => {
    const src = 'echo ${ date;} tail'

    const commands = parseShell(src)

    expect(commands.map(cmd => cmd.words[0])).toEqual(['date', 'echo'])
    expect(commands[1]?.words).toEqual(['echo', '${ date;}', 'tail'])
    expect(commands[1]?.splits).toHaveLength(1)
    expect(expansionRisk(src)).toBeUndefined()
  })
})

describe('other ${...} forms are unchanged', () => {
  it.each([
    ['echo ${X:-y}', 'operator'],
    ['echo ${(e)x}', 'unreadable'],
    ['echo ${HOME}', undefined],
  ])('%j stays %j', (src, risk) => {
    expect(expansionRisk(src)).toBe(risk)
  })
})
