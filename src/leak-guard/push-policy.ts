/**
 * The `no-rewrite` push policy (CC-1633): for a profile that opts in, a `git push` may not delete,
 * force, mirror or prune, and may not update main or master. It is decided on the argv the shell
 * builds, so `git "push" origin --delete x` and `git push>f origin --delete x` read as written.
 * The policy comes from the hook's own environment, which the launch sets from the profile and an
 * agent's `export` never reaches.
 */

export const PUSH_POLICY_ENV = 'AGENT_CHAT_PUSH_POLICY'
export const NO_REWRITE = 'no-rewrite'

/** Long options git may read from any unique prefix; `--all` and `--branches` push main with every other branch. */
const REWRITING_LONG = [
  'delete',
  'force',
  'force-with-lease',
  'force-if-includes',
  'mirror',
  'prune',
  'all',
  'branches',
]
const REWRITING_SHORT = new Set(['d', 'f'])
// `git push -h` on git 2.53: the long options that take the next word as their value.
const VALUE_LONG = ['repo', 'recurse-submodules', 'receive-pack', 'exec', 'push-option']
const PROTECTED_BRANCHES = new Set(['main', 'master'])

/** A long option word, `--name` or `--name=value`, that is or abbreviates a rewriting option. */
function rewritingLong(word: string): boolean {
  const name = word.slice(2).split('=')[0] as string
  if (name.startsWith('no-')) return false
  return REWRITING_LONG.some(option => option.startsWith(name))
}

/** A short cluster such as `-fu`; the letters after `o` are its value, not options. */
function shortCluster(word: string): { rewrites: boolean; takesNext: boolean } {
  const letters = word.slice(1)
  const valueAt = letters.indexOf('o')
  const options = valueAt < 0 ? letters : letters.slice(0, valueAt)
  const rewrites = [...options].some(letter => REWRITING_SHORT.has(letter))
  return { rewrites, takesNext: valueAt === letters.length - 1 }
}

const longTakesNext = (word: string): boolean =>
  !word.includes('=') && VALUE_LONG.some(option => option.startsWith(word.slice(2)))

/** The branch a destination names, read the way git matches `main`, `heads/main` and `refs/heads/main`. */
const branchOf = (ref: string): string => ref.replace(/^refs\//, '').replace(/^heads\//, '')

/** A refspec that force-updates (`+`), deletes (`:x`), or lands on main or master. */
function rewritingRefspec(word: string): boolean {
  if (word.startsWith('+') || word.startsWith(':')) return true
  const colon = word.indexOf(':')
  const destination = colon < 0 ? word : word.slice(colon + 1)
  return PROTECTED_BRANCHES.has(branchOf(destination))
}

/** Whether one option word rewrites, and whether git reads the word after it as its value. */
function readOption(word: string): { rewrites: boolean; takesNext: boolean } {
  if (word.startsWith('--')) return { rewrites: rewritingLong(word), takesNext: longTakesNext(word) }
  return shortCluster(word)
}

/**
 * Whether the words after `push` break the policy. `words[i]` is the word as the shell expands it,
 * or undefined where the guard cannot tell, which fails closed. A literal `--` ends the options;
 * every later word is still a repository or refspec.
 */
export function breaksNoRewrite(words: readonly (string | undefined)[]): boolean {
  let options = true
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word === undefined) return true
    if (options && word === '--') {
      options = false
      continue
    }
    if (!options || !word.startsWith('-') || word === '-') {
      if (rewritingRefspec(word)) return true
      continue
    }
    const option = readOption(word)
    if (option.rewrites) return true
    if (option.takesNext) i++
  }
  return false
}

/** Whether the hook's environment opts this agent into the policy. */
export const noRewriteOn = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env[PUSH_POLICY_ENV] === NO_REWRITE
