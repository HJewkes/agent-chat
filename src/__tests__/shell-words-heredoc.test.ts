import { describe, expect, it } from 'vitest'
import { expansionRisk, parseShell, type SimpleCommand } from '../leak-guard/shell-words.js'

// bash and zsh expand $( ), backticks and (bash 5.3) funsubs in an unquoted heredoc's body (CC-1341).
const find = (src: string, head: string): SimpleCommand | undefined =>
  parseShell(src).find(cmd => cmd.words[0] === head)

const LIVE_BODIES = [
  'cat <<E\n$(git push --no-verify)\nE',
  'cat <<E\n`git push --no-verify`\nE',
  'cat <<E\n${ git push --no-verify;}\nE',
  'cat <<E\n${|git push --no-verify;}\nE',
  'cat <<-E\n\t$(git push --no-verify)\n\tE',
  'cat 3<<E\n$(git push --no-verify)\nE',
  '<<E\n$(git push --no-verify)\nE',
  'cat <<E\n$(git pu\\\nsh --no-verify)\nE',
  'cat <<E\n\\\\$(git push --no-verify)\nE',
  'cat <<E\n"$(git push --no-verify)"\nE',
  'echo "$(cat <<E\n$(git push --no-verify)\nE\n)"',
]

const LITERAL_BODIES = [
  "cat <<'E'\n$(git push --no-verify)\nE",
  'cat <<"E"\n$(git push --no-verify)\nE',
  'cat <<\\E\n$(git push --no-verify)\nE',
  "cat <<E''\n$(git push --no-verify)\nE",
  "cat <<'E'\n`git push --no-verify`\nE",
  'cat <<E\n\\$(git push --no-verify)\nE',
  'cat <<E\n\\`git push --no-verify\\`\nE',
]

describe('substitutions in an unquoted heredoc body', () => {
  it.each(LIVE_BODIES)('%j holds the push as a nested command', src => {
    const push = find(src, 'git')

    expect(push?.words).toEqual(['git', 'push', '--no-verify'])
    expect(push?.nested).toBe(true)
  })

  it.each(LITERAL_BODIES)('%j keeps the body as text', src => {
    expect(parseShell(src).map(cmd => cmd.words[0])).toEqual(['cat'])
  })

  it('reads a default-value expansion in the body as unreadable', () => {
    expect(expansionRisk('cat <<E\n${X:-$(git push --no-verify)}\nE')).toBe('unreadable')
  })

  // Quotes are text in a heredoc body, so this over-denies; it errs toward denying on purpose.
  it('reads a quoted default value in the body as unreadable', () => {
    expect(expansionRisk("cat <<E > f\n${X:-'a'}\nE")).toBe('unreadable')
  })

  it('still reads the command after the heredoc as a top-level command', () => {
    const status = find('cat <<E\n$(date)\nE\ngit status', 'git')

    expect(status?.words).toEqual(['git', 'status'])
    expect(status?.nested).toBe(false)
  })

  it('keeps an arithmetic body on the heredoc command', () => {
    const cat = find('cat <<E\n$((1 + 2))\nE', 'cat')

    expect(cat?.arithBodies).toEqual(['1 + 2'])
  })
})
