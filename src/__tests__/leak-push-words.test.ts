import { describe, expect, it } from 'vitest'
import { NO_VERIFY, pushWordRisk } from '../leak-guard/push-words.js'
import { LIVE, parseShell } from '../leak-guard/shell-words.js'

/** Push's risk on a parsed line; a word resolves to itself unless it holds an expansion or `values` names it. */
function riskOf(line: string, values: Record<number, string> = {}) {
  const cmd = parseShell(line).find(parsed => parsed.words[0] === 'git')
  const marked = cmd!.marked.slice(1)
  const resolved = marked.map((word, i) => values[i] ?? (word.includes(LIVE) ? undefined : word))
  return pushWordRisk(resolved, marked, cmd!.splits, marked.indexOf('push'))
}

describe('a git push word that is or may become --no-verify (CC-1285)', () => {
  it.each(['git push origin --no-verify', 'git push origin --no-veri', 'git push origin --no-verif'])(
    'flags %s',
    line => {
      expect(riskOf(line)).toBe('flag')
    },
  )

  it('flags a word the caller resolved to the flag', () => {
    expect(riskOf('git push origin $NV', { 2: '--no-verify' })).toBe('flag')
  })

  it.each([
    'git push origin $V',
    'git push origin main$V',
    'git push origin "$V"',
    'git push origin "${V}verify"',
    'git push origin "--$X"',
    'git push origin "-$X"',
    'git push origin "--no-$X"',
    'git push origin "$(echo x)"',
    'git push origin "$1"',
    'git push origin $*',
    'git push -o "$X" origin main',
    'git push origin "$D" "$V"',
  ])('cannot read %s', line => {
    expect(riskOf(line)).toBe('unreadable')
  })

  it.each([
    'git push origin main',
    'git push -u origin HEAD',
    'git push origin "HEAD:$B"',
    'git push origin "origin/$B"',
    'git push "--push-option=$X" origin main',
    'git push origin -- "$V"',
    'git push origin -- $V',
    'git push -u -- origin "$B"',
  ])('allows %s', line => {
    expect(riskOf(line)).toBeUndefined()
  })

  it('allows a word the caller resolved to something else', () => {
    expect(riskOf('git push origin $B', { 2: 'main' })).toBeUndefined()
  })

  it('reads only the words after push', () => {
    expect(riskOf('git -c x.y=--no-verify push origin main')).toBeUndefined()
  })

  it('keeps the guard spellings of the flag', () => {
    expect(['--no-verify', '--no-verif', '--no-veri'].every(word => NO_VERIFY.test(word))).toBe(true)
    expect(['--no-ver', '--no-verifyx', '-no-verify'].some(word => NO_VERIFY.test(word))).toBe(false)
  })
})
