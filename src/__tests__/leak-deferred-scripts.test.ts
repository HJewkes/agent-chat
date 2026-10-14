import { describe, expect, it } from 'vitest'
import { aliasDefinitions, streamScript, trapActions } from '../leak-guard/deferred-scripts.js'
import { LIVE, parseShell, type SimpleCommand } from '../leak-guard/shell-words.js'

// Text a trap, an alias or a streamed script runs later than its own line (CC-1334).
const commandOf = (line: string, head: string): SimpleCommand => {
  const found = parseShell(line).find(cmd => cmd.words[0] === head)
  if (found === undefined) throw new Error(`no ${head} in ${line}`)
  return found
}

const wordsOf = (line: string): string[] => commandOf(line, line.split(' ')[0] ?? '').words
const markedOf = (line: string): string[] => commandOf(line, line.split(' ')[0] ?? '').marked

describe('trapActions', () => {
  it.each([
    ["trap 'git push --no-verify' EXIT", ['git push --no-verify']],
    ["trap -- 'a' EXIT", ['a']],
    ["trap 'a' 0 1", ['a']],
    ["trap 'a' DEBUG", ['a']],
    ["trap 'a' ERR RETURN", ['a']],
    ["trap 'g''it push' EXIT", ['git push']],
    ["trap 'a' 0", ['a']],
  ])('%s sets %j', (line, actions) => {
    expect(trapActions(wordsOf(line))).toEqual(actions)
  })

  it.each([
    'trap -p',
    'trap -p EXIT',
    'trap -l',
    'trap -P INT',
    'trap',
    'trap - EXIT',
    'trap -- - EXIT INT',
    "trap '' INT",
    'trap EXIT',
    'trap SIGINT',
  ])('%s sets no action', line => {
    expect(trapActions(wordsOf(line))).toEqual([])
  })

  it('returns every operand when the first is one the shell expands', () => {
    expect(trapActions(markedOf('trap "$X" EXIT'))).toEqual([`${LIVE}$X`, 'EXIT'])
  })

  it('reads only a trap command', () => {
    expect(trapActions(wordsOf("echo 'a' EXIT"))).toEqual([])
  })
})

describe('aliasDefinitions', () => {
  const plain = { global: false, suffix: false, blank: false }

  it.each([
    ["alias x='g''it push --no-verify'", [{ ...plain, name: 'x', value: 'git push --no-verify' }]],
    ['alias -g X=push', [{ ...plain, name: 'X', value: 'push', global: true }]],
    ["alias -s txt='git push'", [{ ...plain, name: 'txt', value: 'git push', suffix: true }]],
    ["alias x='gizmo '", [{ ...plain, name: 'x', value: 'gizmo ', blank: true }]],
    ['alias -- -x=y', [{ ...plain, name: '-x', value: 'y' }]],
    ['alias +g x=y', [{ ...plain, name: 'x', value: 'y' }]],
    ['alias -p ll=ls', [{ ...plain, name: 'll', value: 'ls' }]],
    ["alias ll='ls -la' lt", [{ ...plain, name: 'll', value: 'ls -la' }]],
    [
      'alias a=b c=d',
      [
        { ...plain, name: 'a', value: 'b' },
        { ...plain, name: 'c', value: 'd' },
      ],
    ],
  ])('%s defines %j', (line, definitions) => {
    expect(aliasDefinitions(wordsOf(line))).toEqual(definitions)
  })

  it.each(['alias', 'alias ll', 'alias -g', 'unalias x', 'alias -L'])('%s defines nothing', line => {
    expect(aliasDefinitions(wordsOf(line))).toEqual([])
  })

  it('marks a definition global and suffix after a first operand the shell expands', () => {
    const [definition] = aliasDefinitions(markedOf('alias $G X=push'))
    expect(definition).toMatchObject({ name: 'X', value: 'push', global: true, suffix: true })
  })

  it('keeps the mark on a value the shell expands', () => {
    expect(aliasDefinitions(markedOf('alias x="$P"'))).toEqual([{ ...plain, name: 'x', value: `${LIVE}$P` }])
  })
})

describe('streamScript', () => {
  it.each([
    ['. <(echo P)', '.'],
    ['source <(echo P)', 'source'],
    ['source =(echo P)', 'source'],
    ['bash <(echo P)', 'bash'],
    ['bash -x <(echo P) arg', 'bash'],
    ['zsh <(echo P)', 'zsh'],
    ['. /dev/stdin', '.'],
    ['source /dev/fd/0', 'source'],
    ['. /dev/fd/3', '.'],
    ['. /dev//fd/3', '.'],
    ['. /proc/self/fd/0', '.'],
    ['. /dev/fd/$n', '.'],
    ['bash -', 'bash'],
    ['diff <(a) <(b)', 'diff'],
  ])('%s reads a stream', (line, head) => {
    expect(streamScript(commandOf(line, head))).toBe(true)
  })

  it.each([
    ['. ~/.venv/bin/activate', '.'],
    ['source a=(x)', 'source'],
    ['. "<(x)"', '.'],
    ['bash script.sh', 'bash'],
    ['bash', 'bash'],
    ['. /dev/null', '.'],
    ["echo ''", 'echo'],
  ])('%s reads a file', (line, head) => {
    expect(streamScript(commandOf(line, head))).toBe(false)
  })
})
